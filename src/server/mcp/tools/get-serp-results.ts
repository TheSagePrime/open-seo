import { z } from "zod";
import {
  createDataforseoClient,
  SERP_ANALYSIS_DEPTH,
} from "@/server/lib/dataforseo";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import {
  findLatestResearchSnapshot,
  saveResearchSnapshot,
} from "@/server/features/research-ops/researchSnapshots";
import { recordPaidResearchJob } from "@/server/features/research-ops/paidResearchRecorder";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

type SerpItem = {
  type?: string | null;
  rank: number | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  description: string | null;
};

const serpItemSchema = z.object({
  type: z.string().nullable().optional(),
  rank: z.number().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
});

const serpSnapshotSchema = z.object({ items: z.array(serpItemSchema) });

const SERP_ITEM_COLUMNS: McpTableColumn<SerpItem>[] = [
  { header: "rank", value: (item) => item.rank },
  { header: "domain", value: (item) => item.domain },
  { header: "title", value: (item) => item.title },
  { header: "url", value: (item) => item.url },
];

const querySchema = z.object({
  keyword: z.string().min(1).describe("Search query to fetch the SERP for."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
});

const inputSchema = {
  projectId: projectIdSchema,
  queries: z
    .array(querySchema)
    .min(1)
    .max(10)
    .describe(
      "1-10 queries. Bulk-friendly — prefer this over multiple single-query calls.",
    ),
  depth: z
    .number()
    .int()
    .min(10)
    .max(100)
    .multipleOf(10)
    .optional()
    .describe(
      "How many SERP rows to crawl per keyword — a multiple of 10 from 10 to 100, default 20. Google has no offset, so a deeper crawl re-fetches the top too: each additional 10 adds ~2.5 credits per keyword. Only raise it when you need ranks past the top 20.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Force a fresh paid SERP, bypassing durable previously purchased research. Defaults to false.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getSerpResultsTool = {
  name: "get_serp_results",
  config: {
    title: "Get Google SERP results",
    description:
      "Get Google organic SERP results for 1-10 keywords. Normal requests reuse durable previously purchased SERPs when the normalized query, market, and depth match. DataForSEO is called only when no reusable snapshot exists, unless refresh=true explicitly forces fresh paid research. Provider results are saved as durable research snapshots.",
    inputSchema,
    outputSchema: {
      results: z.array(
        z.union([
          z
            .object({
              keyword: z.string(),
              ok: z.literal(true),
              items: z.array(serpItemSchema),
            })
            .passthrough(),
          z
            .object({
              keyword: z.string(),
              ok: z.literal(false),
              error: z.string(),
            })
            .passthrough(),
        ]),
      ),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const client = createDataforseoClient(context.billing);
    const depth = args.depth ?? SERP_ANALYSIS_DEPTH;
    const results = await Promise.all(
      args.queries.map(async (q) => {
        try {
          const market = resolveMarket(q, context.project);
          const keyword = normalizeKeyword(q.keyword);
          const snapshotRequest = {
            keyword,
            locationCode: market.locationCode,
            languageCode: market.languageCode,
            depth,
          };

          if (args.refresh !== true) {
            const snapshot = await findLatestResearchSnapshot({
              projectId: args.projectId,
              researchType: "get_serp_results",
              request: snapshotRequest,
            });
            const parsed = serpSnapshotSchema.safeParse(snapshot?.payload);
            if (parsed.success) {
              return {
                keyword: q.keyword,
                ok: true as const,
                items: parsed.data.items,
                reuseSource: "snapshot" as const,
              };
            }
          }

          const items = await client.serp.live({
            keyword: q.keyword,
            ...market,
            depth,
          });
          // Trim noise — return only essentials per item.
          const trimmed = items.slice(0, depth).map((item) => ({
            type: item.type,
            rank: item.rank_absolute ?? item.rank_group ?? null,
            title: item.title ?? null,
            url: item.url ?? null,
            domain: item.domain ?? null,
            description: item.description ?? null,
          }));
          await saveResearchSnapshot({
            projectId: args.projectId,
            researchType: "get_serp_results",
            request: snapshotRequest,
            payload: { items: trimmed },
            source: "serp.live",
            providerCategory: "dataforseo_serp",
            origin: "provider",
          });
          return {
            keyword: q.keyword,
            ok: true as const,
            items: trimmed,
            reuseSource: "provider" as const,
          };
        } catch (error) {
          return {
            keyword: q.keyword,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const okResults = results.filter((r) => r.ok);
    const allReused =
      okResults.length > 0 &&
      okResults.every((result) => result.reuseSource === "snapshot");
    if (okResults.length > 0) {
      void recordPaidResearchJob({
        projectId: args.projectId,
        tool: "get_serp_results",
        providerCategory: "dataforseo_serp",
        requestSize: okResults.length,
        cacheHit: allReused,
        reuseSource: allReused ? "snapshot" : undefined,
        summary: `get_serp_results: ${okResults.map((result) => result.keyword).join(", ")} | depth ${depth} | ${allReused ? "snapshot reuse" : args.refresh === true ? "explicit refresh" : "provider research"}`,
      });
    }

    const okCount = okResults.length;
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `"${r.keyword}": FAILED — ${r.error}`;
          }
          const reused = r.reuseSource === "snapshot" ? " [snapshot]" : "";
          if (r.items.length === 0) {
            return `"${r.keyword}" (0 results)${reused}`;
          }
          return `"${r.keyword}" (${r.items.length} results)${reused}:\n${formatMcpTable(r.items, SERP_ITEM_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\n${okCount} of ${results.length} queries succeeded.`;

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: { results },
    });
  }),
};
