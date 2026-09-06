import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertCost: vi.fn(),
}));

vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: {
      insertResearchCost: mocks.insertCost,
    },
  }),
);

import {
  calculateOpenSeoCredits,
  dataforseoProviderCategory,
  recordDataforseoProviderCost,
} from "./providerCostRecorder";

describe("providerCostRecorder", () => {
  beforeEach(() => {
    mocks.insertCost.mockReset();
    mocks.insertCost.mockResolvedValue(undefined);
  });

  it("derives the real DataForSEO source from the provider path", () => {
    expect(
      dataforseoProviderCategory([
        "v3",
        "dataforseo_labs",
        "google",
        "related_keywords",
        "live",
      ]),
    ).toBe("dataforseo:dataforseo_labs");

    expect(
      dataforseoProviderCategory(["v3", "backlinks", "summary", "live"]),
    ).toBe("dataforseo:backlinks");
  });

  it("records the real provider cost and supplied credit charge", async () => {
    await recordDataforseoProviderCost({
      projectId: "project_1",
      billing: {
        path: ["v3", "serp", "google", "organic", "live", "advanced"],
        costUsd: 0.0123,
      },
      creditsCharged: 37,
    });

    expect(mocks.insertCost).toHaveBeenCalledWith({
      projectId: "project_1",
      tool: "dataforseo:/v3/serp/google/organic/live/advanced",
      providerCategory: "dataforseo:serp",
      requestSize: 1,
      cacheHit: false,
      providerCostUsd: "0.0123",
      creditsCharged: 37,
    });
  });

  it("skips zero-cost provider calls", async () => {
    await recordDataforseoProviderCost({
      projectId: "project_1",
      billing: { path: ["v3", "appendix", "user_data"], costUsd: 0 },
      creditsCharged: 0,
    });

    expect(mocks.insertCost).not.toHaveBeenCalled();
  });

  it("calculates hosted OpenSEO credits deterministically", () => {
    expect(calculateOpenSeoCredits(0)).toBe(0);
    expect(calculateOpenSeoCredits(0.05)).toBeGreaterThan(0);
  });
});
