import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitRefSchema = z
  .object({
    fullName: z.string(),
    name: z.string(),
    kind: z.enum(["local", "remote", "tag", "stash", "other"]),
    isHead: z.boolean(),
  })
  .strict();

export const gitCommitSummarySchema = z
  .object({
    hash: z.string(),
    parents: z.array(z.string()),
    authorName: z.string(),
    authorEmail: z.string(),
    authorDate: z.string(),
    committerDate: z.string(),
    subject: z.string(),
    refs: z.array(gitRefSchema),
  })
  .strict();

export const gitFileChangeSchema = z
  .object({
    path: z.string(),
    status: z.enum(["added", "copied", "deleted", "modified", "renamed", "type-changed", "unknown"]),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const historyPageSchema = z
  .object({
    repoName: z.string(),
    currentBranch: z.string().nullable(),
    commits: z.array(gitCommitSummarySchema),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    unavailableReason: z.string().nullable(),
  })
  .strict();

export const commitDetailsSchema = gitCommitSummarySchema.extend({
  body: z.string(),
  files: z.array(gitFileChangeSchema),
});

export const commitPatchSchema = z
  .object({
    path: z.string(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();

const threadHistoryInputSchema = z
  .object({
    threadId: z.string().min(1),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(400),
  })
  .strict();

const threadCommitInputSchema = z
  .object({
    threadId: z.string().min(1),
    hash: z.string().min(4).max(128),
  })
  .strict();

export const rpcContract = defineRpcContract({
  history: {
    input: threadHistoryInputSchema,
    output: historyPageSchema,
  },
  details: {
    input: threadCommitInputSchema,
    output: commitDetailsSchema,
  },
  patch: {
    input: threadCommitInputSchema.extend({ path: z.string().min(1).max(16_384) }),
    output: commitPatchSchema,
  },
});

const hostRepositoryInputSchema = z
  .object({
    repoPath: z.string().min(1).max(16_384),
  })
  .strict();

export const hostContract = defineRpcContract({
  history: {
    input: hostRepositoryInputSchema.extend({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(400),
    }),
    output: historyPageSchema,
  },
  details: {
    input: hostRepositoryInputSchema.extend({
      hash: z.string().min(4).max(128),
    }),
    output: commitDetailsSchema,
  },
  patch: {
    input: hostRepositoryInputSchema.extend({
      hash: z.string().min(4).max(128),
      path: z.string().min(1).max(16_384),
    }),
    output: commitPatchSchema,
  },
});

export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommitSummary = z.infer<typeof gitCommitSummarySchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
export type CommitDetails = z.infer<typeof commitDetailsSchema>;
export type CommitPatch = z.infer<typeof commitPatchSchema>;
