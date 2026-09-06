import { describe, expect, it } from "vitest";
import { dedupeResearchSeeds } from "./seedDedupe";

describe("dedupeResearchSeeds", () => {
  it("keeps the first seed and drops later case/whitespace duplicates", () => {
    expect(
      dedupeResearchSeeds([
        { seed: "Linux VPS" },
        { seed: " linux vps " },
        { seed: "LINUX VPS" },
      ]),
    ).toEqual([{ seed: "Linux VPS" }]);
  });

  it("treats the same seed in different markets as distinct paid work", () => {
    expect(
      dedupeResearchSeeds([
        { seed: "rdp", locationCode: 2840, languageCode: "en" },
        { seed: "rdp", locationCode: 2276, languageCode: "de" },
        { seed: "RDP", locationCode: 2840, languageCode: "en" },
      ]),
    ).toEqual([
      { seed: "rdp", locationCode: 2840, languageCode: "en" },
      { seed: "rdp", locationCode: 2276, languageCode: "de" },
    ]);
  });

  it("drops blank seeds", () => {
    expect(
      dedupeResearchSeeds([{ seed: "   " }, { seed: "windows vps" }]),
    ).toEqual([{ seed: "windows vps" }]);
  });
});
