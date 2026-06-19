import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useDb, useRpc } from "@zenbujs/core/react";
import { cn } from "@/lib/utils";
import { defaultWorktreePath } from "@/lib/worktree-paths";

/**
 * `/workspace` slash-command panel. Replaces the composer surface
 * (same slot/treatment as `TreeSelector` and `ForkSelector`) and
 * collects a branch name (plus an optional "commit current changes
 * first" toggle) to create a fresh git worktree of the current
 * chat's repo and *move* the chat into it.
 *
 * Design choices, deliberate:
 *
 *   1. Minimal — one input plus an opt-in "commit first" section.
 *      The user picked the chat they want to move by being IN the
 *      chat; the only datum we don't know is the branch name (and
 *      whether their pending changes should ride along).
 *   2. Path is *derived* (`<repo-parent>/<repo-name>-<branch>`), not
 *      entered. Same derivation the full `CreateWorktreeDialog`
 *      uses, lifted into `@/lib/worktree-paths`. Power users who
 *      need a custom path can still use the dialog from the git
 *      sidebar.
 *   3. Repo discovery is pure replica reads — no RPC.
 *   4. Dirty-status detection IS via RPC (`rpc.app.git.getStatusSummary`).
 *      The status summary isn't mirrored into the replica, so we
 *      fire one query on mount and re-fire if the scope changes.
 *      The panel shows a "clean" state while the query is in flight
 *      so users on a clean working tree never see a flash of
 *      irrelevant UI.
 *   5. The "commit first" message defaults to empty → the RPC
 *      generates a marker (`auto-generated commit ...`). Hitting
 *      Enter without typing a message is the fast path.
 *   6. Streaming is handled on the main side. We surface a hint but
 *      don't block — the RPC awaits an abort before the move.
 *
 * The actual git work + scope reshuffling lives in
 * `SessionsService.moveToNewWorktree`. See its docstring for the
 * transaction shape.
 */
export type WorkspaceSelectorProps = {
  /** Scope the chat is currently parked in. Used to look up the
   * repo + main-worktree path for the default-path derivation, and
   * to query its working-tree dirtiness. */
  scopeId: string;
  /** Whether the underlying agent session is currently streaming.
   * Surface-only — purely so we can show a "will interrupt
   * current turn" hint. The RPC does the actual abort. */
  isStreaming: boolean;
  /** Fired with the trimmed branch name + derived worktree path
   * + optional commit-first instructions when the user confirms.
   * Caller is responsible for the RPC. */
  onConfirm: (args: {
    branch: string;
    worktreePath: string;
    /** When set, the RPC commits the source's uncommitted changes
     * before creating the worktree so they're carried forward.
     * Empty `message` → auto-generated marker on the main side. */
    commitFirst?: { message: string };
  }) => Promise<void> | void;
  onCancel: () => void;
};

export function WorkspaceSelector({
  scopeId,
  isStreaming,
  onConfirm,
  onCancel,
}: WorkspaceSelectorProps) {
  const rpc = useRpc();

  // Resolve repo + main-worktree path from the chat's scope. Both
  // live in the replica already — see `ReposService` for how the
  // repo record gets seeded/synced.
  const scope = useDb((root) => root.app.scopes[scopeId]);
  const repo = useDb((root) =>
    scope?.repoId ? root.app.repos[scope.repoId] : undefined,
  );
  const mainWorktreePath = repo?.mainWorktreePath ?? null;
  const directory = scope?.directory ?? null;

  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFocus, setHasFocus] = useState(true);

  // Dirty-detection state. `undefined` = haven't checked yet (shows
  // no UI), then a concrete result. We never block on the check —
  // submission is allowed before it resolves, the "commit first"
  // section just won't appear.
  const [dirty, setDirty] = useState<
    { dirty: boolean; changed: number; untracked: number } | undefined
  >(undefined);
  // User's choice for the dirty case: bring the changes (commit
  // first) vs leave them in place. Default OFF so users who don't
  // care don't accidentally land an "auto-generated commit" they
  // didn't want.
  const [commitFirst, setCommitFirst] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    rpc.app.git
      .getStatusSummary({ directory })
      .then((s) => {
        if (cancelled) return;
        if (!s.isRepo) {
          setDirty({ dirty: false, changed: 0, untracked: 0 });
          return;
        }
        const changed = s.changed;
        const untracked = s.untracked;
        setDirty({
          dirty: changed + untracked > 0,
          changed,
          untracked,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Status check failure is non-fatal — treat as clean so the
        // panel still lets the user proceed. The actual commit step
        // will surface any real git error.
        console.warn("[workspace-selector] status check failed:", err);
        setDirty({ dirty: false, changed: 0, untracked: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, directory]);

  const derivedPath = useMemo(() => {
    if (!mainWorktreePath) return "";
    const trimmed = branch.trim();
    if (!trimmed) return "";
    return defaultWorktreePath(mainWorktreePath, trimmed);
  }, [mainWorktreePath, branch]);

  // Scope-level guardrail: if the chat's scope isn't a git repo, we
  // can't make a worktree. Surface inline rather than throwing from
  // the RPC, so the user sees the constraint before typing.
  const cannotProceedReason: string | null = !scope
    ? "Scope not found."
    : !scope.repoId
      ? "This chat's working directory is not a git repository."
      : !mainWorktreePath
        ? "Repo metadata still syncing — try again in a moment."
        : null;

  const canSubmit =
    cannotProceedReason === null && branch.trim().length > 0 && !busy;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Autofocus the branch input so the user can start typing
  // immediately. Container focus styling falls through via DOM
  // bubbling.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!canSubmit || !mainWorktreePath) return;
    const trimmed = branch.trim();
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        branch: trimmed,
        worktreePath: derivedPath,
        commitFirst: commitFirst
          ? { message: commitMessage.trim() }
          : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // On success the caller dismounts the panel — leaving `busy`
    // true avoids a flash of "Create" between resolve and dismount.
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy) {
      // While the RPC is in flight Escape still tries to cancel;
      // the worktree may be half-created but that's a user-visible
      // artifact rather than data corruption.
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="mx-auto w-full max-w-[919px] px-2 pt-1 pb-2">
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onFocus={() => setHasFocus(true)}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && containerRef.current?.contains(next)) return;
          setHasFocus(false);
        }}
        className={cn(
          "flex max-h-[50vh] min-h-0 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg outline-none",
          hasFocus
            ? "border-primary/40 ring-1 ring-primary/30"
            : "border-border",
        )}
      >
        <Header isStreaming={isStreaming} />
        <Body
          inputRef={inputRef}
          branch={branch}
          onBranchChange={(v) => {
            // Branch refs can't contain spaces — turn any run of
            // whitespace into a single hyphen as the user types, so
            // hitting space produces a dash inline.
            setBranch(v.replace(/\s+/g, "-"));
            // Clear the prior error as soon as the user edits.
            if (error) setError(null);
          }}
          derivedPath={derivedPath}
          cannotProceedReason={cannotProceedReason}
          error={error}
          disabled={busy}
          dirty={dirty}
          commitFirst={commitFirst}
          onCommitFirstChange={setCommitFirst}
          commitMessage={commitMessage}
          onCommitMessageChange={setCommitMessage}
        />
        <Footer
          busy={busy}
          commitFirst={commitFirst}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

function Header({ isStreaming }: { isStreaming: boolean }) {
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">
          Move chat to new worktree
        </span>
      </div>
      {isStreaming ? (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          <span className="text-foreground">will interrupt current turn</span>
        </div>
      ) : null}
    </div>
  );
}

function Body({
  inputRef,
  branch,
  onBranchChange,
  derivedPath,
  cannotProceedReason,
  error,
  disabled,
  dirty,
  commitFirst,
  onCommitFirstChange,
  commitMessage,
  onCommitMessageChange,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  branch: string;
  onBranchChange: (v: string) => void;
  derivedPath: string;
  cannotProceedReason: string | null;
  error: string | null;
  disabled: boolean;
  dirty: { dirty: boolean; changed: number; untracked: number } | undefined;
  commitFirst: boolean;
  onCommitFirstChange: (v: boolean) => void;
  commitMessage: string;
  onCommitMessageChange: (v: string) => void;
}) {
  const showDirtySection = dirty?.dirty ?? false;
  const dirtyFilesTotal = dirty ? dirty.changed + dirty.untracked : 0;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2 flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-muted-foreground">
          Branch name
        </span>
        <input
          ref={inputRef}
          type="text"
          value={branch}
          disabled={disabled || cannotProceedReason !== null}
          onChange={(e) => onBranchChange(e.target.value)}
          placeholder="my-feature"
          className={cn(
            "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </label>
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-muted-foreground">
          Worktree path
        </span>
        <span
          className={cn(
            "font-mono text-[11px] truncate",
            derivedPath ? "text-foreground" : "text-muted-foreground/60",
          )}
        >
          {derivedPath}
        </span>
      </div>

      {showDirtySection && (
        // Dirty-tree section: surfaces the choice "carry pending
        // changes forward (commit first)" vs "leave them behind".
        // Default OFF — the surprise of an unexpected auto-commit
        // is worse than the surprise of finding your changes still
        // in the source worktree.
        <div className="mt-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 flex flex-col gap-1.5">
          <label className="flex items-start gap-2 text-[11px] text-foreground">
            <input
              type="checkbox"
              checked={commitFirst}
              disabled={disabled}
              onChange={(e) => onCommitFirstChange(e.target.checked)}
              className="mt-0.5 h-3 w-3"
              // Use a mousedown handler so clicking the checkbox
              // doesn't steal focus from the container's keyboard
              // handler. (React still fires onChange for the
              // click.)
              onMouseDown={(e) => e.preventDefault()}
            />
            <span>
              Current worktree has{" "}
              <span className="font-medium">
                {dirtyFilesTotal} uncommitted change
                {dirtyFilesTotal === 1 ? "" : "s"}
              </span>
              . Commit them first and carry them into the new worktree.
            </span>
          </label>
          {commitFirst && (
            <label className="flex flex-col gap-1 pl-5">
              <span className="text-[10px] text-muted-foreground">
                Commit message (optional — leave blank for an auto-generated
                marker)
              </span>
              <input
                type="text"
                value={commitMessage}
                disabled={disabled}
                onChange={(e) => onCommitMessageChange(e.target.value)}
                placeholder="(auto-generated commit)"
                className={cn(
                  "w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                // Don't intercept Enter here — let it bubble to the
                // container so a single Enter still submits the
                // whole form.
              />
            </label>
          )}
        </div>
      )}

      {cannotProceedReason && (
        <div className="text-[11px] text-destructive">
          {cannotProceedReason}
        </div>
      )}
      {error && (
        <div className="text-[11px] text-destructive whitespace-pre-wrap">
          {error}
        </div>
      )}
    </div>
  );
}

function Footer({
  busy,
  commitFirst,
  onCancel,
}: {
  busy: boolean;
  commitFirst: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 flex items-center justify-between text-[10px] text-muted-foreground">
      {busy ? (
        <span className="text-shimmer">
          {commitFirst
            ? "Committing + creating worktree…"
            : "Creating worktree…"}
        </span>
      ) : (
        <button
          type="button"
          onClick={onCancel}
          className="hover:text-foreground"
        >
          ← cancel
        </button>
      )}
    </div>
  );
}
