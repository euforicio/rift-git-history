import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

describe("Git history host entry", () => {
  let repo = "";
  let mergeHash = "";
  let checkpointHash = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "bb-git-history-test-"));
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "History Test");
    git(repo, "config", "user.email", "history@example.com");

    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base commit");
    const baseHash = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-b", "feature");
    writeFileSync(join(repo, "feature.txt"), "feature line\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-m", "feature commit");

    git(repo, "checkout", "main");
    writeFileSync(join(repo, "main.txt"), "main line\n");
    git(repo, "add", "main.txt");
    git(repo, "commit", "-m", "main commit");
    git(repo, "merge", "--no-ff", "feature", "-m", "merge feature");
    mergeHash = git(repo, "rev-parse", "HEAD");
    git(repo, "tag", "v1.0.0");

    git(repo, "checkout", "-b", "side", baseHash);
    writeFileSync(join(repo, "side.txt"), "side line\n");
    git(repo, "add", "side.txt");
    git(repo, "commit", "-m", "side only");
    git(repo, "checkout", "main");

    git(repo, "checkout", "-b", "checkpoint");
    git(repo, "commit", "--allow-empty", "-m", "t3 checkpoint ref=refs/t3/checkpoints/test");
    checkpointHash = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/t3/checkpoints/test", checkpointHash);
    git(repo, "update-ref", "refs/t3/checkpoints/shared", mergeHash);
    git(repo, "checkout", "main");
    git(repo, "branch", "-D", "checkpoint");
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("pages commits reachable from every ref", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const first = await harness.experimental_call("history", {
      repoPath: repo,
      offset: 0,
      limit: 2,
    });
    const all = await harness.experimental_call("history", {
      repoPath: repo,
      offset: 0,
      limit: 20,
    });

    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(all.total).toBe(5);
    expect(all.currentBranch).toBe("main");
    expect(all.commits.map((commit) => commit.subject)).toContain("side only");
    expect(all.commits.map((commit) => commit.hash)).not.toContain(checkpointHash);
    expect(
      all.commits.find((commit) => commit.hash === mergeHash)?.refs.map((ref) => ref.name),
    ).toEqual(expect.arrayContaining(["main", "v1.0.0"]));
    expect(
      all.commits.find((commit) => commit.hash === mergeHash)?.refs.map((ref) => ref.fullName),
    ).not.toContain("refs/t3/checkpoints/shared");

    await harness.experimental_dispose();
  });

  it("loads first-parent file details and a patch", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const details = await harness.experimental_call("details", {
      repoPath: repo,
      hash: mergeHash,
    });
    const patch = await harness.experimental_call("patch", {
      repoPath: repo,
      hash: mergeHash,
      path: "feature.txt",
    });

    expect(details.subject).toBe("merge feature");
    expect(details.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "feature.txt", status: "added" }),
      ]),
    );
    expect(patch.patch).toContain("feature line");
    expect(patch.truncated).toBe(false);

    await harness.experimental_dispose();
  });
});
