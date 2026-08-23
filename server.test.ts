import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { HistoryPage } from "./contracts";
import plugin from "./server";

describe("Git history server", () => {
  it("treats a non-Git environment as a normal unavailable state", async () => {
    const thread = {
      ...makeThreadResponse({
        id: "thread-1",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
      environment: {
        id: "environment-1",
        projectId: "project-1",
        hostId: "host-1",
        name: null,
        path: "/workspace/plain-folder",
        branchName: null,
        baseBranch: null,
        defaultBranch: null,
        mergeBaseBranch: null,
        isGitRepo: false,
        isWorktree: false,
        managed: false,
        status: "ready" as const,
        workspaceProvisionType: "unmanaged" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    let hostCallCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "git-history",
      sdk: {
        threads: {
          get: async () => thread,
        },
      },
      experimental_callHostRpc: async () => {
        hostCallCount += 1;
        throw new Error("Host RPC should not run");
      },
    });
    plugin(bb);

    const result = (await harness.behavior.callRpc("history", {
      threadId: "thread-1",
      offset: 0,
      limit: 200,
    })) as HistoryPage;

    expect(result.unavailableReason).toBe(
      "The thread environment is not a Git repository.",
    );
    expect(result.commits).toEqual([]);
    expect(hostCallCount).toBe(0);
  });
});
