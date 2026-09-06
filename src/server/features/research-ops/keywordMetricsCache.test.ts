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

const snapshots = vi.hoisted(() => ({
  findLatestResearchSnapshot: vi.fn(),
  saveResearchSnapshot: vi.fn(),
}));

const durableMetrics = vi.hoisted(() => ({
  loadDurableKeywordMetrics: vi.fn(),
  persistDurableKeywordMetrics: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: r2 },
}));

vi.mock("./paidResearchRecorder", () => ({
  recordPaidResearchJob: bookkeeping.recordPaidResearchJob,
}));

vi.mock("./researchSnapshots", () => ({
  findLatestResearchSnapshot: snapshots.findLatestResearchSnapshot,
  saveResearchSnapshot: snapshots.saveResearchSnapshot,
}));

vi.mock("./durableKeywordMetrics", () => ({
  loadDurableKeywordMetrics: durableMetrics.loadDurableKeywordMetrics,
  persistDurableKeywordMetrics: durableMetrics.persistDurableKeywordMetrics,
}));

import { fetchCachedKeywordMetrics } from "./keywordMetricsCache";

describe("fetchCachedKeywordMetrics", () => {
  const fetchLive = vi.fn();
  const metricRow = {
    keyword: "linux vps",
    searchVolume: 100,
    cpc: 1,
    competition: 0.2,
    competitionLevel: "LOW",
    keywordDifficulty: 10,
    intent: "commercial",
    monthlySearches: [],
  };
  const windowsMetricRow = {
    ...metricRow,
    keyword: "windows vps",
    searchVolume: 200,
  };

  beforeEach(() => {
    r2.store.clear();
    fetchLive.mockReset();
    bookkeeping.recordPaidResearchJob.mockReset();
    bookkeeping.recordPaidResearchJob.mockResolvedValue(undefined);
    snapshots.findLatestResearchSnapshot.mockReset();
    snapshots.findLatestResearchSnapshot.mockResolvedValue(null);
    snapshots.saveResearchSnapshot.mockReset();
    snapshots.saveResearchSnapshot.mockResolvedValue({
      id: "snapshot_1",
      requestHash: "hash_1",
    });
    durableMetrics.loadDurableKeywordMetrics.mockReset();
    durableMetrics.loadDurableKeywordMetrics.mockResolvedValue([]);
    durableMetrics.persistDurableKeywordMetrics.mockReset();
    durableMetrics.persistDurableKeywordMetrics.mockResolvedValue(undefined);
    fetchLive.mockResolvedValue([metricRow]);
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
    expect(first).toEqual({
      rows: [metricRow],
      cacheHit: false,
      reuseSource: "provider",
    });
    expect(second).toEqual({
      rows: [metricRow],
      cacheHit: true,
      reuseSource: "cache",
    });
    expect(fetchLive.mock.calls[0]?.[0].keywords).toEqual(["linux vps"]);
    expect(snapshots.saveResearchSnapshot).toHaveBeenCalledTimes(1);
    expect(durableMetrics.persistDurableKeywordMetrics).toHaveBeenCalledTimes(
      1,
    );
    expect(bookkeeping.recordPaidResearchJob).not.toHaveBeenCalled();
  });

  it("reuses a durable snapshot when the short cache is missing", async () => {
    snapshots.findLatestResearchSnapshot.mockResolvedValue({
      payload: { rows: [metricRow] },
    });
    const input = {
      organizationId: "org_1",
      projectId: "project_1",
      keywords: ["Linux VPS"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: false,
    };

    const first = await fetchCachedKeywordMetrics(input, fetchLive);
    const second = await fetchCachedKeywordMetrics(input, fetchLive);

    expect(first).toEqual({
      rows: [metricRow],
      cacheHit: true,
      reuseSource: "snapshot",
    });
    expect(second).toEqual({
      rows: [metricRow],
      cacheHit: true,
      reuseSource: "cache",
    });
    expect(fetchLive).not.toHaveBeenCalled();
    expect(durableMetrics.loadDurableKeywordMetrics).not.toHaveBeenCalled();
    expect(snapshots.saveResearchSnapshot).not.toHaveBeenCalled();
  });

  it("reuses old per-keyword DB metrics even when the original batch shape is gone", async () => {
    durableMetrics.loadDurableKeywordMetrics.mockResolvedValue([metricRow]);

    const result = await fetchCachedKeywordMetrics(
      {
        organizationId: "org_1",
        projectId: "project_1",
        keywords: ["Linux VPS"],
        locationCode: 2840,
        languageCode: "en",
      },
      fetchLive,
    );

    expect(result).toEqual({
      rows: [metricRow],
      cacheHit: true,
      reuseSource: "database",
    });
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it("buys only missing keywords when part of a metrics batch already exists durably", async () => {
    durableMetrics.loadDurableKeywordMetrics.mockResolvedValue([metricRow]);
    fetchLive.mockResolvedValue([windowsMetricRow]);

    const result = await fetchCachedKeywordMetrics(
      {
        organizationId: "org_1",
        projectId: "project_1",
        keywords: ["Windows VPS", "Linux VPS"],
        locationCode: 2840,
        languageCode: "en",
      },
      fetchLive,
    );

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(fetchLive).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ["windows vps"] }),
    );
    expect(result.rows.map((row) => row.keyword)).toEqual([
      "linux vps",
      "windows vps",
    ]);
    expect(result.reuseSource).toBe("provider");
    expect(durableMetrics.persistDurableKeywordMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [windowsMetricRow] }),
    );
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
    expect(first).toEqual({
      rows: [],
      cacheHit: false,
      reuseSource: "provider",
    });
    expect(second).toEqual({
      rows: [],
      cacheHit: true,
      reuseSource: "cache",
    });
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
        reuseSource: "cache",
      }),
    );
  });

  it("bypasses cache, snapshots, and durable DB metrics when refresh is explicitly requested", async () => {
    snapshots.findLatestResearchSnapshot.mockResolvedValue({
      payload: { rows: [metricRow] },
    });
    durableMetrics.loadDurableKeywordMetrics.mockResolvedValue([metricRow]);

    const result = await fetchCachedKeywordMetrics(
      {
        organizationId: "org_1",
        projectId: "project_1",
        keywords: ["linux vps"],
        locationCode: 2840,
        languageCode: "en",
        refresh: true,
      },
      fetchLive,
    );

    expect(result.reuseSource).toBe("provider");
    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(snapshots.findLatestResearchSnapshot).not.toHaveBeenCalled();
    expect(durableMetrics.loadDurableKeywordMetrics).not.toHaveBeenCalled();
    expect(snapshots.saveResearchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not use legacy DB metrics for clickstream-refined requests", async () => {
    durableMetrics.loadDurableKeywordMetrics.mockResolvedValue([metricRow]);

    await fetchCachedKeywordMetrics(
      {
        organizationId: "org_1",
        projectId: "project_1",
        keywords: ["rdp"],
        locationCode: 2840,
        languageCode: "en",
        includeClickstreamData: true,
      },
      fetchLive,
    );

    expect(durableMetrics.loadDurableKeywordMetrics).not.toHaveBeenCalled();
    expect(fetchLive).toHaveBeenCalledWith(
      expect.objectContaining({
        includeClickstreamData: true,
        keywords: ["rdp"],
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
      expect.objectContaining({
        includeClickstreamData: false,
        keywords: ["rdp"],
      }),
    );
  });
});
