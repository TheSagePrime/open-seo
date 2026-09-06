import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { research } from "./research";

const mocks = vi.hoisted(() => ({
  buildCacheKey: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  findLatestResearchSnapshot: vi.fn(),
  saveResearchSnapshot: vi.fn(),
  upsertKeywordMetric: vi.fn(),
  fetchResearchRowsBySource: vi.fn(),
  fetchGoogleAdsResearchRows: vi.fn(),
  getKeywordDataProvider: vi.fn(),
}));

vi.mock("@/server/lib/r2-cache", () => ({
  CACHE_TTL: { researchResult: 86_400 },
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));
vi.mock("@/server/features/research-ops/researchSnapshots", () => ({
  findLatestResearchSnapshot: mocks.findLatestResearchSnapshot,
  saveResearchSnapshot: mocks.saveResearchSnapshot,
}));
vi.mock("@/server/features/keywords/repositories/KeywordResearchRepository", () => ({
  KeywordResearchRepository: {
    upsertKeywordMetric: mocks.upsertKeywordMetric,
  },
}));
vi.mock("./research-data", () => ({
  fetchResearchRowsBySource: mocks.fetchResearchRowsBySource,
  fetchGoogleAdsResearchRows: mocks.fetchGoogleAdsResearchRows,
}));
vi.mock("@/shared/keyword-locations", () => ({
  getKeywordDataProvider: mocks.getKeywordDataProvider,
}));

describe("keyword research explicit refresh", () => {
  const input = {
    projectId: "project_1",
    keywords: ["Linux VPS"],
    locationCode: 2840,
    languageCode: "en",
    resultLimit: 150,
    mode: "related",
    clickstream: false,
  } as ResolvedResearchKeywordsInput;
  const billingCustomer = {
    organizationId: "org_1",
  } as BillingCustomerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildCacheKey.mockResolvedValue("cache-key");
    mocks.getCached.mockResolvedValue({
      rows: [],
      source: "related",
      usedFallback: false,
      diagnostics: {
        requestedMode: "related",
        threshold: 5,
        sourceAttempts: [],
      },
    });
    mocks.findLatestResearchSnapshot.mockResolvedValue({
      id: "old_snapshot",
      payload: { rows: [] },
    });
    mocks.getKeywordDataProvider.mockReturnValue("dataforseo");
    mocks.fetchResearchRowsBySource.mockResolvedValue([
      {
        keyword: "linux vps",
        searchVolume: 100,
        trend: [],
        cpc: 1,
        competition: 0.4,
        keywordDifficulty: 20,
        intent: "transactional",
      },
    ]);
    mocks.setCached.mockResolvedValue(undefined);
    mocks.saveResearchSnapshot.mockResolvedValue({
      id: "new_snapshot",
      requestHash: "hash_new",
    });
    mocks.upsertKeywordMetric.mockResolvedValue(undefined);
  });

  it("bypasses cache and old snapshot and saves a new snapshot without deleting history", async () => {
    const result = await research(input, billingCustomer, undefined, {
      refresh: true,
    });

    expect(mocks.getCached).not.toHaveBeenCalled();
    expect(mocks.findLatestResearchSnapshot).not.toHaveBeenCalled();
    expect(mocks.fetchResearchRowsBySource).toHaveBeenCalledTimes(1);
    expect(mocks.saveResearchSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.saveResearchSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        researchType: "research_keywords",
        origin: "provider",
      }),
    );
    expect(result.reuseSource).toBe("provider");
  });
});
