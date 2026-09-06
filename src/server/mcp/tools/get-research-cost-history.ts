import { z } from "zod";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";

const inputSchema = { projectId: projectIdSchema } as const;

type CostRow = {
  tool: string;
  providerCategory: string;
  requestSize: number;
  cache: string;
  createdAt: string;
  creditsCharged: number | null;
  providerCostUsd: string | null;
};

const COLUMNS: McpTableColumn<CostRow>[] = [
  { header: "time", value: (row) => row.createdAt },
  { header: "tool", value: (row) => row.tool },
  { header: "category", value: (row) => row.providerCategory },
  { header: "size", value: (row) => row.requestSize },
  { header: "cache", value: (row) => row.cache },
  { header: "credits", value: (row) => row.creditsCharged },
  { header: "provider_usd", value: (row) => row.providerCostUsd },
];

export const getResearchCostHistoryTool = {
  name: "get_research_cost_history",
  config: {
    title: "Get research cost history",
    description:
      "Lists recent project-level DataForSEO spend and zero-cost cache reuse events. Provider rows include the actual DataForSEO path and USD cost; hosted mode also records OpenSEO credits. Uses no credits.",
    inputSchema,
    outputSchema: {
      jobs: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof inputSchema>>, context) => {
      const rows = await ProjectContextRepository.listResearchCosts(
        args.projectId,
      );
      const jobs: CostRow[] = rows.map((row) => ({
        tool: row.tool,
        providerCategory: row.providerCategory,
        requestSize: row.requestSize,
        cache: row.cacheHit ? "hit" : "miss",
        createdAt: row.createdAt,
        creditsCharged: row.creditsCharged,
        providerCostUsd: row.providerCostUsd,
      }));
      const header = jobs.length
        ? `Research cost history (${jobs.length} job(s)).`
        : "No research cost history for this project.";
      return mcpResponse({
        text:
          jobs.length === 0
            ? header
            : `${header}\n${formatMcpTable(jobs, COLUMNS)}`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/settings/context`,
        ),
        structuredContent: { jobs },
      });
    },
  ),
};
