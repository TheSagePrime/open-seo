export type ResearchSeed = {
  seed: string;
  locationCode?: number;
  languageCode?: string;
};

export function dedupeResearchSeeds<T extends ResearchSeed>(seeds: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of seeds) {
    const normalized = item.seed.trim().toLowerCase();
    if (!normalized) continue;

    const key = `${normalized}\0${item.locationCode ?? ""}\0${item.languageCode ?? ""}`;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push({ ...item, seed: item.seed.trim() });
  }

  return unique;
}
