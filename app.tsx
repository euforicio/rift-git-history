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
import { layoutCommitGraph, type GraphRow } from "./graph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import "./app.css";

const PAGE_SIZE = 200;
const COMMIT_ROW_HEIGHT = 31;
const DATE_HEADER_HEIGHT = 24;
const GRAPH_WIDTH = 38;
const GRAPH_PADDING = 12;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Git history could not be loaded.";
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown date";
  const seconds = Math.round((time - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  if (absolute < 2_592_000) return formatter.format(Math.round(seconds / 86_400), "day");
  if (absolute < 31_536_000) return formatter.format(Math.round(seconds / 2_592_000), "month");
  return formatter.format(Math.round(seconds / 31_536_000), "year");
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
      key: `date-${group.key}`,
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

function laneX(lane: number, laneGap: number): number {
  return GRAPH_PADDING + lane * laneGap;
}

function laneClass(lane: number): string {
  return `git-lane-${lane % 6}`;
}

function GraphCell({
  row,
  width,
  laneGap,
  rowHeight,
  isMerge,
  isHead,
}: {
  row: GraphRow;
  width: number;
  laneGap: number;
  rowHeight: number;
  isMerge: boolean;
  isHead: boolean;
}) {
  const middle = rowHeight / 2;
  const emphasized = isMerge || isHead;
  const nodeRadius = emphasized
    ? Math.min(5.25, Math.max(3.25, laneGap * 0.42))
    : Math.min(4.25, Math.max(2.5, laneGap * 0.34));
  return (
    <svg
      className="git-graph-cell"
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${width} ${rowHeight}`}
      aria-hidden="true"
    >
      {row.topLanes.map((lane) => (
        <line
          key={`top-${lane}`}
          className={laneClass(lane)}
          x1={laneX(lane, laneGap)}
          y1={0}
          x2={laneX(lane, laneGap)}
          y2={middle}
        />
      ))}
      {!row.startsHere && (
        <line
          className={laneClass(row.commitLane)}
          x1={laneX(row.commitLane, laneGap)}
          y1={0}
          x2={laneX(row.commitLane, laneGap)}
          y2={middle}
        />
      )}
      {row.bottomLanes.map((lane) => (
        <line
          key={`bottom-${lane}`}
          className={laneClass(lane)}
          x1={laneX(lane, laneGap)}
          y1={middle}
          x2={laneX(lane, laneGap)}
          y2={rowHeight}
        />
      ))}
      {row.edges.map((edge, index) => {
        const fromX = laneX(edge.fromLane, laneGap);
        const toX = laneX(edge.toLane, laneGap);
        if (edge.kind === "straight") {
          return (
            <line
              key={`edge-${index}`}
              className={laneClass(edge.toLane)}
              x1={fromX}
              y1={middle}
              x2={toX}
              y2={rowHeight}
            />
          );
        }
        return (
          <path
            key={`edge-${index}`}
            className={laneClass(edge.toLane)}
            d={`M ${fromX} ${middle} C ${fromX} ${middle + 8}, ${toX} ${middle + 7}, ${toX} ${rowHeight}`}
          />
        );
      })}
      <circle
        className={`${laneClass(row.commitLane)} git-commit-node ${emphasized ? "git-commit-node-ring" : "git-commit-node-solid"}`}
        cx={laneX(row.commitLane, laneGap)}
        cy={middle}
        r={nodeRadius}
      />
      {isMerge && (
        <circle
          className={`${laneClass(row.commitLane)} git-commit-node-core`}
          cx={laneX(row.commitLane, laneGap)}
          cy={middle}
          r={Math.max(1.25, nodeRadius * 0.32)}
        />
      )}
    </svg>
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
  onLoadMore,
}: {
  threadId: string;
  commits: GitCommitSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  query: string;
  onLoadMore: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const listItems = useMemo(() => historyListItems(commits), [commits]);
  const graphRows = useMemo(() => layoutCommitGraph(commits), [commits]);
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
  let activeDate: Extract<HistoryListItem, { kind: "date" }> | null = null;
  for (let index = virtualItems[0]?.index ?? 0; index >= 0; index -= 1) {
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

  useEffect(() => {
    if (expandedHash && !commits.some((commit) => commit.hash === expandedHash)) {
      setExpandedHash(null);
    }
  }, [commits, expandedHash]);

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
            style={{ transform: `translateY(${virtualizer.scrollOffset ?? 0}px)` }}
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
          const graphRow = graphRows[commitIndex];
          if (!graphRow) return null;
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
                className={`git-commit-row ${matches[virtualRow.index] ? "git-commit-match" : ""}`}
                aria-controls={expansionId}
                aria-expanded={isExpanded}
                data-head={isHead || undefined}
                data-merge={isMerge || undefined}
                data-expanded={isExpanded || undefined}
                onClick={() => {
                  setExpandedHash((current) => current === commit.hash ? null : commit.hash);
                }}
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
                  graphWidth={GRAPH_WIDTH}
                  graphRow={graphRow}
                  laneGap={16}
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
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    case "modified":
      return "M";
    default:
      return "?";
  }
}

function InlineCommitFiles({
  id,
  threadId,
  commit,
  graphWidth,
  graphRow,
  laneGap,
}: {
  id: string;
  threadId: string;
  commit: GitCommitSummary;
  graphWidth: number;
  graphRow: GraphRow;
  laneGap: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<CommitPatch | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);
  const patchRequest = useRef(0);

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

  useEffect(() => () => {
    patchRequest.current += 1;
  }, []);

  const toggleFile = useCallback(
    async (path: string) => {
      if (selectedFile === path) {
        patchRequest.current += 1;
        setSelectedFile(null);
        setPatch(null);
        setPatchLoading(false);
        return;
      }

      const sequence = ++patchRequest.current;
      setSelectedFile(path);
      setPatch(null);
      setPatchLoading(true);
      try {
        const result = await rpc.call("patch", {
          threadId,
          hash: commit.hash,
          path,
        });
        if (sequence === patchRequest.current) setPatch(result);
      } catch (error) {
        if (sequence === patchRequest.current) toast.error(errorMessage(error));
      } finally {
        if (sequence === patchRequest.current) setPatchLoading(false);
      }
    },
    [commit.hash, rpc, selectedFile, threadId],
  );

  return (
    <div
      className="git-commit-expansion"
      id={id}
      role="region"
      aria-label={`Files changed in ${commit.subject || commit.hash.slice(0, 8)}`}
      style={{ marginLeft: `${graphWidth}px` }}
    >
      <svg
        className="git-expansion-graph"
        width={graphWidth}
        height="100%"
        aria-hidden="true"
      >
        {graphRow.bottomLanes.map((lane) => (
          <line
            key={lane}
            className={laneClass(lane)}
            x1={laneX(lane, laneGap)}
            y1="0"
            x2={laneX(lane, laneGap)}
            y2="100%"
          />
        ))}
      </svg>
      {detailsError && <div className="git-inline-error" role="alert">{detailsError}</div>}
      {!details && !detailsError && (
        <div className="git-detail-loading" role="status">
          <Icon name="Loading" className="animate-spin" />
          Loading changed files
        </div>
      )}

      {details && (
        <section className="git-files">
          <div className="git-section-heading">
            <span>Files changed</span>
            <span>{details.files.length}</span>
          </div>
          {details.files.length === 0 && (
            <div className="git-empty-files">No file changes to show.</div>
          )}
          {details.files.map((file, index) => {
            const isFileExpanded = selectedFile === file.path;
            const patchId = `git-file-patch-${commit.hash}-${index}`;
            return (
              <div className="git-inline-file" key={file.path}>
                <button
                  className={`git-file-row ${isFileExpanded ? "git-file-selected" : ""}`}
                  aria-controls={patchId}
                  aria-expanded={isFileExpanded}
                  onClick={() => void toggleFile(file.path)}
                  title={isFileExpanded ? "Collapse file diff" : "Show file diff"}
                >
                  <span className={`git-file-status git-file-status-${file.status}`}>
                    <span className="sr-only">{file.status}</span>
                    {statusLetter(file.status)}
                  </span>
                  <span className="git-file-path">{file.path}</span>
                  <span className="git-file-stats">
                    {file.additions !== null && <span>+{file.additions}</span>}
                    {file.deletions !== null && <span>−{file.deletions}</span>}
                  </span>
                  <Icon name="ChevronRight" className="git-file-expand-icon" aria-hidden="true" />
                </button>
                {isFileExpanded && (
                  <div className="git-inline-patch" id={patchId}>
                    {patchLoading && (
                      <div className="git-detail-loading" role="status">
                        <Icon name="Loading" className="animate-spin" />
                        Loading diff
                      </div>
                    )}
                    {patch && patch.patch && (
                      <div className="git-inline-patch-content">
                        <Diff patch={patch.patch} path={patch.path} overflow="scroll" />
                      </div>
                    )}
                    {patch && !patch.patch && (
                      <div className="git-empty-files">No textual diff for this file.</div>
                    )}
                    {patch?.truncated && (
                      <div className="git-patch-note">Diff truncated at 1.5 MB.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function GitHistoryPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [query, setQuery] = useState("");
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
    void loadHistory(true);
  }, [threadId]);

  const matchingCount = useMemo(
    () => commits.filter((commit) => commitMatches(commit, query)).length,
    [commits, query],
  );

  return (
    <div className="git-history-panel">
      <div className="git-toolbar">
        <div className="git-repository">
          <strong>Graph</strong>
        </div>
        <div className="git-toolbar-actions">
          <span
            className="git-history-scope"
            title={`${page?.repoName ?? "Repository"} · ${page?.currentBranch ?? "Detached HEAD"}`}
          >
            All refs
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
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
          onLoadMore={() => void loadHistory(false)}
        />
      )}

      {commits.length > 0 && (
        <div className="git-footer">
          <span>
            {commits.length.toLocaleString()} of {(page?.total ?? commits.length).toLocaleString()} commits loaded
          </span>
        </div>
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
