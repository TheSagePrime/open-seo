import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";

export type PaidResearchJob = {
  projectId: string;
  tool: string;
  providerCategory: string;
  requestSize: number;
  cacheHit: boolean;
  providerCostUsd?: string | null;
  creditsCharged?: number | null;
  summary: string;
};

export async function recordPaidResearchJob(
  job: PaidResearchJob,
): Promise<void> {
  try {
    await ProjectContextRepository.insertResearchCost({
      projectId: job.projectId,
      tool: job.tool,
      providerCategory: job.providerCategory,
      requestSize: job.requestSize,
      cacheHit: job.cacheHit,
      providerCostUsd: job.providerCostUsd ?? null,
      creditsCharged: job.creditsCharged ?? null,
    });

    if (!job.cacheHit) {
      await ProjectContextService.applyContextUpdates(
        job.projectId,
        [{ appendResearchLog: { summary: job.summary } }],
        "mcp",
      );
    }
  } catch (error) {
    console.error("research-ops.recordPaidResearchJob failed:", error);
  }
}
