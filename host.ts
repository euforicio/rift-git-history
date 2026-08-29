import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type {
  CommitDetails,
  GitCommitSummary,
  GitFileChange,
  GitRef,
} from "./contracts";
import { hostContract } from "./contracts";

const HISTORY_FIELD_COUNT = 8;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_CHARS = 1_500_000;
const HIDDEN_REF_NAMESPACES = ["refs/t3/checkpoints"] as const;
const VISIBLE_HISTORY_REVISIONS = [
  "--exclude=refs/t3/checkpoints",
  "--exclude=refs/t3/checkpoints/*",
  "--all",
] as const;

function isHiddenRef(fullName: string): boolean {
  return HIDDEN_REF_NAMESPACES.some(
    (namespace) => fullName === namespace || fullName.startsWith(`${namespace}/`),
  );
}

function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function runGitOptional(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(cwd, args, signal);
  } catch {
    return null;
  }
}

function assertObjectName(hash: string): void {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    throw new Error("Git returned an invalid commit hash.");
  }
}

async function resolveRepository(
  repoPath: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isAbsolute(repoPath)) {
    throw new Error("The thread environment does not have an absolute path.");
  }

  const inside = (
    await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], signal)
  ).trim();
  if (inside !== "true") {
    throw new Error("The thread environment is not inside a Git repository.");
  }

  return (
    await runGit(repoPath, ["rev-parse", "--show-toplevel"], signal)
  ).trim();
}

function refKind(fullName: string): GitRef["kind"] {
  if (fullName.startsWith("refs/heads/")) return "local";
  if (fullName.startsWith("refs/remotes/")) return "remote";
  if (fullName.startsWith("refs/tags/")) return "tag";
  if (fullName === "refs/stash") return "stash";
  return "other";
}

function shortRefName(fullName: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/", "refs/tags/"]) {
    if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
  }
  if (fullName === "refs/stash") return "stash";
  return fullName.replace(/^refs\//, "");
}

function refPriority(ref: GitRef): number {
  if (ref.isHead) return 0;
  if (ref.kind === "local") return 1;
  if (ref.kind === "tag") return 2;
  if (ref.kind === "remote") return 3;
  if (ref.kind === "stash") return 4;
  return 5;
}

async function readRefs(
  repoRoot: string,
  signal: AbortSignal,
): Promise<{
  byHash: Map<string, GitRef[]>;
  currentBranch: string | null;
}> {
  const [rawRefs, rawHead, rawBranch] = await Promise.all([
    runGit(
      repoRoot,
      [
        "for-each-ref",
        "--format=%(objectname)%00%(*objectname)%00%(refname)%00",
      ],
      signal,
    ),
    runGitOptional(repoRoot, ["rev-parse", "HEAD"], signal),
    runGitOptional(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], signal),
  ]);

  const currentBranchRef = rawBranch?.trim() || null;
  const currentBranch = currentBranchRef
    ? shortRefName(currentBranchRef)
    : null;
  const byHash = new Map<string, GitRef[]>();
  const fields = rawRefs.split("\0");

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const objectHash = fields[index]?.trim();
    const peeledHash = fields[index + 1]?.trim();
    const fullName = fields[index + 2]?.trim();
    if (!objectHash || !fullName) continue;
    if (isHiddenRef(fullName)) continue;

    const hash = peeledHash || objectHash;
    const ref: GitRef = {
      fullName,
      name: shortRefName(fullName),
      kind: refKind(fullName),
      isHead: fullName === currentBranchRef,
    };
    const refs = byHash.get(hash) ?? [];
    refs.push(ref);
    byHash.set(hash, refs);
  }

  const headHash = rawHead?.trim();
  if (headHash) {
    const refs = byHash.get(headHash) ?? [];
    if (!refs.some((ref) => ref.isHead)) {
      refs.push({
        fullName: "HEAD",
        name: "HEAD",
        kind: "other",
        isHead: true,
      });
    }
    byHash.set(headHash, refs);
  }

  for (const refs of byHash.values()) {
    refs.sort((left, right) => {
      const priority = refPriority(left) - refPriority(right);
      return priority || left.name.localeCompare(right.name);
    });
  }

  return { byHash, currentBranch };
}

function parseCommitFields(
  raw: string,
  refsByHash: Map<string, GitRef[]>,
): Array<GitCommitSummary & { body: string }> {
  const fields = raw.split("\0");
  const commits: Array<GitCommitSummary & { body: string }> = [];

  for (
    let index = 0;
    index + HISTORY_FIELD_COUNT - 1 < fields.length;
    index += HISTORY_FIELD_COUNT
  ) {
    const hash = fields[index]?.trim();
    if (!hash) continue;
    const parentField = fields[index + 1] ?? "";
    const body = fields[index + 7] ?? "";

    commits.push({
      hash,
      parents: parentField ? parentField.split(" ").filter(Boolean) : [],
      authorName: fields[index + 2] ?? "",
      authorEmail: fields[index + 3] ?? "",
      authorDate: fields[index + 4] ?? "",
      committerDate: fields[index + 5] ?? "",
      subject: fields[index + 6] ?? "",
      refs: refsByHash.get(hash) ?? [],
      body,
    });
  }

  return commits;
}

const HISTORY_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s", "%B"].join(
  "%x00",
) + "%x00";

function statusName(code: string): GitFileChange["status"] {
  switch (code.at(0)) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    default:
      return "unknown";
  }
}

function parseNameStatus(raw: string): Map<string, GitFileChange["status"]> {
  const tokens = raw.split("\0").filter(Boolean);
  const statuses = new Map<string, GitFileChange["status"]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.includes("\t")) {
      const [code, ...pathParts] = token.split("\t");
      const path = pathParts.join("\t");
      if (path) statuses.set(path, statusName(code ?? ""));
      continue;
    }

    const path = tokens[index + 1];
    if (!path) continue;
    statuses.set(path, statusName(token));
    index += 1;
  }

  return statuses;
}

function parseNumStat(
  raw: string,
  statuses: Map<string, GitFileChange["status"]>,
): GitFileChange[] {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [rawAdditions, rawDeletions, ...pathParts] = record.split("\t");
      const path = pathParts.join("\t");
      const additions = Number.parseInt(rawAdditions ?? "", 10);
      const deletions = Number.parseInt(rawDeletions ?? "", 10);
      return {
        path,
        status: statuses.get(path) ?? "unknown",
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      };
    })
    .filter((file) => file.path.length > 0);
}

function parseWorkingTreeStatuses(
  raw: string,
): Map<string, GitFileChange["status"]> {
  const statuses = new Map<string, GitFileChange["status"]>();

  for (const record of raw.split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;

    let status: GitFileChange["status"] = "unknown";
    if (code === "??" || code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("R")) status = "renamed";
    else if (code.includes("C")) status = "copied";
    else if (code.includes("T")) status = "type-changed";
    else if (code.includes("M")) status = "modified";

    statuses.set(path, status);
  }

  return statuses;
}

async function readWorkingTreeFiles(
  repoRoot: string,
  signal: AbortSignal,
): Promise<GitFileChange[]> {
  const [rawStatus, headHash] = await Promise.all([
    runGit(
      repoRoot,
      [
        "-c",
        "status.renames=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      signal,
    ),
    runGitOptional(repoRoot, ["rev-parse", "--verify", "HEAD"], signal),
  ]);
  const statuses = parseWorkingTreeStatuses(rawStatus);
  if (statuses.size === 0) return [];

  const rawStats = await runGitOptional(
    repoRoot,
    [
      "diff",
      "--no-renames",
      "--numstat",
      "-z",
      ...(headHash ? ["HEAD"] : ["--cached"]),
      "--",
    ],
    signal,
  );
  const statsByPath = new Map(
    parseNumStat(rawStats ?? "", statuses).map((file) => [file.path, file]),
  );

  return Array.from(statuses, ([path, status]) => {
    const stats = statsByPath.get(path);
    return {
      path,
      status,
      additions: stats?.additions ?? null,
      deletions: stats?.deletions ?? null,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function readCommitDetails(
  repoRoot: string,
  hash: string,
  signal: AbortSignal,
): Promise<CommitDetails> {
  assertObjectName(hash);
  const { byHash } = await readRefs(repoRoot, signal);
  const rawCommit = await runGit(
    repoRoot,
    ["show", "-s", `--format=${HISTORY_FORMAT}`, hash],
    signal,
  );

  const commit = parseCommitFields(rawCommit, byHash)[0];
  if (!commit) throw new Error(`Commit ${hash} was not found.`);

  const diffArgs = commit.parents[0]
    ? [commit.parents[0], hash]
    : ["--root", "--no-commit-id", "-r", hash];
  const [rawStatuses, rawStats] = await Promise.all([
    runGit(
      repoRoot,
      ["diff-tree", "--no-renames", "--name-status", "-z", ...diffArgs],
      signal,
    ),
    runGit(
      repoRoot,
      ["diff-tree", "--no-renames", "--numstat", "-z", ...diffArgs],
      signal,
    ),
  ]);

  return {
    ...commit,
    files: parseNumStat(rawStats, parseNameStatus(rawStatuses)),
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async history({ repoPath, offset, limit }, context) {
      const repoRoot = await resolveRepository(repoPath, context.signal);
      const [{ byHash, currentBranch }, rawHistory, rawCount, uncommittedFiles] = await Promise.all([
        readRefs(repoRoot, context.signal),
        runGit(
          repoRoot,
          [
            "log",
            ...VISIBLE_HISTORY_REVISIONS,
            "--topo-order",
            `--max-count=${limit + 1}`,
            `--skip=${offset}`,
            `--format=${HISTORY_FORMAT}`,
          ],
          context.signal,
        ),
        runGit(
          repoRoot,
          ["rev-list", ...VISIBLE_HISTORY_REVISIONS, "--count"],
          context.signal,
        ),
        readWorkingTreeFiles(repoRoot, context.signal),
      ]);

      const parsed = parseCommitFields(rawHistory, byHash);
      const hasMore = parsed.length > limit;
      const commits = parsed.slice(0, limit).map(({ body: _body, ...commit }) => commit);

      return {
        repoName: basename(repoRoot),
        currentBranch,
        uncommittedFiles,
        commits,
        offset,
        total: Number.parseInt(rawCount.trim(), 10) || commits.length,
        hasMore,
        unavailableReason: null,
      };
    },

    async details({ repoPath, hash }, context) {
      const repoRoot = await resolveRepository(repoPath, context.signal);
      return readCommitDetails(repoRoot, hash, context.signal);
    },

    async patch({ repoPath, hash, path }, context) {
      assertObjectName(hash);
      const repoRoot = await resolveRepository(repoPath, context.signal);
      const rawPatch = await runGit(
        repoRoot,
        [
          "show",
          "--format=",
          "--no-color",
          "--no-ext-diff",
          "--first-parent",
          "--unified=3",
          hash,
          "--",
          path,
        ],
        context.signal,
      );
      const truncated = rawPatch.length > MAX_PATCH_CHARS;
      return {
        path,
        patch: truncated ? rawPatch.slice(0, MAX_PATCH_CHARS) : rawPatch,
        truncated,
      };
    },

    async workingPatch({ repoPath, path }, context) {
      const repoRoot = await resolveRepository(repoPath, context.signal);
      const files = await readWorkingTreeFiles(repoRoot, context.signal);
      if (!files.some((file) => file.path === path)) {
        throw new Error(`Uncommitted file ${path} was not found.`);
      }

      const headHash = await runGitOptional(
        repoRoot,
        ["rev-parse", "--verify", "HEAD"],
        context.signal,
      );
      const rawPatch = await runGit(
        repoRoot,
        [
          "diff",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--unified=3",
          ...(headHash ? ["HEAD"] : ["--cached"]),
          "--",
          path,
        ],
        context.signal,
      );
      const truncated = rawPatch.length > MAX_PATCH_CHARS;
      return {
        path,
        patch: truncated ? rawPatch.slice(0, MAX_PATCH_CHARS) : rawPatch,
        truncated,
      };
    },
  },
});
