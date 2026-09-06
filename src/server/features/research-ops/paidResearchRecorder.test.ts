import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyContextUpdates: vi.fn(),
  insertCost: vi.fn(),
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
    mocks.applyContextUpdates.mockResolvedValue({});
    mocks.insertCost.mockResolvedValue(undefined);
  });

  it("writes cost history and a research-log entry after a paid miss", async () => {
    await recordPaidResearchJob({
      projectId: "project_1",
      tool: "get_keyword_metrics",
      providerCategory: "dataforseo_labs",
      requestSize: 3,
      cacheHit: false,
      summary:
        "get_keyword_metrics: 3 keywords, US/en, cache miss, clickstream off",
    });

    expect(mocks.insertCost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        tool: "get_keyword_metrics",
        providerCategory: "dataforseo_labs",
        requestSize: 3,
        cacheHit: false,
      }),
    );
    expect(mocks.applyContextUpdates).toHaveBeenCalledWith(
      "project_1",
      [
        expect.objectContaining({
          appendResearchLog: expect.objectContaining({
            summary: expect.stringContaining("get_keyword_metrics"),
          }),
        }),
      ],
      "mcp",
    );
  });

  it("records a cache hit without appending the research log", async () => {
    await recordPaidResearchJob({
      projectId: "project_1",
      tool: "research_keywords",
      providerCategory: "dataforseo_labs",
      requestSize: 1,
      cacheHit: true,
      summary: "research_keywords: reused cache for linux vps",
    });

    expect(mocks.insertCost).toHaveBeenCalledWith(
      expect.objectContaining({ cacheHit: true }),
    );
    expect(mocks.applyContextUpdates).not.toHaveBeenCalled();
  });
});
