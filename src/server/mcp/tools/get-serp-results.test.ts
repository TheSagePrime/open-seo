import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSerpResultsTool } from "./get-serp-results";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
  findLatestResearchSnapshot: vi.fn(),
  saveResearchSnapshot: vi.fn(),
  recordPaidResearchJob: vi.fn(),
  live: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
  SERP_ANALYSIS_DEPTH: 20,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/research-ops/researchSnapshots", () => ({
  findLatestResearchSnapshot: mocks.findLatestResearchSnapshot,
  saveResearchSnapshot: mocks.saveResearchSnapshot,
}));
vi.mock("@/server/features/research-ops/paidResearchRecorder", () => ({
  recordPaidResearchJob: mocks.recordPaidResearchJob,
}));

describe("get_serp_results durable research reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.createDataforseoClient.mockReturnValue({
      serp: { live: mocks.live },
    });
    mocks.recordPaidResearchJob.mockResolvedValue(undefined);
    mocks.saveResearchSnapshot.mockResolvedValue({ requestHash: "hash_new" });
  });

  it("reuses a matching durable SERP snapshot without calling the provider", async () => {
    const storedItems = [
      {
        type: "organic",
        rank: 1,
        title: "Linux VPS",
        url: "https://example.com/linux-vps",
        domain: "example.com",
        description: "Stored result",
      },
    ];
    mocks.findLatestResearchSnapshot.mockResolvedValue({
      payload: { items: storedItems },
    });

    const result = await getSerpResultsTool.handler(
      {
        projectId: "project_1",
        queries: [{ keyword: "Linux VPS" }],
      },
      makeToolContext(),
    );

    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.saveResearchSnapshot).not.toHaveBeenCalled();
    expect(result.structuredContent.results[0]).toEqual(
      expect.objectContaining({
        ok: true,
        items: storedItems,
        reuseSource: "snapshot",
      }),
    );
    expect(mocks.recordPaidResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        tool: "get_serp_results",
        cacheHit: true,
        reuseSource: "snapshot",
      }),
    );
  });

  it("refresh=true bypasses the old snapshot, calls the provider, and saves a new snapshot", async () => {
    mocks.findLatestResearchSnapshot.mockResolvedValue({
      id: "old_snapshot",
      payload: { items: [] },
    });
    mocks.live.mockResolvedValue([
      {
        type: "organic",
        rank_absolute: 1,
        rank_group: 1,
        title: "Fresh Linux VPS",
        url: "https://fresh.example/linux-vps",
        domain: "fresh.example",
        description: "Fresh result",
      },
    ]);

    await getSerpResultsTool.handler(
      {
        projectId: "project_1",
        queries: [{ keyword: "Linux VPS" }],
        refresh: true,
      },
      makeToolContext(),
    );

    expect(mocks.findLatestResearchSnapshot).not.toHaveBeenCalled();
    expect(mocks.live).toHaveBeenCalledTimes(1);
    expect(mocks.saveResearchSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        researchType: "get_serp_results",
        origin: "provider",
      }),
    );
    expect(mocks.recordPaidResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        tool: "get_serp_results",
        cacheHit: false,
      }),
    );
  });
});
