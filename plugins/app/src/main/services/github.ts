import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Service } from "@zenbujs/core/runtime"
import {
  RpcService,
} from "@zenbujs/core/services"
import { resolveSmallModel } from "../lib/resolve-small-model"
import { complete, type Context } from "@earendil-works/pi-ai"

const execFileP = promisify(execFile)

const MAX_BUFFER = 64 * 1024 * 1024
/** Cap how much patch we feed the model. Anything bigger than this is
 *  already too large for a useful summary and just burns tokens. */
const MAX_AI_DIFF_BYTES = 60_000
const MAX_AI_DIFF_LINES = 1500
/** Cap how much patch we feed `gh` for a PR body fallback. PR bodies
 *  are not the place to dump a 500kb patch. */
const MAX_GENERATED_BODY_BYTES = 16_000

export type GhCommit = {
  sha: string
  shortSha: string
  subject: string
  body: string
  authorName: string
  authorDate: number
}

export type GhRepoInfo = {
  owner: string
  name: string
  defaultBranch: string
  currentBranch: string | null
  hasOrigin: boolean
  /** Whether the current branch has a remote tracking branch. */
  hasUpstream: boolean
  ahead: number
  behind: number
}

export type PrSummary = {
  number: number
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  url: string
  author: string
  headRefName: string
  baseRefName: string
  createdAt: string
  updatedAt: string
}

/** GitHub user assignable to a PR (assignees + collaborators). */
export type GhUser = {
  login: string
  name: string | null
}

/** Lightweight issue summary for the `#issue` typeahead. */
export type GhIssue = {
  number: number
  title: string
  state: "OPEN" | "CLOSED"
}

export type PrDetails = PrSummary & {
  body: string
  additions: number
  deletions: number
  changedFiles: number
  commits: Array<{
    sha: string
    shortSha: string
    subject: string
    authorName: string
    authorDate: number
  }>
  /** Reviewer logins requested on the PR. */
  reviewers: string[]
  /** Comments count. */
  comments: number
}

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

/**
 * Wraps the local `gh` CLI + a small amount of git plumbing to power
 * the in-app "create pull request" surface and the PR list/detail
 * pages. Designed to be a *thin* shell around `gh`: anything that
 * `gh` already does well (auth, formatting, opening URLs) we just
 * shell out. We add value on three fronts:
 *
 *   - Surface every shell error as `{ ok: false, error }` so the
 *     renderer can render it inline (no uncaught promise toasts).
 *   - Stitch together a "PR draft" view: current branch + commits
 *     ahead of base + uncommitted change summary + suggested title.
 *   - Optional AI-generated commit messages via the shared small-model
 *     resolver, so a user can stage and commit pending changes from
 *     inside the PR view before opening the PR itself.
 */
export class GithubService extends Service.create({
  key: "github",
  deps: {
    // Needed so we can emit `openPullRequestsView` from the RPC
    // method the command palette / chat advice calls when the user
    // runs `/create pr` / `/pr` / `/tree`.
    rpc: RpcService,
  },
}) {
  /**
   * In-memory request cache. Keyed by `"<method>:<JSON args>"`.
   * Entries hold the in-flight `Promise<unknown>` so concurrent
   * callers coalesce onto the same fetch, and an `expiresAt`
   * timestamp that drives a soft TTL per method.
   *
   * TODO(zenbu.js): replace this with the per-service request cache
   * the framework is shipping soon — same coalescing behaviour but
   * with cross-process invalidation and tighter integration with
   * the RPC layer. Once that lands, drop `memoize` and friends in
   * favour of the framework primitive.
   */
  private cache = new Map<
    string,
    { value: Promise<unknown>; expiresAt: number }
  >()

  evaluate() {
    this.setup("register-pull-requests-view", () =>
      this.inject({
        name: "pull-requests",
        modulePath: "src/renderer/views/pull-requests/pull-requests-app.tsx",
        exportName: "PullRequestsApp",
        meta: { kind: "view", label: "Pull Requests" },
      }),
    )
  }

  /**
   * Open the Pull Requests view in the active pane (via
   * `mode: "replace"`, so the tab's history stack records the
   * navigation) and start prefetching the data its initial page
   * needs. Fire-and-forget on the prefetch — it just warms
   * `this.cache` so the view's first reads return instantly.
   *
   * The renderer doesn't have to handle the prefetch result: when
   * the iframe mounts and calls `getRepoInfo({ directory })`,
   * `memoize` finds the in-flight (or already-resolved) promise in
   * the cache and returns it without re-running `gh`.
   */
  async openPullRequestsView(args: {
    mode: "create" | "list" | "detail"
    prNumber?: number | null
    directory?: string | null
    /** How the host should place the view. Defaults to `"new-tab"`,
     * matching the rest of the palette. */
    openMode?: "new-tab" | "split-right" | "replace"
  }): Promise<void> {
    this.ctx.rpc.emit.app.openPullRequestsView({
      mode: args.mode,
      prNumber: args.prNumber ?? null,
      directory: args.directory ?? null,
      openMode: args.openMode ?? "new-tab",
    })
    if (args.directory) {
      // Don't block the RPC return on the prefetch. The view will
      // hit the cache as soon as it mounts.
      void this.prefetchForDirectory({
        directory: args.directory,
        mode: args.mode,
        prNumber: args.prNumber ?? null,
      }).catch(err => {
        // Prefetch failures are non-fatal — the view will surface
        // the same error inline when it makes the actual request.
        console.warn("[github] prefetch failed:", err)
      })
    }
  }

  /**
   * Warm the cache for the most likely first reads from each
   * sub-page. Safe to call multiple times — every read goes
   * through `memoize`, so a second call within the TTL window is
   * essentially free.
   */
  async prefetchForDirectory(args: {
    directory: string
    mode?: "create" | "list" | "detail"
    prNumber?: number | null
  }): Promise<void> {
    const mode = args.mode ?? "create"
    if (mode === "list") {
      void this.listPullRequests({ directory: args.directory, state: "open" }).catch(() => {})
      // Repo info is cheap and the back button might land on the
      // composer, which needs it.
      void this.getRepoInfo({ directory: args.directory }).catch(() => {})
      return
    }
    if (mode === "detail" && args.prNumber != null) {
      void this.getPullRequest({ directory: args.directory, number: args.prNumber }).catch(() => {})
      void this.getPullRequestDiff({ directory: args.directory, number: args.prNumber }).catch(() => {})
      return
    }
    // "create" — by far the most common entry. Kick off everything
    // the composer's initial load needs in parallel.
    void this.getWorkingTreeSummary({ directory: args.directory }).catch(() => {})
    void this.listPullRequests({ directory: args.directory, state: "open" }).catch(() => {})
    const repo = await this.getRepoInfo({ directory: args.directory }).catch(
      () => null,
    )
    if (repo && repo.ok) {
      void this.getBranchCommits({
        directory: args.directory,
        base: repo.defaultBranch,
      }).catch(() => {})
    }
  }

  /**
   * Drop every cached entry for `directory`. Called after mutating
   * RPCs (`commit`, `createPullRequest`, `pushBranch`) so the very
   * next read goes back to `gh`/`git` instead of returning a
   * pre-mutation snapshot.
   */
  invalidateCache(args: { directory: string }): void {
    const needle = JSON.stringify({ directory: args.directory }).slice(1, -1)
    for (const key of this.cache.keys()) {
      if (key.includes(needle)) this.cache.delete(key)
    }
  }

  /** Quick check that `gh` is installed on PATH. */
  async isAvailable(): Promise<{ installed: boolean; version: string | null }> {
    try {
      const { stdout } = await execFileP("gh", ["--version"], {
        maxBuffer: MAX_BUFFER,
      })
      const first = stdout.split("\n")[0]?.trim() ?? ""
      return { installed: true, version: first || null }
    } catch {
      return { installed: false, version: null }
    }
  }

  /**
   * Resolve enough metadata to build the PR-draft header:
   *   - owner / name (from `gh repo view`)
   *   - default branch (the PR's base)
   *   - current branch (HEAD)
   *   - ahead/behind vs upstream
   */
  async getRepoInfo(args: { directory: string }): Promise<Result<GhRepoInfo>> {
    if (!args.directory) {
      return { ok: false, error: "No directory" }
    }
    return this.memoize("getRepoInfo", args, TTL.repoInfo, () =>
      this.getRepoInfoImpl(args),
    )
  }

  private async getRepoInfoImpl(args: {
    directory: string
  }): Promise<Result<GhRepoInfo>> {
    try {
      const repoJson = await runText(
        "gh",
        [
          "repo",
          "view",
          "--json",
          "owner,name,defaultBranchRef,url",
        ],
        args.directory,
      )
      if (repoJson == null) {
        return {
          ok: false,
          error:
            "gh failed — not a GitHub repo, or `gh` not installed / logged in.",
        }
      }
      type RepoView = {
        owner: { login: string }
        name: string
        defaultBranchRef: { name: string }
      }
      const parsed = JSON.parse(repoJson) as RepoView
      const currentBranch = (
        await runGit(["rev-parse", "--abbrev-ref", "HEAD"], args.directory)
      )?.trim() ?? null
      const hasOrigin =
        (await runGit(["remote", "get-url", "origin"], args.directory)) != null
      let hasUpstream = false
      let ahead = 0
      let behind = 0
      const ab = await runGit(
        ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        args.directory,
      )
      if (ab != null) {
        hasUpstream = true
        const parts = ab.trim().split(/\s+/)
        if (parts.length === 2) {
          ahead = Number(parts[0]) || 0
          behind = Number(parts[1]) || 0
        }
      }
      return {
        ok: true,
        owner: parsed.owner.login,
        name: parsed.name,
        defaultBranch: parsed.defaultBranchRef.name,
        currentBranch:
          currentBranch && currentBranch !== "HEAD" ? currentBranch : null,
        hasOrigin,
        hasUpstream,
        ahead,
        behind,
      }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Commits on the current branch that are *not* on `base` (i.e. the
   * commits that would go into the PR). Returned newest-first so the
   * UI can mirror GitHub's compare page.
   */
  async getBranchCommits(args: {
    directory: string
    base: string
  }): Promise<Result<{ commits: GhCommit[]; head: string; base: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getBranchCommits", args, TTL.branchCommits, () =>
      this.getBranchCommitsImpl(args),
    )
  }

  private async getBranchCommitsImpl(args: {
    directory: string
    base: string
  }): Promise<Result<{ commits: GhCommit[]; head: string; base: string }>> {
    const head = (
      await runGit(["rev-parse", "--abbrev-ref", "HEAD"], args.directory)
    )?.trim()
    if (!head || head === "HEAD") {
      return { ok: false, error: "Not on a branch (detached HEAD)." }
    }
    if (head === args.base) {
      return {
        ok: true,
        commits: [],
        head,
        base: args.base,
      }
    }

    // Prefer comparing against origin/<base> if it exists, then local
    // <base>, then fall back to plain <base> (which may still resolve
    // via gitrevisions).
    const base = await pickBaseRef(args.directory, args.base)
    const SEP = "\x1f"
    const REC = "\x1e"
    const format = ["%H", "%h", "%an", "%at", "%s", "%b"].join(SEP)
    const out = await runGit(
      [
        "log",
        `--pretty=format:${format}${REC}`,
        "--no-merges",
        `${base}..HEAD`,
      ],
      args.directory,
    )
    if (out == null) {
      return {
        ok: false,
        error: `Could not enumerate commits between ${base} and HEAD.`,
      }
    }
    const commits: GhCommit[] = []
    for (const raw of out.split(REC)) {
      const entry = raw.replace(/^\n/, "")
      if (!entry) continue
      const parts = entry.split(SEP)
      if (parts.length < 5) continue
      const [sha, shortSha, an, atStr, subject, body] = parts
      commits.push({
        sha,
        shortSha,
        authorName: an,
        authorDate: Number(atStr) * 1000,
        subject,
        body: body ?? "",
      })
    }
    return { ok: true, commits, head, base }
  }

  /**
   * Full patch between `base` and HEAD, for the diff pane.
   * Renderer renders this through `@pierre/diffs`.
   */
  async getBranchDiff(args: {
    directory: string
    base: string
  }): Promise<Result<{ patch: string; base: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getBranchDiff", args, TTL.branchDiff, () =>
      this.getBranchDiffImpl(args),
    )
  }

  private async getBranchDiffImpl(args: {
    directory: string
    base: string
  }): Promise<Result<{ patch: string; base: string }>> {
    const base = await pickBaseRef(args.directory, args.base)
    const out = await runGit(
      ["diff", "--no-color", "--no-ext-diff", `${base}...HEAD`],
      args.directory,
    )
    return { ok: true, patch: out ?? "", base }
  }

  /**
   * Patch + numstat for a single commit (against its first parent).
   * Mirrors the existing `pr.getCommitDiff` shape so the renderer
   * can re-use the same diff component.
   */
  async getCommitDiff(args: {
    directory: string
    sha: string
  }): Promise<Result<{ patch: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getCommitDiff", args, TTL.commitDiff, () =>
      this.getCommitDiffImpl(args),
    )
  }

  private async getCommitDiffImpl(args: {
    directory: string
    sha: string
  }): Promise<Result<{ patch: string }>> {
    const out = await runGit(
      [
        "show",
        "--no-color",
        "--no-ext-diff",
        "--format=",
        "--patch",
        args.sha,
      ],
      args.directory,
    )
    return { ok: true, patch: out ?? "" }
  }

  /**
   * Working-tree status used by the create-PR flow. We only care
   * whether the tree is dirty and roughly *what* changed — the full
   * Git view already covers the staging UI.
   */
  async getWorkingTreeSummary(args: {
    directory: string
  }): Promise<Result<{ dirty: boolean; files: string[]; patch: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getWorkingTreeSummary", args, TTL.workingTree, () =>
      this.getWorkingTreeSummaryImpl(args),
    )
  }

  private async getWorkingTreeSummaryImpl(args: {
    directory: string
  }): Promise<Result<{ dirty: boolean; files: string[]; patch: string }>> {
    const statusOut = await runGit(
      ["status", "--porcelain=v1"],
      args.directory,
    )
    if (statusOut == null) {
      return { ok: false, error: "Not a git repository." }
    }
    const files: string[] = []
    for (const line of statusOut.split("\n")) {
      if (!line) continue
      // porcelain v1 lines are "XY path" or "XY old -> new"
      const path = line.slice(3).split(" -> ").pop()!.trim()
      if (path) files.push(path)
    }
    const dirty = files.length > 0
    let patch = ""
    if (dirty) {
      patch =
        (await runGit(
          ["diff", "--no-color", "--no-ext-diff", "HEAD"],
          args.directory,
        )) ?? ""
    }
    return { ok: true, dirty, files, patch }
  }

  /**
   * Stage everything and commit. Mirrors `gitService.commit` but
   * takes an optional `body` for the extended message and surfaces
   * the resulting commit's sha so the renderer can refresh
   * deterministically.
   */
  async commit(args: {
    directory: string
    subject: string
    body?: string
  }): Promise<Result<{ sha: string }>> {
    const subject = args.subject?.trim()
    if (!args.directory) return { ok: false, error: "No directory" }
    if (!subject) return { ok: false, error: "Commit message is required" }
    // Cache shape is built around "reads against the working tree /
    // branch tip"; both flip on every commit.
    this.invalidateCache({ directory: args.directory })
    try {
      await execFileP("git", ["add", "-A"], {
        cwd: args.directory,
        maxBuffer: MAX_BUFFER,
      })
      const argv = ["commit", "-m", subject]
      if (args.body && args.body.trim()) argv.push("-m", args.body.trim())
      await execFileP("git", argv, {
        cwd: args.directory,
        maxBuffer: MAX_BUFFER,
      })
      const sha =
        (
          await runGit(["rev-parse", "HEAD"], args.directory)
        )?.trim() ?? ""
      return { ok: true, sha }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Push the current branch to origin. We always pass
   * `--set-upstream` because the PR flow only ever cares about
   * pushing a branch that doesn't have an upstream yet — once it
   * has one, `gh pr create` will happily pick it up.
   */
  async pushBranch(args: {
    directory: string
  }): Promise<Result<{ branch: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    const branch = (
      await runGit(["rev-parse", "--abbrev-ref", "HEAD"], args.directory)
    )?.trim()
    if (!branch || branch === "HEAD") {
      return { ok: false, error: "Not on a branch (detached HEAD)." }
    }
    try {
      await execFileP(
        "git",
        ["push", "--set-upstream", "origin", branch],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      this.invalidateCache({ directory: args.directory })
      return { ok: true, branch }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Call `gh pr create` with the user-provided title/body plus any
   * reviewers. Returns the new PR's URL + number on success so the
   * renderer can transition to the detail view.
   */
  async createPullRequest(args: {
    directory: string
    title: string
    body: string
    base?: string
    reviewers?: string[]
    draft?: boolean
  }): Promise<Result<{ url: string; number: number }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    const title = args.title?.trim()
    if (!title) return { ok: false, error: "Title is required" }

    // Make sure the branch is pushed first so `gh` doesn't bail with
    // a confusing "branch not on remote" error. This is a no-op when
    // the branch is already up to date.
    const push = await this.pushBranch({ directory: args.directory })
    if (!push.ok) return push

    const argv: string[] = ["pr", "create", "--title", title, "--body", args.body ?? ""]
    if (args.base && args.base.trim()) {
      argv.push("--base", args.base.trim())
    }
    if (args.draft) argv.push("--draft")
    const reviewers = (args.reviewers ?? [])
      .map(r => r.trim())
      .filter(Boolean)
    if (reviewers.length > 0) {
      argv.push("--reviewer", reviewers.join(","))
    }

    try {
      const { stdout } = await execFileP("gh", argv, {
        cwd: args.directory,
        maxBuffer: MAX_BUFFER,
      })
      // gh prints the PR URL on the last non-empty line.
      const url =
        stdout
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean)
          .pop() ?? ""
      const m = url.match(/\/pull\/(\d+)(?:$|\?|#)/)
      const number = m ? parseInt(m[1], 10) : NaN
      if (!url || !m) {
        return {
          ok: false,
          error:
            "gh pr create succeeded but no PR URL was returned. Output:\n" +
            stdout,
        }
      }
      // New PR landed — the list cache is now stale.
      this.invalidateCache({ directory: args.directory })
      return { ok: true, url, number }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * `gh pr list` → strongly-typed PR summaries. We default to the 30
   * most-recent open PRs because that's what GitHub's own list page
   * shows; `state` lets the renderer flip to closed/merged/all.
   */
  async listPullRequests(args: {
    directory: string
    state?: "open" | "closed" | "merged" | "all"
    limit?: number
  }): Promise<Result<{ prs: PrSummary[] }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("listPullRequests", args, TTL.prList, () =>
      this.listPullRequestsImpl(args),
    )
  }

  private async listPullRequestsImpl(args: {
    directory: string
    state?: "open" | "closed" | "merged" | "all"
    limit?: number
  }): Promise<Result<{ prs: PrSummary[] }>> {
    const state = args.state ?? "open"
    const limit = args.limit ?? 30
    try {
      const { stdout } = await execFileP(
        "gh",
        [
          "pr",
          "list",
          "--state",
          state,
          "--limit",
          String(limit),
          "--json",
          "number,title,state,isDraft,url,author,headRefName,baseRefName,createdAt,updatedAt",
        ],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      type GhAuthor = { login: string } | null
      type Row = Omit<PrSummary, "author"> & { author: GhAuthor }
      const rows = JSON.parse(stdout) as Row[]
      const prs: PrSummary[] = rows.map(r => ({
        number: r.number,
        title: r.title,
        state: r.state,
        isDraft: r.isDraft,
        url: r.url,
        author: r.author?.login ?? "ghost",
        headRefName: r.headRefName,
        baseRefName: r.baseRefName,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
      return { ok: true, prs }
    } catch (err) {
      return toError(err)
    }
  }

  /** Full PR detail (title, body, commits, file stats, reviewers). */
  async getPullRequest(args: {
    directory: string
    number: number
  }): Promise<Result<{ pr: PrDetails }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getPullRequest", args, TTL.prDetail, () =>
      this.getPullRequestImpl(args),
    )
  }

  private async getPullRequestImpl(args: {
    directory: string
    number: number
  }): Promise<Result<{ pr: PrDetails }>> {
    try {
      const { stdout } = await execFileP(
        "gh",
        [
          "pr",
          "view",
          String(args.number),
          "--json",
          "number,title,state,isDraft,url,author,headRefName,baseRefName," +
            "createdAt,updatedAt,body,additions,deletions,changedFiles," +
            "commits,reviewRequests,comments",
        ],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      type Row = {
        number: number
        title: string
        state: "OPEN" | "CLOSED" | "MERGED"
        isDraft: boolean
        url: string
        author: { login: string } | null
        headRefName: string
        baseRefName: string
        createdAt: string
        updatedAt: string
        body: string
        additions: number
        deletions: number
        changedFiles: number
        commits: Array<{
          oid: string
          messageHeadline: string
          committedDate: string
          authors: Array<{ name: string; login?: string | null }>
        }>
        reviewRequests: Array<{ login?: string; name?: string }>
        comments: Array<{ id: string }>
      }
      const row = JSON.parse(stdout) as Row
      const pr: PrDetails = {
        number: row.number,
        title: row.title,
        state: row.state,
        isDraft: row.isDraft,
        url: row.url,
        author: row.author?.login ?? "ghost",
        headRefName: row.headRefName,
        baseRefName: row.baseRefName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        body: row.body ?? "",
        additions: row.additions,
        deletions: row.deletions,
        changedFiles: row.changedFiles,
        commits: row.commits.map(c => ({
          sha: c.oid,
          shortSha: c.oid.slice(0, 7),
          subject: c.messageHeadline,
          authorName:
            c.authors[0]?.login ?? c.authors[0]?.name ?? "unknown",
          authorDate: new Date(c.committedDate).getTime(),
        })),
        reviewers: row.reviewRequests
          .map(r => r.login ?? r.name ?? "")
          .filter(Boolean),
        comments: row.comments.length,
      }
      return { ok: true, pr }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Users assignable to a PR in this repo — powers the `@mention`
   * typeahead in the description editor. Uses
   * `gh api repos/{owner}/{name}/assignees` which returns both
   * collaborators and org members the current user can address.
   *
   * Cached aggressively because membership rarely changes within a
   * session.
   */
  async listAssignableUsers(args: {
    directory: string
  }): Promise<Result<{ users: GhUser[] }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("listAssignableUsers", args, TTL.assignableUsers, () =>
      this.listAssignableUsersImpl(args),
    )
  }

  private async listAssignableUsersImpl(args: {
    directory: string
  }): Promise<Result<{ users: GhUser[] }>> {
    try {
      const repo = await this.getRepoInfo({ directory: args.directory })
      if (!repo.ok) return repo
      // Pull up to 100 — the only public PR composer that cares about
      // 100+ assignable users is on github.com itself, and they
      // paginate in their UI. Anything bigger and the typeahead is
      // the wrong shape.
      const { stdout } = await execFileP(
        "gh",
        [
          "api",
          "--paginate",
          `repos/${repo.owner}/${repo.name}/assignees?per_page=100`,
        ],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      // `gh api --paginate` concatenates pages as one JSON array per
      // page; we just JSON.parse the first array and stop. For most
      // repos the result fits on a single page anyway.
      const trimmed = stdout.trim()
      type Row = { login: string; name?: string | null }
      // Tolerate the multi-page case by extracting every top-level
      // array and concatenating.
      const rows = parsePaginatedArrays<Row>(trimmed)
      const users: GhUser[] = []
      const seen = new Set<string>()
      for (const r of rows) {
        if (!r.login || seen.has(r.login)) continue
        seen.add(r.login)
        users.push({ login: r.login, name: r.name ?? null })
      }
      users.sort((a, b) => a.login.localeCompare(b.login))
      return { ok: true, users }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Issues in this repo — powers the `#123` typeahead. Pulls the
   * 100 most-recently updated issues across every state so users can
   * reference closed issues too. Pull requests are excluded because
   * GitHub treats them as a separate concept on the PR page itself,
   * and mixing them in just makes the picker noisy.
   */
  async listIssues(args: {
    directory: string
  }): Promise<Result<{ issues: GhIssue[] }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("listIssues", args, TTL.issues, () =>
      this.listIssuesImpl(args),
    )
  }

  private async listIssuesImpl(args: {
    directory: string
  }): Promise<Result<{ issues: GhIssue[] }>> {
    try {
      const { stdout } = await execFileP(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,title,state",
        ],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      type Row = { number: number; title: string; state: "OPEN" | "CLOSED" }
      const rows = JSON.parse(stdout) as Row[]
      return {
        ok: true,
        issues: rows.map(r => ({
          number: r.number,
          title: r.title,
          state: r.state,
        })),
      }
    } catch (err) {
      return toError(err)
    }
  }

  /** Diff for an entire PR (head...base), used by the detail view. */
  async getPullRequestDiff(args: {
    directory: string
    number: number
  }): Promise<Result<{ patch: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    return this.memoize("getPullRequestDiff", args, TTL.prDiff, () =>
      this.getPullRequestDiffImpl(args),
    )
  }

  private async getPullRequestDiffImpl(args: {
    directory: string
    number: number
  }): Promise<Result<{ patch: string }>> {
    try {
      const { stdout } = await execFileP(
        "gh",
        ["pr", "diff", String(args.number)],
        { cwd: args.directory, maxBuffer: MAX_BUFFER },
      )
      return { ok: true, patch: stdout }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Generate a commit message from the working-tree diff using a
   * cheap LLM. Returns `{ subject, body }`; both fields are best
   * effort — callers should let the user edit before committing.
   *
   * Uses the shared small-model resolver, so we inherit auth discovery
   * (env vars + `~/.pi/agent/auth.json`) for free.
   */
  async generateCommitMessage(args: {
    directory: string
  }): Promise<Result<{ subject: string; body: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    const summary = await this.getWorkingTreeSummary({ directory: args.directory })
    if (!summary.ok) return summary
    if (!summary.dirty) {
      return { ok: false, error: "No uncommitted changes to summarize." }
    }
    const diff = trimDiff(summary.patch, MAX_AI_DIFF_BYTES, MAX_AI_DIFF_LINES)
    try {
      const { model, apiKey, headers } = await resolveSmallModel()
      const context: Context = {
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildCommitMessagePrompt(summary.files, diff),
            timestamp: Date.now(),
          },
        ],
        tools: [],
      }
      const message = await complete(model, context, {
        apiKey,
        headers,
        maxTokens: 600,
      })
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return {
          ok: false,
          error:
            message.errorMessage ??
            `model returned stopReason=${message.stopReason}`,
        }
      }
      const raw = message.content
        .filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        )
        .map(b => b.text)
        .join("")
        .trim()
      const { subject, body } = parseAiCommitMessage(raw)
      if (!subject) {
        return { ok: false, error: "Model returned an empty subject line." }
      }
      return { ok: true, subject, body }
    } catch (err) {
      return toError(err)
    }
  }

  /**
   * Generate a long-form PR body from the *committed* branch diff.
   * Falls back to a simple "## Commits" list rendered from the
   * branch log when the model is unavailable.
   */
  async generatePrBody(args: {
    directory: string
    base: string
    title: string
  }): Promise<Result<{ body: string }>> {
    if (!args.directory) return { ok: false, error: "No directory" }
    const commits = await this.getBranchCommits({
      directory: args.directory,
      base: args.base,
    })
    if (!commits.ok) return commits
    const fallback = renderFallbackBody(commits.commits)
    const diffRes = await this.getBranchDiff({
      directory: args.directory,
      base: args.base,
    })
    if (!diffRes.ok) {
      return { ok: true, body: fallback }
    }
    const diff = trimDiff(diffRes.patch, MAX_GENERATED_BODY_BYTES, 4000)
    try {
      const { model, apiKey, headers } = await resolveSmallModel()
      const context: Context = {
        systemPrompt: PR_BODY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildPrBodyPrompt({
              title: args.title,
              commits: commits.commits,
              diff,
            }),
            timestamp: Date.now(),
          },
        ],
        tools: [],
      }
      const message = await complete(model, context, {
        apiKey,
        headers,
        maxTokens: 800,
      })
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { ok: true, body: fallback }
      }
      const raw = message.content
        .filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        )
        .map(b => b.text)
        .join("")
        .trim()
      if (!raw) return { ok: true, body: fallback }
      return { ok: true, body: raw }
    } catch {
      return { ok: true, body: fallback }
    }
  }

  /**
   * Wrap a read so concurrent callers share one fetch and a soft
   * TTL keeps subsequent calls cheap. Cache key is built from the
   * method name + JSON-stringified args.
   *
   * TODO(zenbu.js): replace with the framework's service cache once
   * released. See the comment on `this.cache` above.
   */
  private memoize<T>(
    method: string,
    args: Record<string, unknown>,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = method + ":" + JSON.stringify(args)
    const now = Date.now()
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > now) {
      return hit.value as Promise<T>
    }
    const value = fn().catch(err => {
      // Don't poison the cache with rejections — they should be
      // retried on the next call.
      this.cache.delete(key)
      throw err
    })
    this.cache.set(key, { value, expiresAt: now + ttlMs })
    return value
  }
}

/* --------------------------- TTLs -------------------------------------- */

/**
 * Per-method cache lifetimes. Tight enough that user-visible data
 * doesn't go stale, loose enough to make tab switches feel free.
 * TODO(zenbu.js): owned by the framework cache when it lands.
 */
const TTL = {
  repoInfo: 30_000,
  workingTree: 1_000,
  branchCommits: 5_000,
  branchDiff: 5_000,
  /** Commit SHAs are immutable, so diffs by SHA never need to be
   * refetched while the process lives. */
  commitDiff: 24 * 60 * 60 * 1000,
  prList: 5_000,
  prDetail: 5_000,
  prDiff: 30_000,
  /** Assignable users + issues power the description typeahead.
   * They're high-traffic during a single PR draft and rarely
   * change within a session, so a long TTL is fine. */
  assignableUsers: 5 * 60_000,
  issues: 60_000,
}

/* --------------------------- internals --------------------------------- */

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write conventional git commit messages.

Given a list of changed files and a unified diff, produce:
- A 50-character-or-less subject line in the imperative mood (no trailing period).
- An OPTIONAL extended body explaining the *why* and any non-obvious context. Wrap at 72 columns. Use bullet points for multi-topic changes.

Reply with exactly:

<subject>SUBJECT LINE</subject>
<body>OPTIONAL BODY OR EMPTY</body>

Do not include any other text. Do not invent context not visible in the diff.`

const PR_BODY_SYSTEM_PROMPT = `You write GitHub pull-request descriptions.

Given a PR title, a list of commits, and a unified diff, produce a concise PR body in GitHub-flavored Markdown with these sections:

## Summary
One short paragraph (1–3 sentences) describing what the PR does.

## Changes
Bullet list of the meaningful changes (not a file dump).

## Notes
Anything reviewers should know (migrations, breaking changes, follow-ups). Omit the section if there's nothing notable.

Do not include "Test plan", "Screenshots", or boilerplate sections you can't fill in. Do not invent context not visible in the diff.`

function buildCommitMessagePrompt(files: string[], diff: string): string {
  const filesBlock = files.slice(0, 30).map(f => `- ${f}`).join("\n")
  return [
    `Files changed (${files.length}):`,
    filesBlock,
    "",
    "Diff (may be truncated):",
    "```",
    diff || "(empty)",
    "```",
  ].join("\n")
}

function buildPrBodyPrompt(args: {
  title: string
  commits: GhCommit[]
  diff: string
}): string {
  const commitsBlock = args.commits
    .slice(0, 30)
    .map(c => `- ${c.shortSha} ${c.subject}`)
    .join("\n")
  return [
    `Title: ${args.title}`,
    "",
    `Commits (${args.commits.length}):`,
    commitsBlock || "(none)",
    "",
    "Diff (may be truncated):",
    "```",
    args.diff || "(empty)",
    "```",
  ].join("\n")
}

function parseAiCommitMessage(raw: string): {
  subject: string
  body: string
} {
  const subjectMatch = raw.match(/<subject>([\s\S]*?)<\/subject>/i)
  const bodyMatch = raw.match(/<body>([\s\S]*?)<\/body>/i)
  if (subjectMatch) {
    return {
      subject: subjectMatch[1].trim().replace(/\s+/g, " "),
      body: bodyMatch ? bodyMatch[1].trim() : "",
    }
  }
  // Fallback: first non-empty line is the subject, rest is body.
  const lines = raw.split("\n").map(l => l.trim())
  const first = lines.find(l => l.length > 0) ?? ""
  const rest = lines
    .slice(lines.indexOf(first) + 1)
    .join("\n")
    .trim()
  return { subject: first, body: rest }
}

function renderFallbackBody(commits: GhCommit[]): string {
  if (commits.length === 0) return ""
  const lines = ["## Commits", ""]
  for (const c of commits) {
    lines.push(`- ${c.shortSha} ${c.subject}`)
  }
  return lines.join("\n")
}

/**
 * Parse `gh api --paginate` output. When the response is paginated,
 * `gh` emits one JSON array per page, concatenated directly with no
 * separator (e.g. `[...][...]`). We walk balanced brackets and parse
 * each top-level array independently.
 */
function parsePaginatedArrays<T>(raw: string): T[] {
  const out: T[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === "[") {
      if (depth === 0) start = i
      depth++
    } else if (c === "]") {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const arr = JSON.parse(raw.slice(start, i + 1)) as T[]
          for (const item of arr) out.push(item)
        } catch {
          // Skip malformed chunk; downstream sees fewer results, not a
          // hard failure.
        }
        start = -1
      }
    }
  }
  return out
}

function trimDiff(diff: string, maxBytes: number, maxLines: number): string {
  if (!diff) return ""
  let out = diff
  if (out.length > maxBytes) {
    out = out.slice(0, maxBytes) + "\n…(truncated)…"
  }
  const lines = out.split("\n")
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n") + "\n…(truncated)…"
  }
  return out
}

async function pickBaseRef(directory: string, base: string): Promise<string> {
  const candidates = [`origin/${base}`, base]
  for (const ref of candidates) {
    const out = await runGit(["rev-parse", "--verify", "--quiet", ref], directory)
    if (out != null) return ref
  }
  return base
}

async function runGit(argv: string[], cwd: string): Promise<string | null> {
  return runText("git", argv, cwd)
}

async function runText(
  cmd: string,
  argv: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, argv, {
      cwd,
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string }
    if (e.stdout != null && e.stdout.length > 0) return e.stdout
    return null
  }
}

function toError(err: unknown): Err {
  const e = err as NodeJS.ErrnoException & {
    stdout?: string
    stderr?: string
  }
  const detail =
    (e.stderr && e.stderr.toString().trim()) ||
    (e.stdout && e.stdout.toString().trim()) ||
    (err instanceof Error ? err.message : String(err)) ||
    "command failed"
  return { ok: false, error: detail }
}
