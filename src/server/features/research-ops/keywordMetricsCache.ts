import { z } from "zod";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import {
  CACHE_TTL,
  buildCacheKey,
  getCached,
  setCached,
} from "@/server/lib/r2-cache";
import { isClickstreamRequested } from "./clickstream";
import { recordPaidResearchJob } from "./paidResearchRecorder";

const CACHE_VERSION = 1;

const monthlySearchSchema = z.object({
  year: z.number(),
  month: z.number(),
  searchVolume: z.number(),
});

const keywordMetricRowSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  competitionLevel: z.string().nullable(),
  keywordDifficulty: z.number().nullable(),
  intent: z.string().nullable(),
  monthlySearches: z.array(monthlySearchSchema),
});

const cachedMetricsSchema = z.object({
  rows: z.array(keywordMetricRowSchema),
});

export type KeywordMetricsLiveParams = {
  keywords: string[];
  locationCode: number;
  languageCode: string;
  includeClickstreamData: boolean;
};

export type KeywordMetricsCacheInput = {
  organizationId: string;
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  includeClickstreamData?: boolean | null;
};

function recordEmptyKeywordMetricsJob(
  input: KeywordMetricsCacheInput,
  keywords: string[],
  includeClickstreamData: boolean,
  cacheHit: boolean,
): void {
  void recordPaidResearchJob({
    projectId: input.projectId,
    tool: "get_keyword_metrics",
    providerCategory: "dataforseo_labs",
    requestSize: keywords.length,
    cacheHit,
    summary: `get_keyword_metrics: 0/${keywords.length} keywords returned | ${input.locationCode}/${input.languageCode} | ${cacheHit ? "cache hit" : "cache miss"} | clickstream ${includeClickstreamData ? "on" : "off"}`,
  });
}

export async function fetchCachedKeywordMetrics(
  input: KeywordMetricsCacheInput,
  fetchLive: (params: KeywordMetricsLiveParams) => Promise<KeywordMetricRow[]>,
): Promise<{ rows: KeywordMetricRow[]; cacheHit: boolean }> {
  const keywords = [
    ...new Set(
      input.keywords.map(normalizeKeyword).filter((keyword) => keyword.length > 0),
    ),
  ];
  const includeClickstreamData = isClickstreamRequested(
    input.includeClickstreamData,
  );
  const cacheKey = await buildCacheKey("kw:metrics", {
    cacheVersion: CACHE_VERSION,
    organizationId: input.organizationId,
    projectId: input.projectId,
    keywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    clickstream: includeClickstreamData,
  });

  const cached = cachedMetricsSchema.safeParse(await getCached(cacheKey));
  if (cached.success) {
    if (cached.data.rows.length === 0) {
      recordEmptyKeywordMetricsJob(
        input,
        keywords,
        includeClickstreamData,
        true,
      );
    }
    return { rows: cached.data.rows, cacheHit: true };
  }

  const rows = await fetchLive({
    keywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    includeClickstreamData,
  });
  await setCached(cacheKey, { rows }, CACHE_TTL.keywordMetrics);
  if (rows.length === 0) {
    recordEmptyKeywordMetricsJob(
      input,
      keywords,
      includeClickstreamData,
      false,
    );
  }
  return { rows, cacheHit: false };
}
