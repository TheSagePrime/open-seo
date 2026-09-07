import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// ============================================================================
// Project memory: the shared AI context every surface (SAM, MCP, settings UI)
// reads and writes. Prose lives in the sections table; list-shaped knowledge is
// normalized so it stays joinable instead of buried in markdown.
// ============================================================================

// One row per (project, section). `key` is either a typed key
// ("business_overview", "current_goal", "positioning", "writing_preferences")
// or "custom:<slug>" for an agent-created section, in which case `title` holds
// its display name.
export const projectContextSections = sqliteTable(
  "project_context_sections",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedBy: text("updated_by", { enum: ["user", "sam", "mcp"] }).notNull(),
  },
  // The composite PK is project-leading, so it also serves the "load every
  // section for this project" read.
  (table) => [primaryKey({ columns: [table.projectId, table.key] })],
);

export const projectCompetitors = sqliteTable(
  "project_competitors",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Normalized bare host (lowercase, no protocol/www), so agents adding the
    // same competitor from different surfaces upsert onto one row.
    domain: text("domain").notNull(),
    name: text("name"),
    notes: text("notes"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedBy: text("updated_by", { enum: ["user", "sam", "mcp"] }).notNull(),
  },
  (table) => [
    uniqueIndex("project_competitors_project_domain_idx").on(
      table.projectId,
      table.domain,
    ),
  ],
);

// A curated shortlist of pages that matter, NOT a page inventory — the
// inventory lives in audit_pages and GSC.
export const projectKeyPages = sqliteTable(
  "project_key_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    role: text("role", { enum: ["hub", "spoke", "money", "other"] }).notNull(),
    topic: text("topic"),
    notes: text("notes"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedBy: text("updated_by", { enum: ["user", "sam", "mcp"] }).notNull(),
  },
  (table) => [
    uniqueIndex("project_key_pages_project_url_idx").on(
      table.projectId,
      table.url,
    ),
  ],
);

// What research has already been bought and what it concluded, so SAM and
// Claude Code stop re-buying the same paid research. Pruned to 90 days on
// append; the date is server-stamped, never supplied by the caller.
export const projectResearchLog = sqliteTable(
  "project_research_log",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    entryDate: text("entry_date").notNull(),
    summary: text("summary").notNull(),
    createdBy: text("created_by", { enum: ["user", "sam", "mcp"] }).notNull(),
    // entry_date is a day stamp, so recency needs its own column — same-day
    // entries would otherwise tie-break on a random uuid. The default emits
    // ISO (unlike current_timestamp's space format) because listResearchLog
    // orders this column lexicographically against app-written ISO stamps.
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("project_research_log_project_date_idx").on(
      table.projectId,
      table.entryDate,
    ),
  ],
);

// Durable evidence for paid research. Unlike the short R2 cache, snapshots do
// not expire merely because a TTL elapsed. Multiple rows with the same request
// hash are intentional: explicit refreshes preserve earlier evidence.
export const projectResearchSnapshots = sqliteTable(
  "project_research_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    researchType: text("research_type").notNull(),
    requestHash: text("request_hash").notNull(),
    requestJson: text("request_json").notNull(),
    payloadJson: text("payload_json").notNull(),
    source: text("source"),
    providerCategory: text("provider_category"),
    providerCostUsd: text("provider_cost_usd"),
    origin: text("origin", {
      enum: ["provider", "backfill", "import"],
    }).notNull(),
    researchedAt: text("researched_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("project_research_snapshots_lookup_idx").on(
      table.projectId,
      table.researchType,
      table.requestHash,
      table.researchedAt,
    ),
    index("project_research_snapshots_project_researched_idx").on(
      table.projectId,
      table.researchedAt,
    ),
  ],
);

// Simple per-project audit trail for paid research jobs. This is not a finance
// ledger: one row per MCP research job with cache hit/miss and request size.
export const projectResearchCostHistory = sqliteTable(
  "project_research_cost_history",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    providerCategory: text("provider_category").notNull(),
    requestSize: integer("request_size").notNull(),
    cacheHit: integer("cache_hit").notNull(),
    providerCostUsd: text("provider_cost_usd"),
    creditsCharged: integer("credits_charged"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("project_research_cost_history_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);
