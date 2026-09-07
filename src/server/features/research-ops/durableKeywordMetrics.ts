import { and, eq, inArray } from "drizzle-orm";
import { sortBy } from "remeda";
import { db } from "@/db";
import { keywordMetrics } from "@/db/schema";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";

const QUERY_CHUNK_SIZE = 80;

type DurableKeywordMetricRecord = typeof keywordMetrics.$inferSelect;
type MonthlySearch = KeywordMetricRow["monthlySearches"][number];

function isMonthlySearch(value: unknown): value is MonthlySearch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!("year" in value) || !("month" in value) || !("searchVolume" in value)) {
    return false;
  }
  return (
    typeof value.year === "number" &&
    typeof value.month === "number" &&
    typeof value.searchVolume === "number"
  );
}

function parseMonthlySearches(
  value: string | null,
): KeywordMetricRow["monthlySearches"] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMonthlySearch).map((row) => ({
      year: row.year,
      month: row.month,
      searchVolume: row.searchVolume,
    }));
  } catch {
    return [];
  }
}

function toKeywordMetricRow(row: DurableKeywordMetricRecord): KeywordMetricRow {
  return {
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    cpc: row.cpc,
    competition: row.competition,
    // The existing durable table predates competition-level storage. Keep the
    // richer provider field nullable instead of fabricating it.
    competitionLevel: null,
    keywordDifficulty: row.keywordDifficulty,
    intent: row.intent,
    monthlySearches: parseMonthlySearches(row.monthlySearches),
  };
}

export async function loadDurableKeywordMetrics(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}): Promise<KeywordMetricRow[]> {
  const keywords = sortBy(
    [
      ...new Set(
        params.keywords
          .map(normalizeKeyword)
          .filter((keyword) => keyword.length > 0),
      ),
    ],
    (keyword) => keyword,
  );
  if (keywords.length === 0) return [];

  const records: DurableKeywordMetricRecord[] = [];
  for (let i = 0; i < keywords.length; i += QUERY_CHUNK_SIZE) {
    const chunk = keywords.slice(i, i + QUERY_CHUNK_SIZE);
    records.push(
      ...(await db
        .select()
        .from(keywordMetrics)
        .where(
          and(
            eq(keywordMetrics.projectId, params.projectId),
            eq(keywordMetrics.locationCode, params.locationCode),
            eq(keywordMetrics.languageCode, params.languageCode),
            inArray(keywordMetrics.keyword, chunk),
          ),
        )),
    );
  }

  const byKeyword = new Map(
    records.map((record) => [normalizeKeyword(record.keyword), record]),
  );
  return keywords.flatMap((keyword) => {
    const record = byKeyword.get(keyword);
    return record ? [toKeywordMetricRow(record)] : [];
  });
}

export async function persistDurableKeywordMetrics(params: {
  projectId: string;
  locationCode: number;
  languageCode: string;
  rows: KeywordMetricRow[];
}): Promise<void> {
  await Promise.all(
    params.rows.map((row) =>
      KeywordResearchRepository.upsertKeywordMetric({
        projectId: params.projectId,
        keyword: normalizeKeyword(row.keyword),
        locationCode: params.locationCode,
        languageCode: params.languageCode,
        searchVolume: row.searchVolume,
        cpc: row.cpc,
        competition: row.competition,
        keywordDifficulty: row.keywordDifficulty,
        intent: row.intent,
        monthlySearchesJson: JSON.stringify(row.monthlySearches),
      }),
    ),
  );
}
