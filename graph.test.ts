import { describe, expect, it } from "vitest";
import type { GitCommitSummary } from "./contracts";
import { layoutCommitGraph } from "./graph";

function commit(hash: string, parents: string[]): GitCommitSummary {
  return {
    hash,
    parents,
    authorName: "Test",
    authorEmail: "test@example.com",
    authorDate: "2026-01-01T00:00:00Z",
    committerDate: "2026-01-01T00:00:00Z",
    subject: hash,
    refs: [],
  };
}

describe("layoutCommitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutCommitGraph([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);

    expect(rows.map((row) => row.commitLane)).toEqual([0, 0, 0]);
    expect(rows[0]?.edges).toEqual([
      { fromLane: 0, toLane: 0, kind: "straight" },
    ]);
  });

  it("opens and rejoins a merge lane", () => {
    const rows = layoutCommitGraph([
      commit("merge", ["main", "feature"]),
      commit("feature", ["base"]),
      commit("main", ["base"]),
      commit("base", []),
    ]);

    expect(rows[0]?.edges).toEqual([
      { fromLane: 0, toLane: 0, kind: "straight" },
      { fromLane: 0, toLane: 1, kind: "merge" },
    ]);
    expect(rows[1]?.commitLane).toBe(1);
    expect(rows[2]?.commitLane).toBe(0);
  });

  it("allocates independent tips without overwriting active lanes", () => {
    const rows = layoutCommitGraph([
      commit("tip-a", ["root-a"]),
      commit("tip-b", ["root-b"]),
      commit("root-a", []),
      commit("root-b", []),
    ]);

    expect(rows[0]?.commitLane).toBe(0);
    expect(rows[1]?.commitLane).toBe(1);
  });
});
