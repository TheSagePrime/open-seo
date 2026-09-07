# SagePrime Durable Research — Implementation Log, Failures, Fixes, and Lessons

Purpose: preserve the complete engineering history of the durable paid-research feature so Hermes and future agents do not repeat the same mistakes.

Final status: **PASS — merged, deployed, backfilled, and production verified.**

Production SagePrime merge commit:

```text
ad60160c659e4431f4b04e295e8221de48e73c7d
```

Original feature branch:

```text
feat/durable-research-snapshots
```

Target branch:

```text
sageprime
```

`main` remained outside the custom implementation path.

---

## 1. Original problem

OpenSEO already had short cache behavior for paid research, but the cache expired.

That created a cost risk:

```text
buy research
→ cache it temporarily
→ cache expires
→ same usable research can be purchased again
```

The required behavior was:

```text
short cache
→ durable purchased evidence
→ provider only when evidence is missing or explicit refresh is requested
```

This sounded small because the lookup rule is small.

The implementation became longer because it touched several strict repository boundaries at the same time:

- SQLite schema/migrations
- PostgreSQL schema/migrations
- request identity
- R2 cache
- durable DB reuse
- DataForSEO cost accounting
- MCP tools
- backfill safety
- full type-aware lint
- Knip exports
- CI plugin synchronization
- production self-host behavior

The architecture was not the main difficulty. The strict validation chain and production proof were.

---

## 2. Final feature scope

The final system covers exactly:

```text
research_keywords
get_keyword_metrics
get_serp_results
```

It adds:

- `project_research_snapshots`
- durable request hashing
- durable snapshot lookup/persistence
- per-keyword metric reuse
- missing-keyword-only provider calls
- explicit `refresh=true`
- `list_research_snapshots`
- `backfill_research_snapshots`
- zero-cost reuse recording
- snapshot failure isolation
- backfill idempotency
- tests for cache/snapshot/database/provider behavior

Do not generalize this to every DataForSEO tool.

---

## 3. Intended lookup flows

### Keyword research

```text
short cache
→ durable research snapshot
→ provider
```

### Keyword metrics

```text
short cache
→ exact durable snapshot
→ legacy/durable per-keyword DB metrics
→ provider for missing keywords only
```

### SERP

```text
durable SERP snapshot
→ provider
```

### Explicit refresh

```text
refresh=true
→ bypass reusable layers
→ provider
→ preserve older evidence
→ save new evidence
```

---

## 4. Branch safety model

The repository model during this work was:

```text
main
= clean upstream base

sageprime
= SagePrime custom production layer

feature/*
= temporary development branches
```

All durable-research source work was kept on the feature branch until validation completed.

The final PR targeted `sageprime`, not `main`.

This matters because upstream synchronization should remain possible without mixing custom SagePrime behavior directly into the clean base branch.

---

## 5. Development baseline

Base `sageprime` commit at feature start:

```text
eb5c6b8c16e962c8a7b8e9d1df17b37e85e48819
```

The feature accumulated multiple corrective commits before final acceptance.

Important source/test commits included:

```text
ed42f7fa23621abffcda01219939d10fa826a633
SQLite duplicate migration fix

2d27a373681a3a542baa30520cae9b531f9ab4f0
PostgreSQL duplicate migration fix

7bfff10f5247663f142d94b1a3444e2de0124600
research_keywords explicit refresh test

942a0492d50cafd71ed8703a9c5f045daa357348
SERP durable/refresh tests

0bdeded8f3908215d96aceba7c6787683afbde0d
research_keywords efficiency coverage

c7b0a7d06acf053e7c2f330b91e4b35805d58722
backfill test work

7182521ba0bcbb27c39a0afe834a4da10fc5c484
backfill test correction

e77c49af682b7bd5e6820798e25ec6e429368cf1
formatting-only validation commit

97eac3348e87285a8a2341886e5b1142b52f3c09
Knip unused-export cleanup
```

Later lint cleanup produced the final feature HEAD:

```text
f17444892105c3a0c196102a60be3112318babde
```

The feature was then merged into `sageprime` as:

```text
ad60160c659e4431f4b04e295e8221de48e73c7d
```

---

# Failure and fix history

## 6. Failure 1 — duplicate migration content

### Symptom

The newly generated durable-research migrations also contained creation of an already-existing table:

```text
project_research_cost_history
```

The new migration should have introduced only the new durable snapshot storage.

### Risk

If deployed unchanged, migration execution could fail or create schema-history inconsistency.

This was a high-risk defect because the feature could appear correct in source while breaking the production database rollout.

### Fix

The duplicate table creation/index statements were removed from both migration families:

```text
drizzle/0046_rapid_sphinx.sql
drizzle-pg/0024_woozy_warhawk.sql
```

The corrected migrations contained only the new snapshot table, indexes, and required relationship changes.

### Verification

After manual migration repair:

```bash
pnpm db:generate
```

returned successfully and generated no additional migration.

This was essential. A manual SQL edit alone was not considered sufficient evidence.

### Lesson for Hermes

Never treat generated migration SQL as automatically correct.

When a migration is manually repaired:

```text
repair SQL
→ rerun schema generation
→ require no unexpected new migration
→ inspect both SQLite and PostgreSQL trees
```

Do not validate only one database backend.

---

## 7. Failure 2 — implementation existed before complete behavioral proof

### Symptom

The core lookup code was present, but important behavioral cases did not yet have explicit tests.

Missing or insufficient proof included:

- `research_keywords refresh=true`
- SERP snapshot reuse
- SERP refresh bypass
- backfill idempotency
- historical timestamp preservation
- no approved-keyword mutation during backfill
- zero-provider behavior during historical import

### Risk

A feature can pass generic unit tests while still violate its cost or data-safety contract.

For this work, "works" was not enough. We needed to prove:

```text
reuse does not pay
refresh does pay/bypass reuse
backfill does not pay
backfill does not mutate approved keyword state
```

### Fix

Focused regression tests were added in the relevant service/MCP layers.

### Lesson for Hermes

Write acceptance cases from the business contract, not only from code branches.

For paid-provider systems, test these independently:

```text
reuse path
cold path
partial reuse
explicit refresh
persistence failure
historical import
idempotent rerun
cost ledger behavior
```

---

## 8. Failure 3 — formatting gate

### Symptom

The source behavior was valid, but repository formatting checks were not clean.

### Fix

Formatting was applied mechanically and committed separately.

### Lesson for Hermes

Keep mechanical formatting separate from behavioral changes when possible.

This makes review and regression diagnosis easier.

Run formatting early rather than after a long validation pass.

---

## 9. Failure 4 — Knip found four unused exported types

### Symptom

The broader feature tests passed, but `pnpm ci:check` was still blocked by Knip.

Four internal types were exported even though nothing outside their modules used them:

```text
KeywordMetricsLiveParams
KeywordMetricsCacheInput
PaidResearchJob
ResearchSeed
```

### Fix

Only the unnecessary `export` modifiers were removed.

No runtime behavior changed.

Commit:

```text
97eac3348e87285a8a2341886e5b1142b52f3c09
chore(research): remove unused type exports
```

### Lesson for Hermes

Do not weaken Knip or add fake consumers to silence unused-export findings.

Preferred fix:

```text
if type is module-private
→ make it module-private
```

---

## 10. Failure 5 — Oxlint reported 14 errors

### Symptom

After Knip passed, the strict type-aware Oxlint gate failed with 14 errors.

Rules included repository-enforced checks such as:

```text
unicorn/no-array-sort
typescript/no-unsafe-type-assertion
typescript/no-unsafe-member-access
typescript/no-unsafe-assignment
```

### Initial classification mistake

The first runtime report described these as existing/unrelated lint errors.

That classification was not safe.

Direct PR inspection proved several violations were in files created by this PR, including:

```text
src/server/features/research-ops/durableKeywordMetrics.ts
src/server/features/research-ops/researchSnapshots.ts
```

and in newly added code inside:

```text
src/server/features/research-ops/keywordMetricsCache.ts
```

A new file cannot contain a pre-existing baseline error at that location.

### Important lesson for Hermes

Never label a CI error "unrelated" merely because tests pass or because the rule existed before the PR.

Use ownership proof:

```text
1. collect exact file:line:rule output
2. compare file against base branch
3. determine whether offending line was added/modified by PR
4. classify PR-owned vs baseline
```

Do not guess ownership from memory.

---

## 11. Oxlint fix — mutating `.sort()`

### Problem

The repository explicitly rejects mutating array `.sort()` usage.

The config also warns against solving this with `.toSorted()` because the repository targets ES2022.

Affected new code normalized request identities using `.sort()`.

### Correct fix

Use Remeda sorting utilities such as:

```text
sort
sortBy
```

instead of native mutating `.sort()`.

### Why this matters

Request normalization is part of paid-research identity. A behavior-preserving non-mutating sort is safer than changing the data model merely to satisfy lint.

### Lesson for Hermes

Read repository lint comments before selecting an automatic replacement.

Do not assume `.toSorted()` is allowed just because it is modern JavaScript.

---

## 12. Oxlint fix — unsafe JSON/object assertions

### Problem examples

The first implementation used patterns like:

```text
JSON.parse(...) as Record<string, unknown>
item as Record<string, unknown>
canonicalize(...) as Record<string, unknown>
```

Type-aware lint rejected these because the assertions claimed structure without proving it.

### Correct fix

Replace assertions with validation/narrowing:

```text
parse unknown
→ check array/object shape
→ check individual fields
→ construct typed value only after validation
```

For durable snapshots, malformed stored JSON should fail parsing safely rather than be trusted through a cast.

### Lesson for Hermes

For persisted JSON:

```text
JSON.parse
→ unknown
→ validate/narrow
→ typed value
```

Do not jump directly from JSON to a trusted domain type with `as`.

---

## 13. Oxlint fix — refresh test fixture assertions

### Problem

Test fixtures used type assertions to force incomplete objects into production types.

The tests ran, but type-aware lint rejected the unsafe casts.

### Fix

Fixtures were made structurally valid instead of cast-valid.

### Lesson for Hermes

A test should not bypass the type system unless the test is explicitly about invalid runtime input.

Preferred pattern:

```text
construct valid typed fixture
```

not:

```text
partial object as ProductionType
```

---

## 14. Remaining six Oxlint errors were test-only

After the first Oxlint cleanup, the error count dropped from 14 to 6.

The remaining files were:

```text
src/server/mcp/tools/research-keywords.efficiency.test.ts
src/server/features/research-ops/paidResearchRecorder.test.ts
src/server/features/research-ops/keywordMetricsCache.test.ts
```

Rules were unsafe member access / unsafe assignment around untyped `vi.fn()` call histories and asymmetric Vitest matchers.

### Fix approach

The test code was changed so lint did not need to infer through unsafe `any` values.

No runtime source behavior changed.

Final feature HEAD after test-lint cleanup:

```text
f17444892105c3a0c196102a60be3112318babde
```

### Final repository validation

```text
Oxlint: PASS
ci:check: PASS
148 test files passed
1,202 tests passed
0 failed
```

### Lesson for Hermes

Strict type-aware lint applies to tests too.

Do not dismiss test-only lint as irrelevant. CI does not.

---

# Process mistakes and improved workflow

## 15. Why the task took longer than expected

The feature design was simple, but validation was handled too sequentially.

The sequence effectively became:

```text
feature
→ migration issue
→ missing tests
→ formatting
→ Knip
→ Oxlint batch 1
→ Oxlint batch 2
→ production acceptance
```

Each gate was discovered after the previous one was cleared.

### Better workflow for future features

Immediately after the first coherent implementation, run the **entire** repository gate and capture all failures at once:

```bash
pnpm db:generate
pnpm ci:check
pnpm test:ci
```

Then classify every failure before making another source change.

Recommended loop:

```text
implement coherent slice
→ run full gate
→ collect all errors
→ classify PR-owned/baseline
→ fix PR-owned issues as one batch
→ rerun full gate
```

This avoids the "one new blocker per turn" pattern.

---

## 16. Do not weaken global rules to make a feature green

At no point should the correct response to strict CI be:

```text
weaken .oxlintrc
add broad lint disable
exclude the new folder
turn off Knip
skip badseo typecheck
```

The durable research fixes were made inside the implementation/tests instead.

This preserved repository standards.

### Hermes rule

When a new feature fails an existing quality gate:

```text
fix the feature to meet the repo
```

not:

```text
change the repo so the feature passes
```

unless the user explicitly approves a standards change for an independent reason.

---

## 17. Correct command-order understanding matters

The repository `ci:check` chain contains multiple stages.

Do not report that a stage "did not run" without checking its position in the script.

For this repository, TypeScript checks occur before Oxlint, while plugin sync validation occurs after Oxlint.

Therefore, if `ci:check` reaches Oxlint and fails there:

```text
Prettier      already ran
Knip          already ran
TypeScript    already ran
badseo tsc    already ran
Oxlint        failed
plugin sync   did not run
```

### Lesson for Hermes

Before interpreting partial CI output, read the exact `package.json` script order.

---

# Production rollout history

## 18. Deployment safety requirements

Production used the existing OpenSEO self-hosted app.

The rollout intentionally did **not** recreate the application.

Safety requirements were:

```text
same repo
same sageprime branch
same application
same persistent volume
same domain
same database configuration
same auth/OAuth environment
same secrets
```

### Lesson for Hermes

A source update is not a reason to recreate infrastructure.

For stateful self-hosted apps, recreation can create more risk than the feature itself.

---

## 19. Production migration and preservation checks

After deployment:

```text
health = HTTP 200
database health = ok
snapshot table query = success
StealthRDP project = preserved
saved keywords = 28 before → 28 after
```

The saved-keyword set remained exactly unchanged.

This was necessary because backfilled research evidence must not mutate approved project targeting state.

---

## 20. Historical production backfill

The verified historical import contained:

```text
5 keyword-research snapshots
6 SERP snapshots
11 total
```

All were imported with the historical market and original research timestamp.

First run:

```text
11 imported
0 skipped
```

Second run:

```text
0 imported
11 skipped
```

Snapshot count stayed stable.

Saved keywords stayed at 28.

Provider calls during deploy/migration/backfill:

```text
0
```

Provider cost delta:

```text
$0.00000
```

### Lesson for Hermes

Always rerun an idempotent migration/backfill operation as part of acceptance.

The second run is the proof of idempotency, not just the existence of an `exists` check in code.

---

## 21. Production proof 1 — durable snapshot reuse

A historical request was invoked with short cache unavailable.

Observed:

```text
reuseSource = snapshot
cacheHit = false
provider calls = 0
provider cost delta = $0.00000
```

This was the first real production proof that old purchased research could serve a request without DataForSEO.

---

## 22. False-negative acceptance test — redeploy did not clear R2

### What happened

The next acceptance idea was:

```text
redeploy app
→ repeat request
→ expect snapshot
```

After redeploy, the result was:

```text
reuseSource = cache
cacheHit = true
provider calls = 0
cost = $0
```

The run was initially labeled **FAIL** because it did not return `snapshot`.

### Root cause

The R2 short cache is persistent across the deployment.

The redeploy did not remove the cache object created by the first request.

Therefore the test assumption was wrong, not the product.

### Critical lesson for Hermes

Do not assume:

```text
restart/redeploy = empty cache
```

Persistent storage can survive both.

Before designing an acceptance test, establish whether the tested state is process memory, local ephemeral disk, persistent volume, KV, database, or R2/object storage.

---

## 23. Correct final production acceptance test

The final test directly controlled the exact cache state.

Exact cache key used for the verified request:

```text
dataforseo-cache/kw:research:c6b6d59a6a66cd34cd7b3a85514c4a4baf6aa9e3d79e158d7c035a6ad6d50cb2
```

Procedure:

```text
1. confirm durable snapshot exists
2. delete only the exact short-cache object
3. do not delete the durable snapshot
4. do not use refresh=true
5. call research_keywords normally
6. require snapshot reuse
7. call again
8. require cache reuse
9. measure provider-call and cost deltas
```

Observed:

```text
First call:
reuseSource = snapshot
provider calls = 0
provider cost delta = $0.00000

Second call:
reuseSource = cache
provider calls = 0
```

Final production result:

```text
PASS
```

### Why this test is strong

It proves both layers independently:

```text
empty short cache + existing durable evidence
→ durable snapshot works

after durable snapshot response
→ short cache is repopulated
```

It also proves no provider charge occurred during either path.

---

## 24. Never use `refresh=true` for a reuse acceptance test

`refresh=true` intentionally means:

```text
ignore cache
ignore snapshot
buy fresh evidence
```

Using it to "make sure cache is bypassed" would invalidate the cost-safety test and could create an intentional paid provider call.

### Hermes rule

For snapshot testing:

```text
control/remove only the short-cache record
```

Do not use the feature's paid refresh switch.

---

## 25. Never clear the full cache bucket for a narrow acceptance test

The correct test deleted one known cache object only.

A broad cache wipe would affect unrelated projects and research.

### Hermes rule

Prefer the smallest reversible state mutation that proves the behavior.

```text
one request
→ one exact cache key
→ one object deletion
```

---

# Acceptance matrix

## 26. Final verified results

```text
Database migrations                 PASS
SQLite/Postgres migration parity    PASS
Prettier                            PASS
Knip                                PASS
TypeScript                          PASS
badseo TypeScript                   PASS
Oxlint type-aware                   PASS
Full ci:check                       PASS
148 test files                      PASS
1,202 tests                         PASS
Backfill provider calls             0
Backfill idempotency                PASS
Saved-keyword preservation          PASS
Historical snapshot reuse           PASS
Provider calls on snapshot reuse    0
Provider cost on snapshot reuse     $0.00000
Short cache repopulation            PASS
Production health                   PASS
```

---

# Behavior cases future agents must preserve

## 27. Required regression behaviors

### A — short cache reuse

Second matching request should use short cache with no provider call.

### B — durable keyword-research snapshot reuse

When short cache is absent and matching snapshot exists, provider must not be called.

### C — cold keyword research

When neither cache nor snapshot exists, provider may be called and a durable snapshot should be saved.

### D — keyword research explicit refresh

`refresh=true` must bypass both cache and snapshot and preserve older snapshot history.

### E — durable SERP reuse

Matching SERP snapshot should prevent provider call.

### F — SERP refresh

Refresh should call provider and save new evidence without deleting old evidence.

### G — durable keyword metric reuse

Existing durable metric rows should avoid provider requests.

### H — partial metric batch

Only missing keywords should reach the provider.

### I — normalized metric identity

Duplicate/case/order variants should normalize consistently.

### J — clickstream separation

Clickstream requests must not reuse normal legacy metric rows.

### K — market identity

Location, language, and clickstream dimensions must affect identity.

### L — snapshot persistence isolation

A paid provider result should still be returned if snapshot persistence fails.

### M — historical backfill safety

Backfill must preserve research timestamp, skip existing records, make zero provider calls, and not save discovered keywords as approved targets.

---

# What is not yet guaranteed

## 28. Concurrent cold-miss deduplication

The implementation does not prove that two truly simultaneous identical cold requests cannot both reach the provider before either persists the reusable result.

Do not claim exact-once charging under concurrency.

Possible future solution:

```text
singleflight / distributed lock / request lease
```

This requires separate design and testing.

---

## 29. Automatic freshness policy

Current durable reuse is deliberate and persistent.

It does not automatically decide that old research is stale.

Possible future enhancement:

```text
maxAge
freshness policy
stale-while-revalidate
explicit research-age display
```

Do not silently add freshness behavior without considering provider cost and reproducibility.

---

## 30. Universal DataForSEO coverage

This implementation protects only the explicitly integrated research paths.

Do not tell operators:

```text
OpenSEO can never repurchase any DataForSEO data
```

Correct statement:

```text
OpenSEO durable reuse is implemented and production-proven for research_keywords, get_keyword_metrics, and get_serp_results.
```

---

# Recommended Hermes workflow for future repository features

## 31. Source phase

```text
1. branch from current sageprime
2. implement one coherent feature slice
3. inspect migration output immediately
4. add business-contract tests
5. run complete CI early
```

## 32. Failure classification phase

For every failure, capture:

```text
command
file
line
rule/error
whether line exists on base
whether PR added/modified it
```

Classify:

```text
PR-owned
baseline
infrastructure/environment
false test assumption
```

Do not modify code until classification is complete when multiple failures exist.

## 33. Fix phase

```text
fix all PR-owned failures as one batch
avoid unrelated cleanup
avoid global rule weakening
keep mechanical-only changes separate when practical
```

## 34. Validation phase

Always rerun the complete chain after the final source change.

A previous green run is invalidated by a later source edit.

Required final evidence should include:

```text
commit SHA
ci:check result
test result
migration result
worktree clean status
```

## 35. Production phase

For stateful applications:

```text
verify same app
verify same volume
verify same env/auth/database
update source
run migrations
health check
verify existing project data
```

Never recreate production infrastructure merely because a source branch changed.

## 36. Acceptance phase

Design tests that control the exact state required by the behavior.

For cache layering:

```text
know which layer persists
remove only the layer you need absent
leave lower layer intact
measure provider-call delta
measure provider-cost delta
```

Do not use redeploy as a generic cache reset.

---

# High-value lessons for Hermes

## 37. Lesson: simple architecture can still need strict proof

Do not confuse implementation complexity with acceptance complexity.

This feature's core rule was simple, but it protected paid provider spend and persistent project data. That justified stronger validation.

## 38. Lesson: exact provider-cost proof matters

For a cost-protection feature, "response looked cached" is not sufficient.

Require:

```text
provider-call delta = 0
provider-cost delta = 0
```

## 39. Lesson: distinguish evidence from selected state

Do not turn discovered research into approved project state during import.

Snapshots and saved keywords have different ownership semantics.

## 40. Lesson: persistent cache changes test design

Always identify storage lifetime before using restart/redeploy as a state-reset technique.

## 41. Lesson: inspect the PR before accepting "unrelated" failures

New or modified lines are objective evidence of ownership.

## 42. Lesson: fix repository compliance in code, not config

Do not silence strict lint to accelerate a feature.

## 43. Lesson: rerun full CI after the last edit

Partial green history is not final proof.

## 44. Lesson: production proof should be minimally destructive

Delete one exact cache key, not a bucket.

## 45. Lesson: explicit refresh is a business action

It can intentionally cause spend. Never use it casually for diagnostics.

---

# Final definition of done

The durable research implementation was considered complete only after all of the following were true:

```text
source merged into sageprime
main untouched
migration successful
health successful
existing data preserved
historical backfill successful
backfill repeated idempotently
zero provider calls during backfill
short cache deliberately removed for one request
durable snapshot served request
provider-call delta remained zero
provider-cost delta remained zero
next request served from repopulated short cache
full CI and 1,202 tests passed
```

That is the standard future agents should use when changing this system.

---

# Related documentation

See:

```text
docs/SAGEPRIME_DURABLE_RESEARCH.md
```

for the current system design and operator guide.

Use this implementation log for historical context, failure diagnosis, and process lessons. Use the system document for current operational behavior.
