import { waitUntil } from "cloudflare:workers";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";

type PaidResearchJob = {
  projectId: string;
  tool: string;
  providerCategory: string;
  requestSize: number;
  cacheHit: boolean;
  reuseSource?: "cache" | "snapshot";
  providerCostUsd?: string | null;
  creditsCharged?: number | null;
  summary: string;
};

async function persistPaidResearchJob(job: PaidResearchJob): Promise<void> {
  try {
    if (job.cacheHit) {
      // Provider misses are recorded centrally by the DataForSEO client with
      // their real path/cost. Keep only zero-cost reuse events here so one paid
      // call never produces a duplicate cost-history row. Durable snapshot
      // reuse is kept distinct from the short R2 cache in provider_category.
      await ProjectContextRepository.insertResearchCost({
        projectId: job.projectId,
        tool: job.tool,
        providerCategory: job.reuseSource ?? "cache",
        requestSize: job.requestSize,
        cacheHit: true,
        providerCostUsd: "0",
        creditsCharged: 0,
      });
      return;
    }

    await ProjectContextService.applyContextUpdates(
      job.projectId,
      [{ appendResearchLog: { summary: job.summary } }],
      "mcp",
    );
  } catch (error) {
    // Logging must never turn successful research into a failed MCP result.
    console.error("research-ops.recordPaidResearchJob failed:", error);
  }
}

export function recordPaidResearchJob(job: PaidResearchJob): Promise<void> {
  const write = persistPaidResearchJob(job);

  // Some callers intentionally do not await research bookkeeping. Register the
  // write with the runtime before returning so a response does not abandon it.
  try {
    waitUntil(write);
  } catch {
    // Node/self-hosted runtimes may not provide an active Workers context.
    // The returned promise still runs and can be awaited by callers.
  }

  return write;
}
