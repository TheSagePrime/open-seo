import { beforeEach, describe, expect, it, vi } from "vitest";
import { researchKeywordsTool } from "./research-keywords";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  research: vi.fn(),
  recordPaidResearchJob: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/keywords/services/KeywordResearchService", () => ({
  KeywordResearchService: { research: mocks.research },
}));
vi.mock("@/server/features/research-ops/paidResearchRecorder", () => ({
  recordPaidResearchJob: mocks.recordPaidResearchJob,
}));

describe("research_keywords efficiency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.recordPaidResearchJob.mockResolvedValue(undefined);
    mocks.research.mockResolvedValue({
      rows: [{ keyword: "linux vps", searchVolume: 100 }],
      source: "related",
      usedFallback: false,
      cacheHit: false,
      reuseSource: "provider",
      diagnostics: { requestedMode: "auto", threshold: 5, sourceAttempts: [] },
    });
  });

  it("dedupes seeds before paid research and records the job", async () => {
    await researchKeywordsTool.handler(
      {
        projectId: "project_1",
        seeds: [
          { seed: "Linux VPS" },
          { seed: "linux vps" },
          { seed: " LINUX VPS " },
        ],
      },
      makeToolContext(),
    );

    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(mocks.research.mock.calls[0]?.[0].keywords).toEqual(["Linux VPS"]);
    expect(mocks.research.mock.calls[0]?.[0].clickstream).toBe(false);
    expect(mocks.recordPaidResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        tool: "research_keywords",
        requestSize: 1,
        cacheHit: false,
      }),
    );
  });

  it("forwards refresh=true so normal reuse is explicitly bypassed", async () => {
    await researchKeywordsTool.handler(
      {
        projectId: "project_1",
        seeds: [{ seed: "Linux VPS" }],
        refresh: true,
      },
      makeToolContext(),
    );

    expect(mocks.research).toHaveBeenCalledTimes(1);
    expect(mocks.research.mock.calls[0]?.[3]).toEqual({ refresh: true });
    expect(mocks.recordPaidResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        tool: "research_keywords",
        cacheHit: false,
        summary: expect.stringContaining("explicit refresh"),
      }),
    );
  });
});
