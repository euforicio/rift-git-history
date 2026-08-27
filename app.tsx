import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type {
  CommitDetails,
  CommitPatch,
  GitCommitSummary,
  GitFileChange,
  GitRef,
  HistoryPage,
} from "./contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import "./app.css";

const PAGE_SIZE = 200;
const COMMIT_ROW_HEIGHT = 31;
const DATE_HEADER_HEIGHT = 24;
const GRAPH_WIDTH = 38;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Git history could not be loaded.";
}

function exactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function calendarKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateGroupLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";

  const parts = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`.trim();
}

type HistoryListItem =
  | {
    kind: "date";
    key: string;
    label: string;
    count: number;
  }
  | {
    kind: "commit";
    key: string;
    commit: GitCommitSummary;
    commitIndex: number;
    showAuthor: boolean;
  };

function historyListItems(commits: GitCommitSummary[]): HistoryListItem[] {
  const groups: Array<{ key: string; label: string; commits: Array<{ commit: GitCommitSummary; index: number }> }> = [];
  for (const [index, commit] of commits.entries()) {
    const key = calendarKey(commit.authorDate);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({
        key,
        label: dateGroupLabel(commit.authorDate),
        commits: [{ commit, index }],
      });
    } else {
      current.commits.push({ commit, index });
    }
  }

  return groups.flatMap((group) => [
    {
      kind: "date" as const,
      key: `date-${group.key}-${group.commits[0]!.commit.hash}`,
      label: group.label,
      count: group.commits.length,
    },
    ...group.commits.map(({ commit, index }, groupIndex) => ({
      kind: "commit" as const,
      key: commit.hash,
      commit,
      commitIndex: index,
      showAuthor: groupIndex === 0 || group.commits[groupIndex - 1]?.commit.authorName !== commit.authorName,
    })),
  ]);
}

function subjectParts(subject: string): { prefix: string | null; text: string } {
  const match = /^([a-z][a-z0-9-]*(?:\([^)]+\))?!?:)\s*(.*)$/i.exec(subject.trim());
  if (!match) return { prefix: null, text: subject || "No commit message" };
  return { prefix: match[1] ?? null, text: match[2] || "No commit message" };
}

function refClass(ref: GitRef): string {
  if (ref.isHead) return "git-ref-head";
  switch (ref.kind) {
    case "local":
      return "git-ref-local";
    case "remote":
      return "git-ref-remote";
    case "tag":
      return "git-ref-tag";
    default:
      return "git-ref-muted";
  }
}

function RefPills({ refs, limit = 2 }: { refs: GitRef[]; limit?: number }) {
  if (refs.length === 0) return null;
  const visible = refs.slice(0, limit);
  return (
    <span className="git-refs" aria-label={refs.map((ref) => ref.name).join(", ")}>
      {visible.map((ref) => (
        <span className={`git-ref ${refClass(ref)}`} key={ref.fullName}>
          {ref.isHead ? `HEAD → ${ref.name}` : ref.name}
        </span>
      ))}
      {refs.length > limit && (
        <span className="git-ref git-ref-muted">+{refs.length - limit}</span>
      )}
    </span>
  );
}

function CommitSubject({ subject }: { subject: string }) {
  const { prefix, text } = subjectParts(subject);
  return (
    <span className="git-commit-subject" title={subject}>
      {prefix && <span className="git-commit-prefix">{prefix}</span>}
      {prefix && " "}
      {text}
    </span>
  );
}

function commitMatches(commit: GitCommitSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return false;
  return [
    commit.subject,
    commit.hash,
    commit.authorName,
    commit.authorEmail,
    ...commit.refs.map((ref) => ref.name),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function CommitList({
  threadId,
  commits,
  hasMore,
  loadingMore,
  query,
  expandedHash,
  onLoadMore,
  onToggleCommit,
  onOpenDiff,
}: {
  threadId: string;
  commits: GitCommitSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  query: string;
  expandedHash: string | null;
  onLoadMore: () => void;
  onToggleCommit: (hash: string) => void;
  onOpenDiff: (commit: GitCommitSummary, details: CommitDetails, path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listItems = useMemo(() => historyListItems(commits), [commits]);
  const matches = useMemo(
    () => commits.map((commit) => commitMatches(commit, query)),
    [commits, query],
  );
  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => listItems[index]?.key ?? index,
    estimateSize: (index) => listItems[index]?.kind === "date"
      ? DATE_HEADER_HEIGHT
      : COMMIT_ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? 0;
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const firstVisibleIndex = virtualItems.find((item) => item.end > scrollOffset)?.index ?? 0;
  let activeDate: Extract<HistoryListItem, { kind: "date" }> | null = null;
  for (let index = firstVisibleIndex; index >= 0; index -= 1) {
    const item = listItems[index];
    if (item?.kind === "date") {
      activeDate = item;
      break;
    }
  }

  useEffect(() => {
    if (hasMore && !loadingMore && lastVisibleIndex >= listItems.length - 30) {
      onLoadMore();
    }
  }, [hasMore, lastVisibleIndex, listItems.length, loadingMore, onLoadMore]);

  useEffect(() => {
    virtualizer.measure();
  }, [expandedHash, virtualizer]);

  return (
    <div className="git-history-scroll" ref={scrollRef} role="list">
      <div
        className="git-history-virtual"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {activeDate && (
          <div
            className="git-date-header git-date-header-sticky"
            aria-hidden="true"
            style={{ transform: `translateY(${scrollOffset}px)` }}
          >
            <span>{activeDate.label}</span>
            <span className="git-date-rule" />
            <span>{activeDate.count}</span>
          </div>
        )}
        {virtualItems.map((virtualRow) => {
          const item = listItems[virtualRow.index];
          if (!item) return null;
          if (item.kind === "date") {
            return (
              <div
                className="git-date-listitem"
                data-index={virtualRow.index}
                key={item.key}
                ref={virtualizer.measureElement}
                role="presentation"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <div className="git-date-header">
                  <span>{item.label}</span>
                  <span className="git-date-rule" />
                  <span>{item.count}</span>
                </div>
              </div>
            );
          }

          const { commit, commitIndex, showAuthor } = item;
          const isMerge = commit.parents.length > 1;
          const isHead = commit.refs.some((ref) => ref.isHead);
          const isExpanded = expandedHash === commit.hash;
          const expansionId = `git-commit-files-${commit.hash}`;
          return (
            <div
              className="git-commit-listitem"
              data-index={virtualRow.index}
              key={commit.hash}
              ref={virtualizer.measureElement}
              role="listitem"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <button
                className={`git-commit-row ${matches[commitIndex] ? "git-commit-match" : ""}`}
                aria-controls={expansionId}
                aria-expanded={isExpanded}
                data-head={isHead || undefined}
                data-merge={isMerge || undefined}
                data-expanded={isExpanded || undefined}
                onClick={() => onToggleCommit(commit.hash)}
                title={isExpanded ? "Collapse changed files" : "Show changed files"}
              >
                <span className="git-graph-node-cell">
                  <span className="git-graph-node" data-head={isHead || undefined} />
                </span>
                <Icon name="ChevronRight" className="git-commit-expand-icon" aria-hidden="true" />
                <span className="git-commit-copy">
                  <CommitSubject subject={commit.subject} />
                  <RefPills refs={commit.refs} />
                </span>
                <span className="git-commit-inline-meta">
                  {isExpanded && <code>{commit.hash.slice(0, 7)}</code>}
                  {showAuthor && <span className="git-commit-author">{commit.authorName}</span>}
                  <time dateTime={commit.authorDate}>{exactTime(commit.authorDate)}</time>
                </span>
              </button>
              {isExpanded && (
                <InlineCommitFiles
                  id={expansionId}
                  threadId={threadId}
                  commit={commit}
                  onOpenDiff={onOpenDiff}
                />
              )}
            </div>
          );
        })}
      </div>
      {loadingMore && (
        <div className="git-loading-more" role="status">
          <Icon name="Loading" className="animate-spin" />
          Loading older commits
        </div>
      )}
    </div>
  );
}

function statusLetter(status: GitFileChange["status"]): string {
  switch (status) {
    case "added":
    case "copied":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "type-changed":
    case "modified":
    case "unknown":
      return "M";
  }
}

function pathParts(path: string): { directory: string; filename: string } {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return { directory: "", filename: path };
  return {
    directory: path.slice(0, separator + 1),
    filename: path.slice(separator + 1),
  };
}

function changeTotals(files: GitFileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function InlineCommitFiles({
  id,
  threadId,
  commit,
  onOpenDiff,
}: {
  id: string;
  threadId: string;
  commit: GitCommitSummary;
  onOpenDiff: (commit: GitCommitSummary, details: CommitDetails, path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setDetailsError(null);
    void rpc
      .call("details", { threadId, hash: commit.hash })
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch((error: unknown) => {
        if (active) setDetailsError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [commit.hash, rpc, threadId]);

  const totals = details ? changeTotals(details.files) : null;

  return (
    <div
      className="git-commit-expansion"
      id={id}
      role="region"
      aria-label={`Files changed in ${commit.subject || commit.hash.slice(0, 8)}`}
      style={{ marginLeft: `${GRAPH_WIDTH}px` }}
    >
      {detailsError && <div className="git-inline-error" role="alert">{detailsError}</div>}
      {!details && !detailsError && (
        <div className="git-detail-loading" role="status">
          <Icon name="Loading" className="animate-spin" />
          Loading changed files
        </div>
      )}

      {details && (
        <section className="git-files">
          <div className="git-files-summary">
            <span>{details.files.length} {details.files.length === 1 ? "file" : "files"}</span>
            <span className="git-stat-added">+{totals?.additions ?? 0}</span>
            <span className="git-stat-removed">−{totals?.deletions ?? 0}</span>
          </div>
          {details.files.length === 0 && (
            <div className="git-empty-files">No file changes to show.</div>
          )}
          {details.files.map((file) => {
            const parts = pathParts(file.path);
            return (
              <div className="git-inline-file" key={file.path}>
                <button
                  className="git-file-row"
                  onClick={() => onOpenDiff(commit, details, file.path)}
                  title={`Open diff for ${file.path}`}
                >
                  <span className={`git-file-status git-file-status-${file.status}`}>
                    <span className="sr-only">{file.status}</span>
                    {statusLetter(file.status)}
                  </span>
                  <span className="git-file-path">
                    {parts.directory && <span>{parts.directory}</span>}
                    <strong>{parts.filename}</strong>
                  </span>
                  <span className="git-file-stats">
                    {file.additions !== null && (
                      <span data-zero={file.additions === 0 || undefined}>+{file.additions}</span>
                    )}
                    {file.deletions !== null && (
                      <span data-zero={file.deletions === 0 || undefined}>−{file.deletions}</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function FileDiffPanel({
  threadId,
  commit,
  details,
  initialPath,
  onBack,
}: {
  threadId: string;
  commit: GitCommitSummary;
  details: CommitDetails;
  initialPath: string;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [path, setPath] = useState(initialPath);
  const [patch, setPatch] = useState<CommitPatch | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(false);
  const fileIndex = Math.max(0, details.files.findIndex((file) => file.path === path));
  const file = details.files[fileIndex] ?? null;
  const filename = pathParts(path).filename || path;

  useEffect(() => {
    let active = true;
    setPatch(null);
    setPatchError(null);
    void rpc
      .call("patch", { threadId, hash: commit.hash, path })
      .then((result) => {
        if (active) setPatch(result);
      })
      .catch((error: unknown) => {
        if (active) setPatchError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [commit.hash, path, rpc, threadId]);

  return (
    <div className="git-history-panel git-diff-panel">
      <div className="git-diff-header">
        <Button
          variant="ghost"
          size="icon"
          className="git-icon-button"
          aria-label="Back to Git history"
          title="Back to Git history"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
        </Button>
        <div className="git-diff-title">
          <strong title={path}>{filename}</strong>
          <span title={commit.subject}>{commit.subject} · {commit.hash.slice(0, 7)}</span>
        </div>
        {file && (
          <div className="git-diff-stats">
            {file.additions !== null && <span>+{file.additions}</span>}
            {file.deletions !== null && <span>−{file.deletions}</span>}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="git-icon-button"
          aria-label="Wrap long lines"
          aria-pressed={wrapLines}
          title="Wrap long lines"
          onClick={() => setWrapLines((current) => !current)}
        >
          <Icon name="TextWrap" aria-hidden="true" />
        </Button>
      </div>

      <div className="git-file-strip" aria-label="Changed files">
        <span>{fileIndex + 1} / {details.files.length}</span>
        <div>
          {details.files.map((candidate) => {
            const candidateName = pathParts(candidate.path).filename || candidate.path;
            return (
              <button
                key={candidate.path}
                data-active={candidate.path === path || undefined}
                onClick={() => setPath(candidate.path)}
                title={candidate.path}
              >
                {candidateName}
              </button>
            );
          })}
        </div>
      </div>

      <div className="git-diff-body">
        {!patch && !patchError && (
          <div className="git-detail-loading" role="status">
            <Icon name="Loading" className="animate-spin" aria-hidden="true" />
            Loading diff
          </div>
        )}
        {patchError && <div className="git-inline-error" role="alert">{patchError}</div>}
        {patch?.patch && (
          <Diff
            patch={patch.patch}
            path={patch.path}
            overflow={wrapLines ? "wrap" : "scroll"}
          />
        )}
        {patch && !patch.patch && (
          <div className="git-empty-files">No textual diff for this file.</div>
        )}
        {patch?.truncated && (
          <div className="git-patch-note">Diff truncated at 1.5 MB.</div>
        )}
      </div>

      <div className="git-footer">
        <span>
          {((file?.additions ?? 0) + (file?.deletions ?? 0)).toLocaleString()} changed lines
        </span>
      </div>
    </div>
  );
}

function GitHistoryPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [query, setQuery] = useState("");
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<{
    commit: GitCommitSummary;
    details: CommitDetails;
    path: string;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadHistory = useCallback(
    async (reset: boolean) => {
      const sequence = ++requestSequence.current;
      const offset = reset ? 0 : commits.length;
      if (reset) {
        setInitialLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const result = await rpc.call("history", {
          threadId,
          offset,
          limit: PAGE_SIZE,
        });
        if (sequence !== requestSequence.current) return;
        setPage(result);
        setError(result.unavailableReason);
        setCommits((current) => {
          if (reset) return result.commits;
          const known = new Set(current.map((commit) => commit.hash));
          return [
            ...current,
            ...result.commits.filter((commit) => !known.has(commit.hash)),
          ];
        });
      } catch (loadError) {
        if (sequence === requestSequence.current) setError(errorMessage(loadError));
      } finally {
        if (sequence === requestSequence.current) {
          setInitialLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [commits.length, rpc, threadId],
  );

  useEffect(() => {
    setCommits([]);
    setPage(null);
    setExpandedHash(null);
    setDiffView(null);
    void loadHistory(true);
  }, [threadId]);

  useEffect(() => {
    if (expandedHash && !commits.some((commit) => commit.hash === expandedHash)) {
      setExpandedHash(null);
    }
  }, [commits, expandedHash]);

  const matchingCount = useMemo(
    () => commits.filter((commit) => commitMatches(commit, query)).length,
    [commits, query],
  );

  return (
    <div className="git-history-view-stack">
      <div
        className="git-history-panel"
        aria-hidden={diffView !== null}
        data-inactive={diffView !== null || undefined}
      >
      <div className="git-toolbar">
        <div className="git-repository">
          <strong>History</strong>
          <span title={`${page?.repoName ?? "Repository"} / ${page?.currentBranch ?? "Detached HEAD"}`}>
            {page?.repoName ?? "Repository"} / {page?.currentBranch ?? "Detached HEAD"}
          </span>
        </div>
        <div className="git-toolbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="git-icon-button"
            aria-label="Refresh Git history"
            title="Refresh Git history"
            disabled={initialLoading}
            onClick={() => void loadHistory(true)}
          >
            <Icon
              name={initialLoading ? "Loading" : "ArrowReloadHorizontal"}
              className={initialLoading ? "animate-spin" : ""}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      <div className="git-search-wrap">
        <Icon name="Search" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find in loaded commits"
          aria-label="Find in loaded commits"
        />
        {query && (
          <span className="git-search-count" role="status">
            {matchingCount.toLocaleString()} {matchingCount === 1 ? "match" : "matches"}
          </span>
        )}
      </div>

      {initialLoading && commits.length === 0 && (
        <div className="git-state" role="status">
          <Icon name="Loading" className="animate-spin" />
          <span>Reading all refs</span>
        </div>
      )}

      {error && commits.length === 0 && (
        <div className="git-state git-state-error" role="alert">
          <Icon name="AlertCircle" />
          <strong>Git history unavailable</strong>
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void loadHistory(true)}>
            Try again
          </Button>
        </div>
      )}

      {!initialLoading && !error && commits.length === 0 && (
        <div className="git-state" role="status">
          <Icon name="FolderGit" />
          <span>This repository has no reachable commits.</span>
        </div>
      )}

      {commits.length > 0 && (
        <CommitList
          threadId={threadId}
          commits={commits}
          hasMore={page?.hasMore ?? false}
          loadingMore={loadingMore}
          query={query}
          expandedHash={expandedHash}
          onLoadMore={() => void loadHistory(false)}
          onToggleCommit={(hash) => {
            setExpandedHash((current) => current === hash ? null : hash);
          }}
          onOpenDiff={(commit, details, path) => {
            setDiffView({ commit, details, path });
          }}
        />
      )}

      {commits.length > 0 && (
        <div className="git-footer">
          <span>{commits.length.toLocaleString()} commits</span>
          <span aria-hidden="true">·</span>
          <span>{page?.hasMore ? `${(page.total - commits.length).toLocaleString()} more` : "all loaded"}</span>
        </div>
      )}
      </div>
      {diffView && (
        <FileDiffPanel
          key={diffView.commit.hash}
          threadId={threadId}
          commit={diffView.commit}
          details={diffView.details}
          initialPath={diffView.path}
          onBack={() => setDiffView(null)}
        />
      )}
    </div>
  );
}

function GitHistoryHeaderAction({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { values } = useSettings();
  if (values?.showHeaderShortcut !== true) return null;

  return (
    <button
      className="git-header-action"
      aria-label="Open Git history"
      title="Open Git history"
      onClick={() => {
        const opened = navigate.openThreadPanel({
          actionId: "history",
          title: "Git History",
        });
        if (!opened) toast.error("Git History could not open on this panel.");
      }}
      data-thread-id={threadId}
    >
      <Icon name="FolderGit" aria-hidden="true" />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "history",
    title: "Git History",
    icon: "FolderGit",
    component: GitHistoryPanel,
    layout: "flush",
  });

  app.slots.experimental_threadHeaderAction({
    id: "git-history",
    title: "Git History",
    component: GitHistoryHeaderAction,
  });
});
