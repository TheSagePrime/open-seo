import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyContextUpdates: vi.fn(),
  insertCost: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({
    ProjectContextService: {
      applyContextUpdates: mocks.applyContextUpdates,
    },
  }),
);

vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: {
      insertResearchCost: mocks.insertCost,
      listResearchCosts: vi.fn(),
    },
  }),
);

import { recordPaidResearchJob } from "./paidResearchRecorder";

describe("recordPaidResearchJob", () => {
  beforeEach(() => {
    mocks.applyContextUpdates.mockReset();
    mocks.insertCost.mockReset();
    mocks.waitUntil.mockReset();
    mocks.applyContextUpdates.mockResolvedValue({});
    mocks.insertCost.mockResolvedValue(undefined);
  });

  it("writes the research log after a paid miss without duplicating provider cost", async () => {
    const summary =
      "get_keyword_metrics: 3 keywords, US/en, cache miss, clickstream off";
    const write = recordPaidResearchJob({
      projectId: "project_1",
      tool: "get_keyword_metrics",
      providerCategory: "dataforseo_labs",
      requestSize: 3,
      cacheHit: false,
      summary,
    });

    expect(mocks.waitUntil).toHaveBeenCalledWith(write);
    await write;

    expect(mocks.insertCost).not.toHaveBeenCalled();
    expect(mocks.applyContextUpdates).toHaveBeenCalledWith(
      "project_1",
      [{ appendResearchLog: { summary } }],
      "mcp",
    );
  });

  it("records a zero-cost cache hit without appending the research log", async () => {
    await recordPaidResearchJob({
      projectId: "project_1",
      tool: "research_keywords",
      providerCategory: "dataforseo_labs",
      requestSize: 1,
      cacheHit: true,
      summary: "research_keywords: reused cache for linux vps",
    });

    expect(mocks.insertCost).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheHit: true,
        providerCategory: "cache",
        providerCostUsd: "0",
        creditsCharged: 0,
      }),
    );
    expect(mocks.applyContextUpdates).not.toHaveBeenCalled();
  });

  it("does not fail research when bookkeeping fails", async () => {
    mocks.applyContextUpdates.mockRejectedValueOnce(
      new Error("db unavailable"),
    );

    await expect(
      recordPaidResearchJob({
        projectId: "project_1",
        tool: "research_keywords",
        providerCategory: "dataforseo_labs",
        requestSize: 1,
        cacheHit: false,
        summary: "research_keywords: linux vps",
      }),
    ).resolves.toBeUndefined();
  });
});
