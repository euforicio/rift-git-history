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
const ROW_HEIGHT = 36;
const LANE_GAP = 16;
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
          {ref.isHead && <Icon name="Target" aria-hidden="true" />}
          {ref.name}
        </span>
      ))}
      {refs.length > limit && (
        <span className="git-ref git-ref-muted">+{refs.length - limit}</span>
      )}
    </span>
  );
}

function laneX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_GAP;
}

function laneClass(lane: number): string {
  return `git-lane-${lane % 6}`;
}

function GraphCell({
  row,
  width,
  isMerge,
  isHead,
}: {
  row: GraphRow;
  width: number;
  isMerge: boolean;
  isHead: boolean;
}) {
  const middle = ROW_HEIGHT / 2;
  const emphasized = isMerge || isHead;
  return (
    <svg
      className="git-graph-cell"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.topLanes.map((lane) => (
        <line
          key={`top-${lane}`}
          className={laneClass(lane)}
          x1={laneX(lane)}
          y1={0}
          x2={laneX(lane)}
          y2={middle}
        />
      ))}
      {!row.startsHere && (
        <line
          className={laneClass(row.commitLane)}
          x1={laneX(row.commitLane)}
          y1={0}
          x2={laneX(row.commitLane)}
          y2={middle}
        />
      )}
      {row.bottomLanes.map((lane) => (
        <line
          key={`bottom-${lane}`}
          className={laneClass(lane)}
          x1={laneX(lane)}
          y1={middle}
          x2={laneX(lane)}
          y2={ROW_HEIGHT}
        />
      ))}
      {row.edges.map((edge, index) => {
        const fromX = laneX(edge.fromLane);
        const toX = laneX(edge.toLane);
        if (edge.kind === "straight") {
          return (
            <line
              key={`edge-${index}`}
              className={laneClass(edge.toLane)}
              x1={fromX}
              y1={middle}
              x2={toX}
              y2={ROW_HEIGHT}
            />
          );
        }
        return (
          <path
            key={`edge-${index}`}
            className={laneClass(edge.toLane)}
            d={`M ${fromX} ${middle} C ${fromX} ${middle + 8}, ${toX} ${middle + 7}, ${toX} ${ROW_HEIGHT}`}
          />
        );
      })}
      <circle
        className={`${laneClass(row.commitLane)} git-commit-node ${emphasized ? "git-commit-node-ring" : "git-commit-node-solid"}`}
        cx={laneX(row.commitLane)}
        cy={middle}
        r={emphasized ? 5.25 : 4.25}
      />
      {isMerge && (
        <circle
          className={`${laneClass(row.commitLane)} git-commit-node-core`}
          cx={laneX(row.commitLane)}
          cy={middle}
          r={1.7}
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
  commits,
  hasMore,
  loadingMore,
  query,
  onLoadMore,
  onSelect,
}: {
  commits: GitCommitSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  query: string;
  onLoadMore: () => void;
  onSelect: (commit: GitCommitSummary) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const graphRows = useMemo(() => layoutCommitGraph(commits), [commits]);
  const matches = useMemo(
    () => commits.map((commit) => commitMatches(commit, query)),
    [commits, query],
  );
  const maxLaneCount = graphRows.reduce(
    (maximum, row) => Math.max(maximum, row.laneCount),
    1,
  );
  const graphWidth = Math.min(
    160,
    Math.max(44, GRAPH_PADDING * 2 + (maxLaneCount - 1) * LANE_GAP),
  );
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? 0;

  useEffect(() => {
    if (hasMore && !loadingMore && lastVisibleIndex >= commits.length - 30) {
      onLoadMore();
    }
  }, [commits.length, hasMore, lastVisibleIndex, loadingMore, onLoadMore]);

  useEffect(() => {
    if (!query.trim()) return;
    const firstMatch = matches.indexOf(true);
    if (firstMatch >= 0) virtualizer.scrollToIndex(firstMatch, { align: "center" });
  }, [matches, query, virtualizer]);

  return (
    <div className="git-history-scroll" ref={scrollRef} role="list">
      <div
        className="git-history-virtual"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualRow) => {
          const commit = commits[virtualRow.index];
          const graphRow = graphRows[virtualRow.index];
          if (!commit || !graphRow) return null;
          const isMerge = commit.parents.length > 1;
          const isHead = commit.refs.some((ref) => ref.isHead);
          return (
            <button
              className={`git-commit-row ${matches[virtualRow.index] ? "git-commit-match" : ""}`}
              data-head={isHead || undefined}
              data-merge={isMerge || undefined}
              key={commit.hash}
              onClick={() => onSelect(commit)}
              role="listitem"
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <GraphCell
                row={graphRow}
                width={graphWidth}
                isMerge={isMerge}
                isHead={isHead}
              />
              <span className="git-commit-copy">
                <span className="git-commit-subject" title={commit.subject}>
                  {commit.subject || "No commit message"}
                </span>
                <RefPills refs={commit.refs} />
                <span className="git-commit-inline-meta">
                  <span className="git-commit-author">{commit.authorName}</span>
                  <time dateTime={commit.authorDate}>{relativeTime(commit.authorDate)}</time>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {loadingMore && (
        <div className="git-loading-more">
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

function CommitDetail({
  threadId,
  commit,
  onBack,
}: {
  threadId: string;
  commit: GitCommitSummary;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<CommitPatch | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);

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

  const openFile = useCallback(
    async (path: string) => {
      setSelectedFile(path);
      setPatch(null);
      setPatchLoading(true);
      try {
        const result = await rpc.call("patch", {
          threadId,
          hash: commit.hash,
          path,
        });
        setPatch(result);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setPatchLoading(false);
      }
    },
    [commit.hash, rpc, threadId],
  );

  return (
    <div className="git-detail">
      <div className="git-detail-header">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Back to Git history"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" />
        </Button>
        <span className="git-detail-header-title">Commit</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Copy commit hash"
          onClick={() => {
            void navigator.clipboard.writeText(commit.hash).then(() => {
              toast.success("Commit hash copied");
            });
          }}
        >
          <Icon name="Copy" />
        </Button>
      </div>

      <div className="git-detail-scroll">
        <section className="git-detail-summary">
          <RefPills refs={commit.refs} limit={8} />
          <h2>{commit.subject || "No commit message"}</h2>
          <div className="git-detail-byline">
            <span>{commit.authorName}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={commit.authorDate}>
              {new Date(commit.authorDate).toLocaleString()}
            </time>
          </div>
          <button
            className="git-detail-hash"
            onClick={() => void navigator.clipboard.writeText(commit.hash)}
          >
            {commit.hash}
          </button>
          {details?.body && details.body.trim() !== commit.subject.trim() && (
            <pre className="git-commit-body">{details.body.trim()}</pre>
          )}
        </section>

        {detailsError && <div className="git-inline-error">{detailsError}</div>}
        {!details && !detailsError && (
          <div className="git-detail-loading">
            <Icon name="Loading" className="animate-spin" />
            Loading commit details
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
            {details.files.map((file) => (
              <button
                className={`git-file-row ${selectedFile === file.path ? "git-file-selected" : ""}`}
                key={file.path}
                onClick={() => void openFile(file.path)}
              >
                <span className={`git-file-status git-file-status-${file.status}`}>
                  {statusLetter(file.status)}
                </span>
                <span className="git-file-path">{file.path}</span>
                <span className="git-file-stats">
                  {file.additions !== null && <span>+{file.additions}</span>}
                  {file.deletions !== null && <span>−{file.deletions}</span>}
                </span>
              </button>
            ))}
          </section>
        )}

        {selectedFile && (
          <section className="git-patch">
            <div className="git-section-heading">
              <span>{selectedFile}</span>
            </div>
            {patchLoading && (
              <div className="git-detail-loading">
                <Icon name="Loading" className="animate-spin" />
                Loading diff
              </div>
            )}
            {patch && patch.patch && (
              <Diff patch={patch.patch} path={patch.path} overflow="scroll" />
            )}
            {patch && !patch.patch && (
              <div className="git-empty-files">No textual diff for this file.</div>
            )}
            {patch?.truncated && (
              <div className="git-patch-note">Diff truncated at 1.5 MB.</div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function GitHistoryPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitCommitSummary | null>(null);
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
    setSelected(null);
    void loadHistory(true);
  }, [threadId]);

  const matchingCount = useMemo(
    () => commits.filter((commit) => commitMatches(commit, query)).length,
    [commits, query],
  );

  if (selected) {
    return (
      <CommitDetail
        threadId={threadId}
        commit={selected}
        onBack={() => setSelected(null)}
      />
    );
  }

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
            disabled={initialLoading}
            onClick={() => void loadHistory(true)}
          >
            <Icon name={initialLoading ? "Loading" : "ArrowReloadHorizontal"} className={initialLoading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <div className="git-search-wrap">
        <Icon name="Search" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commits"
          aria-label="Find a loaded commit"
        />
        {query && (
          <span className="git-search-count">{matchingCount}</span>
        )}
      </div>

      {initialLoading && commits.length === 0 && (
        <div className="git-state">
          <Icon name="Loading" className="animate-spin" />
          <span>Reading all refs</span>
        </div>
      )}

      {error && commits.length === 0 && (
        <div className="git-state git-state-error">
          <Icon name="AlertCircle" />
          <strong>Git history unavailable</strong>
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void loadHistory(true)}>
            Try again
          </Button>
        </div>
      )}

      {!initialLoading && !error && commits.length === 0 && (
        <div className="git-state">
          <Icon name="FolderGit" />
          <span>This repository has no reachable commits.</span>
        </div>
      )}

      {commits.length > 0 && (
        <CommitList
          commits={commits}
          hasMore={page?.hasMore ?? false}
          loadingMore={loadingMore}
          query={query}
          onLoadMore={() => void loadHistory(false)}
          onSelect={setSelected}
        />
      )}

      <div className="git-footer">
        <span>{(page?.total ?? 0).toLocaleString()} commits</span>
        <span>All refs</span>
      </div>
    </div>
  );
}

function GitHistoryHeaderAction({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      className="git-header-action"
      aria-label="Open Git history"
      onClick={() => {
        const opened = navigate.openThreadPanel({
          actionId: "history",
          title: "Git History",
        });
        if (!opened) toast.error("Git History could not open on this panel.");
      }}
      data-thread-id={threadId}
    >
      <Icon name="FolderGit" />
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
