import { z } from "zod";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { isClickstreamRequested } from "@/server/features/research-ops/clickstream";
import { recordPaidResearchJob } from "@/server/features/research-ops/paidResearchRecorder";
import { dedupeResearchSeeds } from "@/server/features/research-ops/seedDedupe";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { assertLanguageForLocation } from "@/server/lib/market";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

const seedSchema = z.object({
  seed: z.string().min(1).describe("Seed keyword to research."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
});

const inputSchema = {
  projectId: projectIdSchema,
  seeds: z
    .array(seedSchema)
    .min(1)
    .max(5)
    .describe(
      "1-5 seed keywords. Each seed is researched independently and returns related keywords with volume/difficulty/CPC. Bulk-friendly — prefer this over multiple single-seed calls.",
    ),
  resultLimit: z
    .union([z.literal(150), z.literal(300), z.literal(500)])
    .optional()
    .describe("Max keywords returned per seed. Defaults to 150."),
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Refine search volumes with clickstream data, which disaggregates Google Ads' grouped close-variant volumes (plurals/misspellings). DOUBLES the credit cost of each seed. OFF unless you pass true. No effect for countries served from Google Ads data.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Force fresh paid provider research, bypassing both the short cache and durable research snapshot. Defaults to false. Use only when stale evidence is not acceptable.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type ResearchRow = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string;
};

// The full rows (including trend data) still ship in structuredContent; this
// table exists so MCP clients that surface only text content see every keyword
// and its metrics, not just the count summary.
const RESEARCH_COLUMNS: McpTableColumn<ResearchRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "KD", value: (row) => row.keywordDifficulty },
  { header: "CPC", value: (row) => row.cpc },
  { header: "competition", value: (row) => row.competition },
  { header: "intent", value: (row) => row.intent },
];

export const researchKeywordsTool = {
  name: "research_keywords",
  config: {
    title: "Research keywords (bulk)",
    description:
      "Research keyword data (search volume, difficulty, CPC, related ideas) for 1-5 seed keywords in one call. Normal requests reuse the short cache first, then durable previously purchased research. DataForSEO is called only when reusable research is absent, unless refresh=true explicitly forces fresh paid research. Returns per-seed results — a single bad seed won't fail the batch.",
    inputSchema,
    outputSchema: {
      results: z.array(
        z.union([
          z
            .object({
              seed: z.string(),
              ok: z.literal(true),
              rowCount: z.number(),
              source: z.string(),
              usedFallback: z.boolean(),
              rows: z.array(looseObjectOutputSchema),
            })
            .passthrough(),
          z
            .object({
              seed: z.string(),
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
    const seeds = dedupeResearchSeeds(args.seeds);
    const clickstream = isClickstreamRequested(args.includeClickstreamData);
    const results = await Promise.all(
      seeds.map(async (item) => {
        try {
          const { locationCode, languageCode } = resolveMarket(
            item,
            context.project,
          );
          assertLanguageForLocation(locationCode, languageCode);
          const data = await KeywordResearchService.research(
            {
              projectId: args.projectId,
              keywords: [item.seed],
              locationCode,
              languageCode,
              resultLimit: args.resultLimit ?? 150,
              mode: "auto",
              clickstream,
            },
            context.billing,
            undefined,
            { refresh: args.refresh === true },
          );
          return {
            seed: item.seed,
            ok: true as const,
            rowCount: data.rows.length,
            source: data.source,
            usedFallback: data.usedFallback,
            cacheHit: data.cacheHit === true,
            reuseSource: data.reuseSource ?? "provider",
            rows: data.rows,
          };
        } catch (error) {
          return {
            seed: item.seed,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const okResults = results.filter((result) => result.ok);
    const allReused =
      okResults.length > 0 &&
      okResults.every((result) => result.reuseSource !== "provider");
    const reuseSource = allReused
      ? okResults.some((result) => result.reuseSource === "snapshot")
        ? "snapshot"
        : "cache"
      : undefined;
    if (okResults.length > 0) {
      const markets = [
        ...new Set(
          seeds.map((seed) => {
            const market = resolveMarket(seed, context.project);
            return `${market.locationCode}/${market.languageCode}`;
          }),
        ),
      ].join(", ");
      const reuseLabel = allReused
        ? `${reuseSource} reuse`
        : args.refresh === true
          ? "explicit refresh"
          : "provider research";
      void recordPaidResearchJob({
        projectId: args.projectId,
        tool: "research_keywords",
        providerCategory: "dataforseo_labs",
        requestSize: seeds.length,
        cacheHit: allReused,
        reuseSource,
        summary: `research_keywords: ${okResults.map((result) => result.seed).join(", ")} | market ${markets} | ${reuseLabel} | clickstream ${clickstream ? "on" : "off"}`,
      });
    }

    const okCount = okResults.length;
    const failCount = results.length - okCount;
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `## "${r.seed}" — FAILED\n${r.error}`;
          }
          const reuse =
            r.reuseSource === "snapshot"
              ? ", durable snapshot"
              : r.reuseSource === "cache"
                ? ", cache"
                : "";
          const header = `## "${r.seed}" — ${r.rowCount} keywords (source: ${r.source}${r.usedFallback ? ", fallback" : ""}${reuse})`;
          if (r.rowCount === 0) {
            return `${header}\n(no keywords returned)`;
          }
          return `${header}\n${formatMcpTable(r.rows, RESEARCH_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\nResearched ${okCount} of ${results.length} seeds${failCount > 0 ? ` (${failCount} failed)` : ""}. Columns: volume = monthly searches, KD = keyword difficulty (0-100), CPC in USD, competition = paid competition (0-1); "—" = unavailable.`;

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
