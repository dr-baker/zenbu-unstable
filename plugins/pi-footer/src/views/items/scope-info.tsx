import { useDb, type ViewComponentProps } from "@zenbujs/core/react";
import { FolderIcon, FoldersIcon, GitBranchIcon } from "lucide-react";
import { displayPath, useHomeDir } from "../lib/home-dir";
import { StatusBarItem } from "../components/status-bar-item";

export type ScopeInfoArgs = {
  /** The session whose scope (worktree) we should describe.
   * Threaded through by the pi-footer container so each pane's
   * footer reflects *its* chat, not whichever pane is
   * window-active. */
  sessionId?: string | null;
};

/**
 * Footer info about *where* the active chat is rooted: branch,
 * primary cwd, and any extra directories the scope has access to.
 * Sits to the left of the per-session stats so the more contextual
 * (rarely-changing) info reads first, with the running cost /
 * context gauge floating off to the right.
 *
 * Registered by `PiFooterViewsService` as `pi-footer.scope-info`
 * with `meta.position = "left", order = 10`.
 */
export default function ScopeInfoItem({
  args,
}: ViewComponentProps<ScopeInfoArgs>) {
  const sessionId = args?.sessionId ?? null;
  const homeDir = useHomeDir();

  const scopeId = useDb((root) =>
    sessionId ? root.pi.sessions[sessionId]?.scopeId ?? null : null,
  );
  const scope = useDb((root) =>
    scopeId ? root.app.scopes[scopeId] ?? null : null,
  );
  // Look up the worktree on the repo so we can show its branch.
  // Worktrees inside a single repo are keyed by directory path,
  // and a freshly-cloned worktree can briefly have a null branch
  // (detached HEAD), so we fall back to the directory name in
  // that case.
  const branch = useDb((root) => {
    if (!scope?.repoId) return null;
    const repo = root.app.repos[scope.repoId];
    if (!repo) return null;
    const wt = repo.worktrees.find((w) => w.path === scope.directory);
    return wt?.branch ?? null;
  });

  if (!scope) return null;

  const directory = scope.directory;
  const extras = scope.extraDirectories;
  const cwdDisplay = displayPath(directory, homeDir);

  return (
    <>
      {branch && (
        <StatusBarItem
          icon={<GitBranchIcon className="size-3" />}
          title={`Branch: ${branch}`}
        >
          {branch}
        </StatusBarItem>
      )}
      <StatusBarItem
        icon={<FolderIcon className="size-3" />}
        title={`Working directory: ${cwdDisplay}`}
      >
        {cwdDisplay}
      </StatusBarItem>
      {extras.length > 0 && (
        <StatusBarItem
          icon={<FoldersIcon className="size-3" />}
          title={
            `Extra directories (${extras.length}):\n` +
            extras.map((d) => displayPath(d, homeDir)).join("\n")
          }
        >
          {extras.length === 1
            ? `+${displayPath(extras[0]!, homeDir)}`
            : `+${extras.length} dirs`}
        </StatusBarItem>
      )}
    </>
  );
}
