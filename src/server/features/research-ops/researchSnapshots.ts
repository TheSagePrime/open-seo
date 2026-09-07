import { and, desc, eq } from "drizzle-orm";
import { sortBy } from "remeda";
import { db } from "@/db";
import { projectResearchSnapshots } from "@/db/schema";

type ResearchSnapshotOrigin = "provider" | "backfill" | "import";

type ResearchSnapshotInput = {
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

type ResearchSnapshot = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const entries = sortBy(
      Object.entries(value).filter(([, item]) => item !== undefined),
      ([key]) => key,
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalResearchRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const canonical = canonicalize(request);
  if (!isRecord(canonical)) {
    throw new TypeError("Research snapshot request must be an object");
  }
  return canonical;
}

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
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

async function buildResearchSnapshotHash(
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
    const request = parseJson(row.requestJson);
    if (!isRecord(request)) return null;
    const payload = parseJson(row.payloadJson);
    return {
      id: row.id,
      projectId: row.projectId,
      researchType: row.researchType,
      requestHash: row.requestHash,
      request,
      payload,
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
  const requestHash = await buildResearchSnapshotHash(
    input.researchType,
    request,
  );
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
