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
});
