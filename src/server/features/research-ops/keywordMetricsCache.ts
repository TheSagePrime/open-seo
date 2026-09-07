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
import {
  loadDurableKeywordMetrics,
  persistDurableKeywordMetrics,
} from "./durableKeywordMetrics";
import { recordPaidResearchJob } from "./paidResearchRecorder";
import {
  findLatestResearchSnapshot,
  saveResearchSnapshot,
} from "./researchSnapshots";

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

type KeywordMetricsLiveParams = {
  keywords: string[];
  locationCode: number;
  languageCode: string;
  includeClickstreamData: boolean;
};

type KeywordMetricsCacheInput = {
  organizationId: string;
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  includeClickstreamData?: boolean | null;
  refresh?: boolean;
};

type MetricReuseSource = "cache" | "snapshot" | "database" | "provider";

function recordEmptyKeywordMetricsJob(
  input: KeywordMetricsCacheInput,
  keywords: string[],
  includeClickstreamData: boolean,
  cacheHit: boolean,
  reuseSource?: "cache" | "snapshot",
): void {
  void recordPaidResearchJob({
    projectId: input.projectId,
    tool: "get_keyword_metrics",
    providerCategory: "dataforseo_labs",
    requestSize: keywords.length,
    cacheHit,
    reuseSource,
    summary: `get_keyword_metrics: 0/${keywords.length} keywords returned | ${input.locationCode}/${input.languageCode} | ${cacheHit ? `${reuseSource ?? "cache"} reuse` : input.refresh === true ? "explicit refresh" : "provider research"} | clickstream ${includeClickstreamData ? "on" : "off"}`,
  });
}

async function findSnapshotSafely(params: {
  projectId: string;
  request: Record<string, unknown>;
}) {
  try {
    return await findLatestResearchSnapshot({
      projectId: params.projectId,
      researchType: "get_keyword_metrics",
      request: params.request,
    });
  } catch (error) {
    console.error("research-ops.snapshot.lookup failed:", error);
    return null;
  }
}

async function saveSnapshotSafely(params: {
  projectId: string;
  request: Record<string, unknown>;
  payload: { rows: KeywordMetricRow[] };
}) {
  try {
    await saveResearchSnapshot({
      projectId: params.projectId,
      researchType: "get_keyword_metrics",
      request: params.request,
      payload: params.payload,
      source: "keyword_overview/live",
      providerCategory: "dataforseo_labs",
      origin: "provider",
    });
  } catch (error) {
    // The paid provider response remains successful. The short cache still
    // prevents an immediate duplicate purchase while bookkeeping recovers.
    console.error("research-ops.snapshot.persist failed:", error);
  }
}

async function loadDurableMetricsSafely(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}): Promise<KeywordMetricRow[]> {
  try {
    return await loadDurableKeywordMetrics(params);
  } catch (error) {
    console.error("research-ops.keyword-metrics.lookup failed:", error);
    return [];
  }
}

async function persistDurableMetricsSafely(params: {
  projectId: string;
  locationCode: number;
  languageCode: string;
  rows: KeywordMetricRow[];
}): Promise<void> {
  if (params.rows.length === 0) return;
  try {
    await persistDurableKeywordMetrics(params);
  } catch (error) {
    console.error("research-ops.keyword-metrics.persist failed:", error);
  }
}

function mergeMetricRows(
  keywords: string[],
  durableRows: KeywordMetricRow[],
  liveRows: KeywordMetricRow[],
): KeywordMetricRow[] {
  const byKeyword = new Map<string, KeywordMetricRow>();
  for (const row of durableRows) {
    byKeyword.set(normalizeKeyword(row.keyword), row);
  }
  for (const row of liveRows) {
    byKeyword.set(normalizeKeyword(row.keyword), row);
  }
  return keywords.flatMap((keyword) => {
    const row = byKeyword.get(keyword);
    return row ? [row] : [];
  });
}

export async function fetchCachedKeywordMetrics(
  input: KeywordMetricsCacheInput,
  fetchLive: (params: KeywordMetricsLiveParams) => Promise<KeywordMetricRow[]>,
): Promise<{
  rows: KeywordMetricRow[];
  cacheHit: boolean;
  reuseSource: MetricReuseSource;
}> {
  const keywords = [
    ...new Set(
      input.keywords
        .map(normalizeKeyword)
        .filter((keyword) => keyword.length > 0),
    ),
  ].sort();
  const includeClickstreamData = isClickstreamRequested(
    input.includeClickstreamData,
  );
  const snapshotRequest = {
    keywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    clickstream: includeClickstreamData,
  };
  const cacheKey = await buildCacheKey("kw:metrics", {
    cacheVersion: CACHE_VERSION,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...snapshotRequest,
  });

  if (input.refresh !== true) {
    const cached = cachedMetricsSchema.safeParse(await getCached(cacheKey));
    if (cached.success) {
      if (cached.data.rows.length === 0) {
        recordEmptyKeywordMetricsJob(
          input,
          keywords,
          includeClickstreamData,
          true,
          "cache",
        );
      }
      return {
        rows: cached.data.rows,
        cacheHit: true,
        reuseSource: "cache",
      };
    }

    const snapshot = await findSnapshotSafely({
      projectId: input.projectId,
      request: snapshotRequest,
    });
    const snapshotMetrics = cachedMetricsSchema.safeParse(snapshot?.payload);
    if (snapshotMetrics.success) {
      await setCached(cacheKey, snapshotMetrics.data, CACHE_TTL.keywordMetrics);
      if (snapshotMetrics.data.rows.length === 0) {
        recordEmptyKeywordMetricsJob(
          input,
          keywords,
          includeClickstreamData,
          true,
          "snapshot",
        );
      }
      return {
        rows: snapshotMetrics.data.rows,
        cacheHit: true,
        reuseSource: "snapshot",
      };
    }

    // Clickstream-refined metrics are semantically different and the legacy
    // keyword_metrics table does not record that dimension. Only reuse it for
    // normal non-clickstream requests.
    if (!includeClickstreamData) {
      const durableRows = await loadDurableMetricsSafely({
        projectId: input.projectId,
        keywords,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
      });
      const durableKeywords = new Set(
        durableRows.map((row) => normalizeKeyword(row.keyword)),
      );
      const missingKeywords = keywords.filter(
        (keyword) => !durableKeywords.has(keyword),
      );

      if (
        missingKeywords.length === 0 &&
        durableRows.length === keywords.length
      ) {
        const payload = { rows: mergeMetricRows(keywords, durableRows, []) };
        await setCached(cacheKey, payload, CACHE_TTL.keywordMetrics);
        return {
          rows: payload.rows,
          cacheHit: true,
          reuseSource: "database",
        };
      }

      if (durableRows.length > 0) {
        const liveRows = await fetchLive({
          keywords: missingKeywords,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          includeClickstreamData,
        });
        await persistDurableMetricsSafely({
          projectId: input.projectId,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          rows: liveRows,
        });
        const rows = mergeMetricRows(keywords, durableRows, liveRows);
        const payload = { rows };
        await setCached(cacheKey, payload, CACHE_TTL.keywordMetrics);
        await saveSnapshotSafely({
          projectId: input.projectId,
          request: snapshotRequest,
          payload,
        });
        return { rows, cacheHit: false, reuseSource: "provider" };
      }
    }
  }

  const rows = await fetchLive({
    keywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    includeClickstreamData,
  });
  const payload = { rows };
  await setCached(cacheKey, payload, CACHE_TTL.keywordMetrics);
  await saveSnapshotSafely({
    projectId: input.projectId,
    request: snapshotRequest,
    payload,
  });
  if (!includeClickstreamData) {
    await persistDurableMetricsSafely({
      projectId: input.projectId,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      rows,
    });
  }
  if (rows.length === 0) {
    recordEmptyKeywordMetricsJob(
      input,
      keywords,
      includeClickstreamData,
      false,
    );
  }
  return { rows, cacheHit: false, reuseSource: "provider" };
}
