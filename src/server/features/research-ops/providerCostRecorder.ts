import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  SEO_DATA_COST_MARKUP,
  roundUsdForBilling,
} from "@/shared/billing";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import type { DataforseoApiCallCost } from "@/server/lib/dataforseo/envelope";

export function calculateOpenSeoCredits(providerCostUsd: number): number {
  const billedUsd = roundUsdForBilling(providerCostUsd * SEO_DATA_COST_MARKUP);
  return Math.max(0, Math.ceil(billedUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD));
}

export function dataforseoProviderCategory(path: string[]): string {
  const category = path[1] ?? path[0] ?? "unknown";
  return `dataforseo:${category}`;
}

export async function recordDataforseoProviderCost(args: {
  projectId: string;
  billing: DataforseoApiCallCost;
  creditsCharged: number | null;
}): Promise<void> {
  if (args.billing.costUsd <= 0) return;

  try {
    await ProjectContextRepository.insertResearchCost({
      projectId: args.projectId,
      tool: `dataforseo:/${args.billing.path.join("/")}`,
      providerCategory: dataforseoProviderCategory(args.billing.path),
      requestSize: 1,
      cacheHit: false,
      providerCostUsd: String(args.billing.costUsd),
      creditsCharged: args.creditsCharged,
    });
  } catch (error) {
    // Cost-history failures must never destroy a successful provider result.
    console.error("research-ops.recordDataforseoProviderCost failed:", error);
  }
}
