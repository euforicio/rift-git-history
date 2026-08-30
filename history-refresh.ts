import type { HistoryPage } from "./contracts";

type FetchHistoryPage = (offset: number, limit: number) => Promise<HistoryPage>;

export async function fetchHistorySnapshot(
  fetchPage: FetchHistoryPage,
  minimumCommitCount: number,
  pageSize: number,
): Promise<HistoryPage> {
  const firstPage = await fetchPage(0, pageSize);
  if (
    firstPage.unavailableReason
    || !firstPage.hasMore
    || firstPage.commits.length >= minimumCommitCount
  ) {
    return firstPage;
  }

  const commits = [...firstPage.commits];
  const known = new Set(commits.map((commit) => commit.hash));
  let offset = firstPage.commits.length;
  let latestPage = firstPage;

  while (latestPage.hasMore && commits.length < minimumCommitCount) {
    const limit = Math.min(pageSize, minimumCommitCount - commits.length);
    latestPage = await fetchPage(offset, limit);
    const fetchedCount = latestPage.commits.length;

    for (const commit of latestPage.commits) {
      if (known.has(commit.hash)) continue;
      known.add(commit.hash);
      commits.push(commit);
    }

    offset += fetchedCount;
    if (fetchedCount === 0 || latestPage.unavailableReason) break;
  }

  return {
    ...firstPage,
    commits,
    total: latestPage.total,
    hasMore: latestPage.hasMore,
    unavailableReason: latestPage.unavailableReason,
  };
}
