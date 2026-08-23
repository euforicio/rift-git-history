import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contracts";

export { rpcContract } from "./contracts";

interface RepositoryTarget {
  hostId: string;
  repoPath: string;
}

class RepositoryUnavailableError extends Error {}

async function repositoryForThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<RepositoryTarget> {
  const thread = await bb.sdk.threads.get({
    threadId,
    include: "environment",
  });

  if (!("environment" in thread) || !thread.environment) {
    throw new RepositoryUnavailableError("This thread has no active project environment.");
  }

  const environment = thread.environment;
  if (!environment.path) {
    throw new RepositoryUnavailableError("The thread environment has no workspace path yet.");
  }
  if (environment.status !== "ready") {
    throw new RepositoryUnavailableError(`The thread environment is ${environment.status}.`);
  }

  return {
    hostId: environment.hostId,
    repoPath: environment.path,
  };
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  bb.rpc.register(rpcContract, {
    async history({ threadId, offset, limit }) {
      try {
        const target = await repositoryForThread(bb, threadId);
        return await host.call(
          "history",
          { repoPath: target.repoPath, offset, limit },
          { hostId: target.hostId },
        );
      } catch (error) {
        if (!(error instanceof RepositoryUnavailableError)) throw error;
        return {
          repoName: "Git history",
          currentBranch: null,
          commits: [],
          offset,
          total: 0,
          hasMore: false,
          unavailableReason: error.message,
        };
      }
    },

    async details({ threadId, hash }) {
      const target = await repositoryForThread(bb, threadId);
      return host.call(
        "details",
        { repoPath: target.repoPath, hash },
        { hostId: target.hostId },
      );
    },

    async patch({ threadId, hash, path }) {
      const target = await repositoryForThread(bb, threadId);
      return host.call(
        "patch",
        { repoPath: target.repoPath, hash, path },
        { hostId: target.hostId },
      );
    },
  });

  bb.log.info("Git History loaded");
}
