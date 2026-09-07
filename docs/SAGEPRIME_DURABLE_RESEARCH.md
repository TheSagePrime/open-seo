# SagePrime Durable Research System

Status: **Production verified**

Scope: SagePrime custom layer only (`sageprime`).

Do not merge these customizations into `main`. `main` remains the clean upstream base.

---

## 1. Purpose

OpenSEO can purchase SEO research from DataForSEO. Short-lived cache alone is not enough for paid research because cache expiry must not force the system to buy the same usable evidence again.

The durable research system adds a permanent evidence layer between short cache and DataForSEO.

Core rule:

```text
Never buy research again when usable purchased research already exists.
```

This does **not** mean research is forever current. It means previously purchased evidence remains reusable until a caller deliberately requests fresh research.

---

## 2. Lookup model

### `research_keywords`

```text
short R2 cache
→ durable research snapshot
→ DataForSEO only when no reusable evidence exists
```

### `get_keyword_metrics`

```text
short R2 cache
→ exact durable snapshot
→ existing per-keyword durable DB metrics
→ DataForSEO only for missing keywords
```

This is intentionally stronger than request-level caching. If a new request contains a different batch shape, existing metrics can still be reused per keyword.

Example:

```text
request: [linux vps, windows vps]
DB already has: linux vps

result:
linux vps   → durable DB metric
windows vps → provider
```

Only the missing keyword is purchased.

### `get_serp_results`

```text
durable SERP snapshot
→ DataForSEO only when no matching snapshot exists
```

---

## 3. Durable storage

The feature adds:

```text
project_research_snapshots
```

Each snapshot stores durable evidence for a specific normalized research request.

Important fields include:

- project ID
- research type
- normalized request hash
- normalized request JSON
- payload JSON
- source
- provider category
- provider cost when known
- origin (`provider`, `backfill`, or `import`)
- original research timestamp
- creation timestamp

Old snapshots are not deleted when new research is purchased.

This gives the project a history of research evidence instead of a single replaceable cache value.

---

## 4. Request identity

Snapshot reuse is only correct when the stored request is semantically the same as the new request.

The durable layer therefore uses normalized request identity.

### Keyword metrics identity

Includes:

- normalized/deduplicated/sorted keywords
- project
- location code
- language code
- clickstream setting

The keyword list is sorted so different input order does not create a different identity.

Example:

```text
["Windows VPS", "Linux VPS"]
["linux vps", "windows vps"]
```

These normalize to the same request identity.

### Keyword research identity

Includes:

- normalized seed keyword(s)
- location code
- language code
- result limit
- mode
- depth
- clickstream setting

Seed ordering is not blindly sorted because the first seed can be semantically meaningful in the research service.

### SERP identity

Includes:

- normalized keyword
- location code
- language code
- depth

A different market, language, clickstream mode, or SERP depth must not accidentally reuse incompatible evidence.

---

## 5. Explicit refresh semantics

Supported paid-research paths accept explicit refresh behavior.

```text
refresh=true
```

means:

```text
bypass short cache
→ bypass durable snapshot / durable metric reuse
→ call provider
→ save new evidence
→ preserve older evidence
```

Important operational rule:

```text
Do not use refresh=true to test snapshot reuse.
```

It is designed to force fresh paid research.

Default requests should reuse existing evidence whenever possible.

---

## 6. Clickstream separation

Clickstream-refined keyword metrics are semantically different from normal keyword metrics and have different provider cost behavior.

The legacy `keyword_metrics` table does not store a clickstream dimension.

Therefore:

```text
normal metrics request
→ may reuse legacy per-keyword DB metrics

clickstream request
→ must not reuse normal legacy DB metrics
```

This prevents silent data mixing.

---

## 7. Failure isolation

A successful provider result must not become a failed MCP response just because durable bookkeeping temporarily fails.

Snapshot lookup and persistence are isolated.

Desired behavior:

```text
provider succeeds
snapshot persistence fails
→ user still receives provider result
→ error is logged
```

The short cache still protects immediate retries while the persistence issue is investigated.

This rule exists because bookkeeping is secondary to returning already-purchased research safely.

---

## 8. Research cost history

Provider purchases are recorded centrally by the DataForSEO client.

Durable reuse is recorded as zero-cost reuse.

Reuse sources can include:

```text
cache
snapshot
database
provider
```

A durable snapshot hit must not create a second provider charge record.

The useful distinction is:

```text
cache hit    = temporary optimization
snapshot hit = durable previously purchased evidence
database hit = durable per-keyword metric reuse
provider     = fresh paid research
```

---

## 9. MCP tools

### `list_research_snapshots`

Purpose: inspect durable research for a project.

Properties:

- free
- read-only
- no DataForSEO call
- can filter by research type
- payload inclusion is optional to keep normal responses small

Use it before purchasing research when historical evidence may already exist.

### `backfill_research_snapshots`

Purpose: import historical paid research that predates the durable snapshot system.

Supported types:

- `research_keywords`
- `get_keyword_metrics`
- `get_serp_results`

Properties:

- zero provider calls
- does not save discovered keywords as approved target keywords
- preserves historical `researchedAt`
- idempotent by project + research type + normalized request + research timestamp
- maximum 20 snapshots per call

A second identical backfill should skip existing records.

---

## 10. Backfill safety rule

Research evidence and approved target keywords are separate concepts.

```text
Research Snapshot
= evidence we purchased or imported

Saved Keyword
= keyword explicitly selected for the project
```

Backfill must never convert every discovered keyword into a saved keyword automatically.

This separation was production-tested.

---

## 11. Production acceptance test

The production rollout was accepted only after the short cache was deliberately removed for one known historical request.

Test sequence:

```text
1. historical durable snapshot exists
2. identify exact short-cache object
3. delete only that cache object
4. call research_keywords normally
5. expect snapshot reuse
6. provider-call delta must remain 0
7. provider-cost delta must remain $0
8. call same request again
9. expect short cache reuse
```

Observed production result:

```text
first request after cache deletion
→ reuseSource = snapshot
→ provider calls = 0
→ provider cost delta = $0.00000

second request
→ reuseSource = cache
→ provider calls = 0
```

This proves the durable layer works independently of the short cache and that snapshot reuse repopulates the short cache correctly.

---

## 12. Important lesson about R2 cache

The self-hosted short R2 cache is persistent.

A redeploy does **not** necessarily clear it.

Therefore this is not a valid standalone durable-reuse proof:

```text
redeploy app
→ call same request
→ request returns cache
```

The cache can survive deployment.

To test the durable snapshot path, delete only the exact cache object for the test request, never the entire bucket.

Do not use `refresh=true` for this test.

---

## 13. Production rollout proof

The first historical production backfill imported:

```text
5 research_keywords snapshots
6 SERP snapshots
11 total snapshots
```

A second identical run produced:

```text
0 imported
11 skipped
```

This proved idempotency.

Existing saved keywords remained unchanged during the operation.

Provider calls during deploy, migration, and backfill remained zero.

---

## 14. Test and CI requirements

Before merging changes to this system, run the complete repository validation chain.

The current repository gate is:

```text
Prettier
→ Knip
→ TypeScript
→ badseo TypeScript
→ Oxlint type-aware
→ plugin skill sync validation
```

Required commands include:

```bash
pnpm db:generate
pnpm prettier --check .
pnpm exec tsc --noEmit
pnpm oxlint . --type-aware
pnpm ci:check
pnpm test:ci
```

The production implementation was accepted with:

```text
Oxlint: PASS
ci:check: PASS
148 test files passed
1,202 tests passed
0 failed
```

`pnpm db:generate` also confirmed that no unintended additional migration was generated after the migration correction.

---

## 15. Migration rule

The durable snapshot migration must create only the new snapshot table and its indexes/FK changes.

Do not recreate tables that already exist in earlier migrations.

Both SQLite and PostgreSQL migration trees must remain aligned with their schema definitions.

Always run `pnpm db:generate` after manual migration repair. A clean result is part of the proof that Drizzle metadata and schema state still agree.

---

## 16. Current boundaries

This durable research system currently protects these paths:

```text
research_keywords
get_keyword_metrics
get_serp_results
```

Do not describe it as universal permanent reuse for every DataForSEO endpoint in OpenSEO.

Other research families, such as domain, backlink, or site-audit data, require their own explicit durable strategy before the same guarantee can be made.

---

## 17. Known non-guarantees

### Concurrency / singleflight

The implementation does not currently prove that two truly simultaneous cold misses can never both reach the provider.

Do not claim exact-once provider charging under concurrent cold requests unless a separate singleflight/locking mechanism is added and tested.

### Freshness

Durable means reusable, not automatically current.

The default strategy can reuse old research indefinitely unless a caller deliberately requests fresh data.

A future enhancement may add age-based controls such as `maxAge` or freshness policies.

### Deleted/corrupt evidence

If durable evidence is deleted, corrupt, or cannot be read, the system can fall through to the provider.

Monitoring should detect snapshot read/persistence failures and unusual provider-spend increases.

---

## 18. Recommended monitoring

Track at least:

```text
short-cache hits
durable snapshot hits
durable per-keyword DB hits
provider hits
provider cost
snapshot lookup failures
snapshot persistence failures
```

Operational alerts should focus on unexpected transitions such as:

```text
known reusable research
→ provider purchase
```

or:

```text
snapshot reuse event
→ non-zero provider cost
```

---

## 19. Branch architecture

SagePrime uses this branch model:

```text
main
= clean official/upstream base

sageprime
= main + SagePrime custom layer

feature/*
= temporary implementation branches
```

Durable research was developed on:

```text
feat/durable-research-snapshots
```

and merged into:

```text
sageprime
```

It must not be merged directly into `main` as part of normal SagePrime operation.

---

## 20. Production merge reference

Original feature PR:

```text
PR #4
feat(research-ops): durable paid research reuse
```

Production SagePrime merge commit:

```text
ad60160c659e4431f4b04e295e8221de48e73c7d
```

This document describes the behavior accepted after that rollout.

---

## 21. Operator checklist

Before fresh paid research:

```text
1. confirm project + market
2. check short cache automatically
3. check durable snapshot automatically
4. check durable per-keyword metrics when applicable
5. purchase only missing evidence
```

For historical import:

```text
1. preserve original research timestamp
2. preserve market and request dimensions
3. use backfill tool
4. verify provider-call delta = 0
5. run backfill again
6. verify all records skip as existing
7. verify saved-keyword set did not change
```

For durable-reuse acceptance testing:

```text
1. choose one known snapshot
2. remove only its exact short-cache object
3. do not use refresh=true
4. call normally
5. require reuseSource=snapshot
6. require provider calls=0
7. require provider cost=$0
8. repeat request
9. require reuseSource=cache
```

---

## 22. Core design principle

Keep these concepts separate:

```text
cache       = temporary speed layer
snapshot    = durable research evidence
saved data  = intentionally selected project state
provider    = paid source of missing/fresh evidence
```

That separation is the reason the system can be both cost-safe and operationally understandable.
