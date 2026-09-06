import { z } from "zod";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import {
  listResearchSnapshots,
  researchSnapshotExists,
  saveResearchSnapshot,
} from "@/server/features/research-ops/researchSnapshots";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

const researchTypeSchema = z.enum([
  "research_keywords",
  "get_keyword_metrics",
  "get_serp_results",
]);

const trendSchema = z.object({
  year: z.number(),
  month: z.number(),
  searchVolume: z.number(),
});

const keywordResearchRowSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  trend: z.array(trendSchema),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
  intent: z.enum([
    "informational",
    "commercial",
    "transactional",
    "navigational",
    "unknown",
  ]),
});

const keywordMetricRowSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  competitionLevel: z.string().nullable(),
  keywordDifficulty: z.number().nullable(),
  intent: z.string().nullable(),
  monthlySearches: z.array(trendSchema),
});

const serpItemSchema = z.object({
  type: z.string().nullable().optional(),
  rank: z.number().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
});

const researchedAtSchema = z
  .string()
  .datetime()
  .describe("Original research timestamp in ISO 8601 format.");

const researchKeywordsBackfillSchema = z.object({
  kind: z.literal("research_keywords"),
  seed: z.string().min(1),
  locationCode: locationCodeSchema,
  languageCode: languageCodeSchema,
  resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).optional(),
  mode: z.enum(["auto", "related", "suggestions", "ideas"]).optional(),
  clickstream: z.boolean().optional(),
  source: z.enum(["related", "suggestions", "ideas", "google_ads"]),
  usedFallback: z.boolean().optional(),
  rows: z.array(keywordResearchRowSchema),
  researchedAt: researchedAtSchema,
  providerCostUsd: z.string().nullable().optional(),
});

const keywordMetricsBackfillSchema = z.object({
  kind: z.literal("get_keyword_metrics"),
  keywords: z.array(z.string().min(1)).min(1).max(700),
  locationCode: locationCodeSchema,
  languageCode: languageCodeSchema,
  clickstream: z.boolean().optional(),
  rows: z.array(keywordMetricRowSchema),
  researchedAt: researchedAtSchema,
  providerCostUsd: z.string().nullable().optional(),
});

const serpBackfillSchema = z.object({
  kind: z.literal("get_serp_results"),
  keyword: z.string().min(1),
  locationCode: locationCodeSchema,
  languageCode: languageCodeSchema,
  depth: z.number().int().min(10).max(100).multipleOf(10).optional(),
  items: z.array(serpItemSchema),
  researchedAt: researchedAtSchema,
  providerCostUsd: z.string().nullable().optional(),
});

const backfillSnapshotSchema = z.discriminatedUnion("kind", [
  researchKeywordsBackfillSchema,
  keywordMetricsBackfillSchema,
  serpBackfillSchema,
]);

const listInputSchema = {
  projectId: projectIdSchema,
  researchType: researchTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  includePayload: z
    .boolean()
    .optional()
    .describe("Include stored payloads. Defaults to false to keep responses small."),
} as const;

type ListArgs = z.infer<z.ZodObject<typeof listInputSchema>>;

export const listResearchSnapshotsTool = {
  name: "list_research_snapshots",
  config: {
    title: "List durable research snapshots",
    description:
      "Lists durable previously purchased/imported research for a project. This tool is free and makes no DataForSEO calls.",
    inputSchema: listInputSchema,
    outputSchema: {
      snapshots: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const snapshots = (await listResearchSnapshots(args.projectId, args.limit ?? 100))
      .filter(
        (snapshot) =>
          args.researchType == null || snapshot.researchType === args.researchType,
      )
      .map((snapshot) => ({
        id: snapshot.id,
        researchType: snapshot.researchType,
        requestHash: snapshot.requestHash,
        request: snapshot.request,
        source: snapshot.source,
        providerCategory: snapshot.providerCategory,
        providerCostUsd: snapshot.providerCostUsd,
        origin: snapshot.origin,
        researchedAt: snapshot.researchedAt,
        createdAt: snapshot.createdAt,
        ...(args.includePayload === true ? { payload: snapshot.payload } : {}),
      }));

    return mcpResponse({
      text: `Found ${snapshots.length} durable research snapshots.`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { snapshots },
    });
  }),
};

const backfillInputSchema = {
  projectId: projectIdSchema,
  snapshots: z
    .array(backfillSnapshotSchema)
    .min(1)
    .max(20)
    .describe(
      "Historical research to import. This only writes durable snapshots and never calls DataForSEO or saves approved keywords.",
    ),
} as const;

type BackfillArgs = z.infer<z.ZodObject<typeof backfillInputSchema>>;

function researchKeywordsSnapshot(item: z.infer<typeof researchKeywordsBackfillSchema>) {
  const seed = normalizeKeyword(item.seed);
  const mode = item.mode ?? "auto";
  const request = {
    keywords: [seed],
    locationCode: item.locationCode,
    languageCode: item.languageCode,
    resultLimit: item.resultLimit ?? 150,
    mode,
    depth: 3,
    clickstream: item.clickstream === true,
  };
  const nonSeedCount = item.rows.filter(
    (row) => normalizeKeyword(row.keyword) !== seed,
  ).length;
  const payload = {
    rows: item.rows,
    source: item.source,
    usedFallback: item.usedFallback ?? item.source !== "related",
    diagnostics: {
      requestedMode: mode,
      threshold: 0,
      sourceAttempts: [
        {
          source: item.source,
          rowCount: item.rows.length,
          nonSeedCount,
        },
      ],
    },
  };
  return {
    researchType: item.kind,
    request,
    payload,
    source: item.source,
    providerCategory: "dataforseo",
  };
}

function keywordMetricsSnapshot(item: z.infer<typeof keywordMetricsBackfillSchema>) {
  return {
    researchType: item.kind,
    request: {
      keywords: [
        ...new Set(
          item.keywords
            .map(normalizeKeyword)
            .filter((keyword) => keyword.length > 0),
        ),
      ],
      locationCode: item.locationCode,
      languageCode: item.languageCode,
      clickstream: item.clickstream === true,
    },
    payload: { rows: item.rows },
    source: "keyword_overview/live",
    providerCategory: "dataforseo_labs",
  };
}

function serpSnapshot(item: z.infer<typeof serpBackfillSchema>) {
  return {
    researchType: item.kind,
    request: {
      keyword: normalizeKeyword(item.keyword),
      locationCode: item.locationCode,
      languageCode: item.languageCode,
      depth: item.depth ?? 20,
    },
    payload: { items: item.items },
    source: "serp.live",
    providerCategory: "dataforseo_serp",
  };
}

export const backfillResearchSnapshotsTool = {
  name: "backfill_research_snapshots",
  config: {
    title: "Backfill durable research snapshots",
    description:
      "Imports historical keyword, keyword-metric, or SERP research into the durable snapshot store. Makes no DataForSEO calls and does not add discovered keywords to the approved saved-keyword list. Re-running the same request at the same researchedAt timestamp is idempotent.",
    inputSchema: backfillInputSchema,
    outputSchema: {
      imported: z.number(),
      skipped: z.number(),
      snapshots: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BackfillArgs, context) => {
    const results: Array<Record<string, unknown>> = [];
    let imported = 0;
    let skipped = 0;

    for (const item of args.snapshots) {
      const normalized =
        item.kind === "research_keywords"
          ? researchKeywordsSnapshot(item)
          : item.kind === "get_keyword_metrics"
            ? keywordMetricsSnapshot(item)
            : serpSnapshot(item);
      const exists = await researchSnapshotExists({
        projectId: args.projectId,
        researchType: normalized.researchType,
        request: normalized.request,
        researchedAt: item.researchedAt,
      });
      if (exists) {
        skipped += 1;
        results.push({
          researchType: normalized.researchType,
          researchedAt: item.researchedAt,
          status: "skipped_existing",
        });
        continue;
      }

      const saved = await saveResearchSnapshot({
        projectId: args.projectId,
        researchType: normalized.researchType,
        request: normalized.request,
        payload: normalized.payload,
        source: normalized.source,
        providerCategory: normalized.providerCategory,
        providerCostUsd: item.providerCostUsd ?? null,
        origin: "backfill",
        researchedAt: item.researchedAt,
      });
      imported += 1;
      results.push({
        researchType: normalized.researchType,
        researchedAt: item.researchedAt,
        requestHash: saved.requestHash,
        status: "imported",
      });
    }

    return mcpResponse({
      text: `Imported ${imported} research snapshots; skipped ${skipped} existing snapshots. No provider calls were made.`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: {
        imported,
        skipped,
        snapshots: results,
      },
    });
  }),
};
