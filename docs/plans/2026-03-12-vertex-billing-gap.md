# Vertex Billing Gap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining GCP Vertex Claude billing gap by adding Vertex-specific pricing context and making admin aggregate summaries prefer stored costs.

**Architecture:** Propagate Vertex request billing metadata from routes into `recordUsageWithDetails`, infer Vertex 200K+ pricing in `pricingService`, apply Vertex regional premium when the endpoint is not global, and stop recomputing admin summaries from tokens when stored cost microfields exist.

**Tech Stack:** Node.js (CommonJS), Jest, Express routes, Redis-backed aggregation.

---

### Task 1: Add failing pricing tests for Vertex long-context and regional premiums

**Files:**
- Modify: `tests/pricingService.test.js`

**Step 1: Write the failing test**

Add tests that:

1. call `pricingService.calculateCost()` for `claude-sonnet-4-6` with:
   - `input_tokens: 210000`
   - `request_provider: 'vertex'`
   - `request_region: 'global'`
   and expect 200K+ pricing
2. call `pricingService.calculateCost()` for `claude-opus-4-6` with:
   - `request_provider: 'vertex'`
   - `request_region: 'us-east5'`
   and expect the regional multiplier to increase pricing

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/pricingService.test.js`

Expected: FAIL because current pricing logic ignores Vertex provider/region context.

**Step 3: Keep assertions minimal**

Assert only the price deltas that prove the behavior.

### Task 2: Implement minimal Vertex pricing inference

**Files:**
- Modify: `src/services/pricingService.js`

**Step 1: Implement helper extraction**

Add helpers to read:

- `request_provider`
- `request_region`

from the usage metadata.

**Step 2: Implement minimal pricing logic**

In `calculateCost()`:

- detect Vertex Claude requests
- enable long-context pricing when:
  - provider is Vertex
  - total input tokens exceed 200K
  - pricing advertises `max_input_tokens > 200000`
- apply regional premium when:
  - provider is Vertex
  - region is set and not `global`
  - `provider_specific_entry.us` exists

**Step 3: Run pricing tests**

Run: `npm test -- tests/pricingService.test.js`

Expected: PASS.

### Task 3: Add failing route tests for Vertex billing metadata propagation

**Files:**
- Modify: `tests/api.vertexStreamRateLimit.test.js`
- Modify: `tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

**Step 1: Write the failing test**

In both route suites, expect `recordUsageWithDetails()` to receive usage metadata containing:

- `request_provider: 'vertex'`
- `request_region: <account location or configured location>`

Use the mocked Vertex account selection / relay callbacks already present in the tests.

**Step 2: Run tests to verify they fail**

Run:
- `npm test -- tests/api.vertexStreamRateLimit.test.js`
- `npm test -- tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

Expected: FAIL because current route handlers do not attach provider/region metadata.

### Task 4: Implement minimal Vertex metadata propagation

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/routes/openaiClaudeRoutes.js`
- Possibly modify: `src/services/relay/gcpVertexRelayService.js` only if route handlers need the account location surfaced explicitly

**Step 1: Attach provider/region metadata**

For Vertex request usage objects, add:

```js
usageObject.request_provider = 'vertex'
usageObject.request_region = vertexRegion
```

Use the selected Vertex account’s location, defaulting to configured global when absent.

**Step 2: Re-run targeted tests**

Run:
- `npm test -- tests/api.vertexStreamRateLimit.test.js`
- `npm test -- tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

Expected: PASS.

### Task 5: Add failing admin summary tests for stored-cost preference

**Files:**
- Modify: `tests/usageStats.route.test.js`

**Step 1: Write the failing test**

Cover at least one summary endpoint that currently recalculates from tokens.

Prepare Redis/mock data where:

- token-derived cost is intentionally different from stored `realCostMicro/ratedCostMicro`
- endpoint should return the stored cost totals

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageStats.route.test.js`

Expected: FAIL because legacy summary paths still recompute cost from tokens.

### Task 6: Implement minimal admin stored-cost preference

**Files:**
- Modify: `src/routes/admin/usageStats.js`

**Step 1: Prefer stored micro-cost values**

Where aggregate summaries already have `realCostMicro/ratedCostMicro` available, use them.

Where current logic only has model-level token rollups, preserve fallback recalculation only when
stored cost fields are absent.

**Step 2: Run summary tests**

Run: `npm test -- tests/usageStats.route.test.js`

Expected: PASS.

### Task 7: Verify the full focused set and commit

**Files:**
- Modify: `src/services/pricingService.js`
- Modify: `src/routes/api.js`
- Modify: `src/routes/openaiClaudeRoutes.js`
- Modify: `src/routes/admin/usageStats.js`
- Modify: `tests/pricingService.test.js`
- Modify: `tests/api.vertexStreamRateLimit.test.js`
- Modify: `tests/openaiClaudeRoutes.vertexPartialUsage.test.js`
- Modify: `tests/usageStats.route.test.js`

**Step 1: Run focused verification**

Run:

- `npm test -- tests/pricingService.test.js`
- `npm test -- tests/api.vertexStreamRateLimit.test.js`
- `npm test -- tests/openaiClaudeRoutes.vertexPartialUsage.test.js`
- `npm test -- tests/usageStats.route.test.js`
- `./node_modules/.bin/eslint src/services/pricingService.js src/routes/api.js src/routes/openaiClaudeRoutes.js src/routes/admin/usageStats.js tests/pricingService.test.js tests/api.vertexStreamRateLimit.test.js tests/openaiClaudeRoutes.vertexPartialUsage.test.js tests/usageStats.route.test.js`

Expected: PASS.

**Step 2: Review diff**

Run: `git diff -- <files>`

Expected: only the planned Vertex billing and summary changes.

**Step 3: Commit**

```bash
git add src/services/pricingService.js src/routes/api.js src/routes/openaiClaudeRoutes.js src/routes/admin/usageStats.js tests/pricingService.test.js tests/api.vertexStreamRateLimit.test.js tests/openaiClaudeRoutes.vertexPartialUsage.test.js tests/usageStats.route.test.js docs/plans/2026-03-12-vertex-billing-gap-design.md docs/plans/2026-03-12-vertex-billing-gap.md
git commit -m "fix: align vertex billing totals with request pricing context"
```
