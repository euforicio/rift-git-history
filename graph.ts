import type { GitCommitSummary } from "./contracts";

export interface GraphEdge {
  fromLane: number;
  toLane: number;
  kind: "straight" | "merge";
}

export interface GraphRow {
  commitLane: number;
  laneCount: number;
  topLanes: number[];
  bottomLanes: number[];
  edges: GraphEdge[];
  startsHere: boolean;
}

function firstOpenLane(lanes: Array<string | null>): number {
  const open = lanes.indexOf(null);
  if (open >= 0) return open;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Assign stable lanes to commits in Git's topological, newest-first order.
 * The output contains only drawing instructions, so the React view can
 * virtualize rows without keeping layout state in mounted components.
 */
export function layoutCommitGraph(commits: GitCommitSummary[]): GraphRow[] {
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    let commitLane = lanes.indexOf(commit.hash);
    const startsHere = commitLane < 0;

    if (startsHere) {
      commitLane = firstOpenLane(lanes);
      lanes[commitLane] = commit.hash;
    }

    const topLanes = lanes
      .map((value, lane) => (value === null ? -1 : lane))
      .filter((lane) => lane >= 0 && lane !== commitLane);
    const edges: GraphEdge[] = [];
    const next = [...lanes];
    next[commitLane] = null;

    commit.parents.forEach((parentHash, parentIndex) => {
      let targetLane = next.indexOf(parentHash);

      if (targetLane < 0) {
        if (parentIndex === 0 && next[commitLane] === null) {
          targetLane = commitLane;
        } else {
          targetLane = firstOpenLane(next);
        }
        next[targetLane] = parentHash;
      }

      edges.push({
        fromLane: commitLane,
        toLane: targetLane,
        kind: targetLane === commitLane ? "straight" : "merge",
      });
    });

    while (next.length > 0 && next.at(-1) === null) next.pop();

    const bottomLanes = next
      .map((value, lane) => (value === null ? -1 : lane))
      .filter((lane) => lane >= 0 && !edges.some((edge) => edge.toLane === lane));
    const laneCount = Math.max(lanes.length, next.length, commitLane + 1);

    rows.push({
      commitLane,
      laneCount,
      topLanes,
      bottomLanes,
      edges,
      startsHere,
    });

    lanes.splice(0, lanes.length, ...next);
  }

  return rows;
}
