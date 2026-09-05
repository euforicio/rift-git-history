import { describe, expect, it, vi } from "vitest";
import type { GitCommitSummary, HistoryPage } from "./contracts";
import { fetchHistorySnapshot } from "./history-refresh";

function commit(index: number): GitCommitSummary {
  return {
    hash: index.toString(16).padStart(40, "0"),
    parents: [],
    authorName: "History Test",
    authorEmail: "history@example.com",
    authorDate: "2026-01-01T00:00:00Z",
    committerDate: "2026-01-01T00:00:00Z",
    subject: `Commit ${index}`,
    refs: [],
  };
}

describe("fetchHistorySnapshot", () => {
  it("reloads every page needed to preserve the loaded commit count", async () => {
    const commits = Array.from({ length: 650 }, (_, index) => commit(index));
    const fetchPage = vi.fn(async (offset: number, limit: number): Promise<HistoryPage> => ({
      repoName: "history",
      currentBranch: "main",
      uncommittedFiles: [],
      commits: commits.slice(offset, offset + limit),
      offset,
      total: commits.length,
      hasMore: offset + limit < commits.length,
      revision: "revision-1",
      unavailableReason: null,
    }));

    const result = await fetchHistorySnapshot(fetchPage, 450, 200);

    expect(fetchPage.mock.calls).toEqual([
      [0, 200],
      [200, 200],
      [400, 50],
    ]);
    expect(result.commits).toEqual(commits.slice(0, 450));
    expect(result.hasMore).toBe(true);
  });

  it("restarts instead of combining pages from different revisions", async () => {
    const before = Array.from({ length: 4 }, (_, index) => commit(index));
    const after = Array.from({ length: 5 }, (_, index) => commit(index + 10));
    let changed = false;
    const fetchPage = vi.fn(async (offset: number, limit: number): Promise<HistoryPage> => {
      if (offset > 0 && !changed) {
        changed = true;
        return {
          repoName: "history",
          currentBranch: "main",
          uncommittedFiles: [],
          commits: after.slice(offset, offset + limit),
          offset,
          total: after.length,
          hasMore: offset + limit < after.length,
          revision: "revision-2",
          unavailableReason: null,
        };
      }
      const source = changed ? after : before;
      return {
        repoName: "history",
        currentBranch: "main",
        uncommittedFiles: [],
        commits: source.slice(offset, offset + limit),
        offset,
        total: source.length,
        hasMore: offset + limit < source.length,
        revision: changed ? "revision-2" : "revision-1",
        unavailableReason: null,
      };
    });

    const result = await fetchHistorySnapshot(fetchPage, 3, 2);

    expect(fetchPage.mock.calls).toEqual([
      [0, 2],
      [2, 1],
      [0, 2],
      [2, 1],
    ]);
    expect(result.commits).toEqual(after.slice(0, 3));
    expect(result.revision).toBe("revision-2");
  });
});
