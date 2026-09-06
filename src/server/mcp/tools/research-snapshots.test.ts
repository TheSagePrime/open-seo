import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillResearchSnapshotsTool } from "./research-snapshots";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  researchSnapshotExists: vi.fn(),
  saveResearchSnapshot: vi.fn(),
  createDataforseoClient: vi.fn(),
  saveApprovedKeyword: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/research-ops/researchSnapshots", () => ({
  listResearchSnapshots: vi.fn(),
  researchSnapshotExists: mocks.researchSnapshotExists,
  saveResearchSnapshot: mocks.saveResearchSnapshot,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));
vi.mock("@/server/features/keywords/repositories/SavedKeywordRepository", () => ({
  SavedKeywordRepository: {
    save: mocks.saveApprovedKeyword,
  },
}));

describe("backfill_research_snapshots", () => {
  const researchedAt = "2026-09-02T12:00:00.000Z";
  const snapshot = {
    kind: "research_keywords" as const,
    seed: "Cheap Linux VPS",
    locationCode: 2840,
    languageCode: "en",
    resultLimit: 150 as const,
    mode: "auto" as const,
    clickstream: false,
    source: "related" as const,
    usedFallback: false,
    researchedAt,
    rows: [
      {
        keyword: "cheap linux vps",
        searchVolume: 100,
        trend: [],
        cpc: 1.25,
        competition: 0.5,
        keywordDifficulty: 30,
        intent: "transactional" as const,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.researchSnapshotExists.mockResolvedValue(false);
    mocks.saveResearchSnapshot.mockResolvedValue({ requestHash: "hash_1" });
  });

  it("imports historical research without provider or saved-keyword writes and preserves researchedAt", async () => {
    const result = await backfillResearchSnapshotsTool.handler(
      {
        projectId: "project_1",
        snapshots: [snapshot],
      },
      makeToolContext(),
    );

    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(mocks.saveApprovedKeyword).not.toHaveBeenCalled();
    expect(mocks.saveResearchSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.saveResearchSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        researchType: "research_keywords",
        origin: "backfill",
        researchedAt,
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({ imported: 1, skipped: 0 }),
    );
  });

  it("is idempotent when the same request and researchedAt already exist", async () => {
    mocks.researchSnapshotExists.mockResolvedValue(true);

    const result = await backfillResearchSnapshotsTool.handler(
      {
        projectId: "project_1",
        snapshots: [snapshot],
      },
      makeToolContext(),
    );

    expect(mocks.saveResearchSnapshot).not.toHaveBeenCalled();
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(mocks.saveApprovedKeyword).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual(
      expect.objectContaining({ imported: 0, skipped: 1 }),
    );
  });
});
