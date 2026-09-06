import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projectResearchSnapshots } from "@/db/schema";

export type ResearchSnapshotOrigin = "provider" | "backfill" | "import";

export type ResearchSnapshotInput = {
  projectId: string;
  researchType: string;
  request: Record<string, unknown>;
  payload: unknown;
  source?: string | null;
  providerCategory?: string | null;
  providerCostUsd?: string | null;
  origin?: ResearchSnapshotOrigin;
  researchedAt?: string;
};

export type ResearchSnapshot = {
  id: string;
  projectId: string;
  researchType: string;
  requestHash: string;
  request: Record<string, unknown>;
  payload: unknown;
  source: string | null;
  providerCategory: string | null;
  providerCostUsd: string | null;
  origin: ResearchSnapshotOrigin;
  researchedAt: string;
  createdAt: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalResearchRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  return canonicalize(request) as Record<string, unknown>;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function buildResearchSnapshotHash(
  researchType: string,
  request: Record<string, unknown>,
): Promise<string> {
  const canonical = canonicalResearchRequest(request);
  return sha256Hex(`${researchType}:${JSON.stringify(canonical)}`);
}

function parseSnapshotRow(
  row: typeof projectResearchSnapshots.$inferSelect,
): ResearchSnapshot | null {
  try {
    return {
      id: row.id,
      projectId: row.projectId,
      researchType: row.researchType,
      requestHash: row.requestHash,
      request: JSON.parse(row.requestJson) as Record<string, unknown>,
      payload: JSON.parse(row.payloadJson) as unknown,
      source: row.source,
      providerCategory: row.providerCategory,
      providerCostUsd: row.providerCostUsd,
      origin: row.origin,
      researchedAt: row.researchedAt,
      createdAt: row.createdAt,
    };
  } catch {
    return null;
  }
}

export async function findLatestResearchSnapshot(params: {
  projectId: string;
  researchType: string;
  request: Record<string, unknown>;
}): Promise<ResearchSnapshot | null> {
  const requestHash = await buildResearchSnapshotHash(
    params.researchType,
    params.request,
  );
  const rows = await db
    .select()
    .from(projectResearchSnapshots)
    .where(
      and(
        eq(projectResearchSnapshots.projectId, params.projectId),
        eq(projectResearchSnapshots.researchType, params.researchType),
        eq(projectResearchSnapshots.requestHash, requestHash),
      ),
    )
    .orderBy(
      desc(projectResearchSnapshots.researchedAt),
      desc(projectResearchSnapshots.createdAt),
    )
    .limit(1);
  return rows[0] ? parseSnapshotRow(rows[0]) : null;
}

export async function researchSnapshotExists(params: {
  projectId: string;
  researchType: string;
  request: Record<string, unknown>;
  researchedAt: string;
}): Promise<boolean> {
  const requestHash = await buildResearchSnapshotHash(
    params.researchType,
    params.request,
  );
  const rows = await db
    .select({ id: projectResearchSnapshots.id })
    .from(projectResearchSnapshots)
    .where(
      and(
        eq(projectResearchSnapshots.projectId, params.projectId),
        eq(projectResearchSnapshots.researchType, params.researchType),
        eq(projectResearchSnapshots.requestHash, requestHash),
        eq(projectResearchSnapshots.researchedAt, params.researchedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function saveResearchSnapshot(
  input: ResearchSnapshotInput,
): Promise<{ id: string; requestHash: string }> {
  const request = canonicalResearchRequest(input.request);
  const requestHash = await buildResearchSnapshotHash(input.researchType, request);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(projectResearchSnapshots).values({
    id,
    projectId: input.projectId,
    researchType: input.researchType,
    requestHash,
    requestJson: JSON.stringify(request),
    payloadJson: JSON.stringify(input.payload),
    source: input.source ?? null,
    providerCategory: input.providerCategory ?? null,
    providerCostUsd: input.providerCostUsd ?? null,
    origin: input.origin ?? "provider",
    researchedAt: input.researchedAt ?? now,
    createdAt: now,
  });
  return { id, requestHash };
}

export async function listResearchSnapshots(
  projectId: string,
  limit = 100,
): Promise<ResearchSnapshot[]> {
  const rows = await db
    .select()
    .from(projectResearchSnapshots)
    .where(eq(projectResearchSnapshots.projectId, projectId))
    .orderBy(
      desc(projectResearchSnapshots.researchedAt),
      desc(projectResearchSnapshots.createdAt),
    )
    .limit(limit);
  return rows.flatMap((row) => {
    const parsed = parseSnapshotRow(row);
    return parsed ? [parsed] : [];
  });
}
