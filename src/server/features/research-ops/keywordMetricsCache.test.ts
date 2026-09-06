import { beforeEach, describe, expect, it, vi } from "vitest";

const r2 = vi.hoisted(() => {
  const store = new Map<
    string,
    { body: string; customMetadata?: Record<string, string> }
  >();
  return {
    store,
    get: vi.fn(async (key: string) => {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        customMetadata: obj.customMetadata,
        text: async () => obj.body,
      };
    }),
    put: vi.fn(
      async (
        key: string,
        body: string,
        options?: { customMetadata?: Record<string, string> },
      ) => {
        store.set(key, { body, customMetadata: options?.customMetadata });
      },
    ),
  };
});

const bookkeeping = vi.hoisted(() => ({
  recordPaidResearchJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: r2 },
}));

vi.mock("./paidResearchRecorder", () => ({
  recordPaidResearchJob: bookkeeping.recordPaidResearchJob,
}));

import { fetchCachedKeywordMetrics } from "./keywordMetricsCache";

describe("fetchCachedKeywordMetrics", () => {
  const fetchLive = vi.fn();

  beforeEach(() => {
    r2.store.clear();
    fetchLive.mockReset();
    bookkeeping.recordPaidResearchJob.mockReset();
    bookkeeping.recordPaidResearchJob.mockResolvedValue(undefined);
    fetchLive.mockResolvedValue([
      {
        keyword: "linux vps",
        searchVolume: 100,
        cpc: 1,
        competition: 0.2,
        competitionLevel: "LOW",
        keywordDifficulty: 10,
        intent: "commercial",
        monthlySearches: [],
      },
    ]);
  });

  it("reuses a cached payload instead of calling the provider again", async () => {
    const input = {
      organizationId: "org_1",
      projectId: "project_1",
      keywords: ["Linux VPS", "linux vps"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: false,
    };

    const first = await fetchCachedKeywordMetrics(input, fetchLive);
    const second = await fetchCachedKeywordMetrics(input, fetchLive);

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.rows).toEqual(first.rows);
    expect(fetchLive.mock.calls[0]?.[0].keywords).toEqual(["linux vps"]);
    expect(bookkeeping.recordPaidResearchJob).not.toHaveBeenCalled();
  });

  it("reuses and records cached empty payloads without repaying for no-result keywords", async () => {
    fetchLive.mockResolvedValue([]);
    const input = {
      organizationId: "org_1",
      projectId: "project_1",
      keywords: ["sageprime cacheprobe"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: false,
    };

    const first = await fetchCachedKeywordMetrics(input, fetchLive);
    const second = await fetchCachedKeywordMetrics(input, fetchLive);

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ rows: [], cacheHit: false });
    expect(second).toEqual({ rows: [], cacheHit: true });
    expect(bookkeeping.recordPaidResearchJob).toHaveBeenCalledTimes(2);
    expect(bookkeeping.recordPaidResearchJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tool: "get_keyword_metrics",
        requestSize: 1,
        cacheHit: false,
      }),
    );
    expect(bookkeeping.recordPaidResearchJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tool: "get_keyword_metrics",
        requestSize: 1,
        cacheHit: true,
      }),
    );
  });

  it("does not enable clickstream unless explicitly requested", async () => {
    await fetchCachedKeywordMetrics(
      {
        organizationId: "org_1",
        projectId: "project_1",
        keywords: ["rdp"],
        locationCode: 2840,
        languageCode: "en",
      },
      fetchLive,
    );

    expect(fetchLive).toHaveBeenCalledWith(
      expect.objectContaining({ includeClickstreamData: false, keywords: ["rdp"] }),
    );
  });
});
