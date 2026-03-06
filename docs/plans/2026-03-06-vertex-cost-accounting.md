# Vertex Cost Accounting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix undercounting for GCP Vertex Claude usage and make admin cost display default to real cloud cost while preserving rated cost for quota logic.

**Architecture:** Apply a two-lane solution. Lane 1 improves data completeness by adding partial usage capture fallback for Vertex streaming (emit once on `end/error/close/finally`). Lane 2 normalizes cost presentation by returning `real/rated/display` fields from usage-record APIs and making UI default to `real` mode (configurable).

**Tech Stack:** Node.js (CommonJS), Express, Redis (ioredis), Jest, Vue 3 + Vite + Element Plus.

---

### Task 1: Add Billing Display Mode Config + Cost Selection Helper

**Files:**
- Modify: `config/config.js`
- Modify: `config/config.example.js`
- Create: `src/utils/billingCostModeHelper.js`
- Test: `tests/billingCostModeHelper.test.js`

**Step 1: Write the failing test**

```js
const { resolveDisplayMode, buildCostView } = require('../src/utils/billingCostModeHelper')

describe('billingCostModeHelper', () => {
  it('defaults to real mode', () => {
    expect(resolveDisplayMode(undefined)).toBe('real')
  })

  it('builds display cost from real in real mode', () => {
    const view = buildCostView({ realCost: 3.21, ratedCost: 1.07 }, 'real')
    expect(view.displayCost).toBe(3.21)
    expect(view.displayCostMode).toBe('real')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/billingCostModeHelper.test.js`
Expected: FAIL with module/file not found.

**Step 3: Write minimal implementation**

```js
function resolveDisplayMode(mode) {
  return mode === 'rated' ? 'rated' : 'real'
}

function buildCostView(costs, mode) {
  const displayCostMode = resolveDisplayMode(mode)
  const realCost = Number(costs?.realCost || 0)
  const ratedCost = Number(costs?.ratedCost || 0)
  const displayCost = displayCostMode === 'rated' ? ratedCost : realCost
  return { realCost, ratedCost, displayCost, displayCostMode }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/billingCostModeHelper.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add config/config.js config/config.example.js src/utils/billingCostModeHelper.js tests/billingCostModeHelper.test.js
git commit -m "feat: add billing display mode helper for real vs rated cost"
```

---

### Task 2: Add Failing Tests for Vertex Stream Partial Usage Fallback

**Files:**
- Modify: `tests/gcpVertexRelayService.test.js`

**Step 1: Write failing tests for partial usage emission**

Add tests:
1. Stream receives only `message_start` then closes; callback is still emitted once with `output_tokens: 0`.
2. Stream emits both `error` and `close`; callback remains emitted at most once.

```js
expect(usageCallback).toHaveBeenCalledTimes(1)
expect(usageCallback).toHaveBeenCalledWith(expect.objectContaining({
  input_tokens: 12,
  output_tokens: 0,
  usage_capture_state: 'partial'
}))
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/gcpVertexRelayService.test.js`
Expected: FAIL because current implementation only emits on complete usage at `end`.

**Step 3: Keep only minimal failing assertions**

If flaky, reduce to:
1. callback called
2. called once
3. `output_tokens` normalized to `0`.

**Step 4: Re-run for deterministic failure**

Run: `npm test -- tests/gcpVertexRelayService.test.js`
Expected: deterministic FAIL.

**Step 5: Commit test-only change**

```bash
git add tests/gcpVertexRelayService.test.js
git commit -m "test: cover vertex stream partial usage fallback emission"
```

---

### Task 3: Implement Vertex Stream Partial Usage Fallback (Emit Once)

**Files:**
- Modify: `src/services/relay/gcpVertexRelayService.js`

**Step 1: Implement emit-once guard and fallback emitter**

Core change:
- Add `let usageEmitted = false`.
- Replace `emitUsageOnce()` with:
  - complete emission when input+output both exist
  - partial emission when only input exists (set `output_tokens = 0`)
  - set `usage_capture_state` = `complete | partial`.

```js
const emitUsageIfAvailable = (reason = 'end') => {
  if (usageEmitted || typeof usageCallback !== 'function') return
  if (collectedUsage.input_tokens === undefined) return

  const hasOutput = collectedUsage.output_tokens !== undefined
  const payload = {
    ...collectedUsage,
    output_tokens: hasOutput ? collectedUsage.output_tokens : 0,
    usage_capture_state: hasOutput ? 'complete' : 'partial',
    model: collectedUsage.model || modelId,
    accountId
  }

  usageCallback(payload)
  usageEmitted = true
}
```

**Step 2: Call fallback emitter in terminal events**

Call `emitUsageIfAvailable(...)` in:
1. `end` (existing path)
2. `error`
3. `close` (if not finished)
4. `finally` before return (safe last chance)

**Step 3: Run targeted tests**

Run: `npm test -- tests/gcpVertexRelayService.test.js`
Expected: PASS.

**Step 4: Run regression for related streaming path**

Run: `npm test -- tests/api.vertexStreamRateLimit.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/relay/gcpVertexRelayService.js
git commit -m "fix: emit vertex stream usage once with partial fallback on abort"
```

---

### Task 4: Accept Partial Usage in Routes and Preserve Capture State

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/routes/openaiClaudeRoutes.js`
- Modify: `tests/api.vertexStreamRateLimit.test.js`
- Create: `tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

**Step 1: Add failing route test (Anthropic `/v1/messages`)**

In `tests/api.vertexStreamRateLimit.test.js`, mock callback payload with no `output_tokens` but with input; expect `recordUsageWithDetails` called and output normalized to `0`.

**Step 2: Add failing route test (OpenAI-compatible Claude route)**

Create a focused test for `openaiClaudeRoutes` vertex streaming callback path:
- payload only has input/cache
- expect usage recorded with `output_tokens: 0`
- expect `usage_capture_state: 'partial'` passed through.

**Step 3: Implement minimal route changes**

In both routes:
- replace strict guard `input_tokens !== undefined && output_tokens !== undefined`
- new guard: `input_tokens !== undefined`
- normalize output with `const outputTokens = usageData.output_tokens ?? 0`
- pass `usage_capture_state` into `usageObject`.

```js
const hasInput = usageData && usageData.input_tokens !== undefined
if (hasInput) {
  const outputTokens = usageData.output_tokens ?? 0
  usageObject.usage_capture_state = usageData.usage_capture_state || (usageData.output_tokens !== undefined ? 'complete' : 'partial')
}
```

**Step 4: Run tests**

Run:
- `npm test -- tests/api.vertexStreamRateLimit.test.js`
- `npm test -- tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/api.js src/routes/openaiClaudeRoutes.js tests/api.vertexStreamRateLimit.test.js tests/openaiClaudeRoutes.vertexPartialUsage.test.js
git commit -m "fix: record partial vertex stream usage in route handlers"
```

---

### Task 5: Store Usage Capture State in Usage Records

**Files:**
- Modify: `src/services/apiKeyService.js`
- Create: `tests/apiKeyService.usageCaptureState.test.js`

**Step 1: Write failing test**

Test `recordUsageWithDetails` stores `usageCaptureState` in saved usage record when incoming usage is partial.

```js
expect(redis.addUsageRecord).toHaveBeenCalledWith(
  'key-1',
  expect.objectContaining({ usageCaptureState: 'partial' })
)
```

**Step 2: Implement minimal persistence**

In usage record payload:

```js
usageCaptureState:
  usageObject.usage_capture_state ||
  (usageObject.output_tokens === undefined ? 'partial' : 'complete')
```

**Step 3: Backward compatibility**

Keep all existing fields (`cost`, `realCost`, `realCostBreakdown`) unchanged.

**Step 4: Run test**

Run: `npm test -- tests/apiKeyService.usageCaptureState.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/apiKeyService.js tests/apiKeyService.usageCaptureState.test.js
git commit -m "feat: persist usage capture state for usage record auditing"
```

---

### Task 6: Return Real/Rated/Display Costs in Usage-Record APIs

**Files:**
- Modify: `src/routes/admin/usageStats.js`
- Modify: `tests/usageStats.route.test.js`
- Optionally create: `tests/usageStats.costMode.route.test.js`

**Step 1: Write failing API tests**

Add assertions for both routes:
- `/api-keys/:keyId/usage-records`
- `/accounts/:accountId/usage-records`

Expect response includes:
1. `record.realCost`
2. `record.ratedCost`
3. `record.displayCost`
4. `summary.totalRealCost`
5. `summary.totalRatedCost`
6. `summary.totalCost` follows display mode.

**Step 2: Implement backend cost-view mapping**

Use helper from Task 1 to map per-record and summary costs:

```js
const costView = buildCostView({ realCost, ratedCost }, resolvedDisplayMode)
```

Response contract:
- Preserve legacy `cost` / `costFormatted`
- Add `ratedCost` / `ratedCostFormatted`
- Add `displayCost` / `displayCostFormatted`
- Add `displayCostMode`.

**Step 3: Keep legacy compatibility**

Set legacy fields to display value for old frontend:

```js
cost = displayCost
costFormatted = displayCostFormatted
```

**Step 4: Run tests**

Run: `npm test -- tests/usageStats.route.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/admin/usageStats.js tests/usageStats.route.test.js
git commit -m "feat: expose real rated and display costs in usage record APIs"
```

---

### Task 7: Update Usage Record UI to Show Real Cost by Default + Rated Cost Secondary

**Files:**
- Modify: `web/admin-spa/src/views/ApiKeyUsageRecordsView.vue`
- Modify: `web/admin-spa/src/views/AccountUsageRecordsView.vue`
- Modify: `web/admin-spa/src/components/apikeys/RecordDetailModal.vue`

**Step 1: Implement display mode badge and dual-cost columns**

In list pages:
- primary shown value: `record.displayCostFormatted || record.realCostFormatted`
- secondary text: `额度费用：record.ratedCostFormatted`.

In summary cards:
- primary `summary.totalCost`
- secondary row for `summary.totalRatedCost`.

**Step 2: Fix detail modal consistency**

Make “总费用” use same display lane as breakdown lane:
- show “真实费用（对账）”
- show “额度费用（倍率后）”
- avoid mixing rated total with real breakdown.

**Step 3: Manual smoke checks**

Run:
- `npm run install:web`
- `npm run build:web`

Expected: build succeeds.

**Step 4: Quick API/UI integration check**

Open page and verify:
1. list total and detail total are consistent
2. mode label equals backend `displayCostMode`
3. fallback works for old records without `ratedCost`.

**Step 5: Commit**

```bash
git add web/admin-spa/src/views/ApiKeyUsageRecordsView.vue web/admin-spa/src/views/AccountUsageRecordsView.vue web/admin-spa/src/components/apikeys/RecordDetailModal.vue
git commit -m "feat: show real and rated costs in usage record UI"
```

---

### Task 8: End-to-End Verification and Release Notes

**Files:**
- Modify: `docs/plans/2026-03-06-vertex-cost-accounting-design.md` (status + implementation notes)
- Optionally modify: `README.md` (admin cost semantics section)

**Step 1: Run focused backend tests**

Run:
- `npm test -- tests/gcpVertexRelayService.test.js`
- `npm test -- tests/api.vertexStreamRateLimit.test.js`
- `npm test -- tests/usageStats.route.test.js`
- `npm test -- tests/billingCostModeHelper.test.js`
- `npm test -- tests/apiKeyService.usageCaptureState.test.js`
- `npm test -- tests/openaiClaudeRoutes.vertexPartialUsage.test.js`

Expected: PASS.

**Step 2: Run full backend tests (if feasible)**

Run: `npm test`
Expected: PASS (or document unrelated failures).

**Step 3: Run frontend build verification**

Run: `npm run install:web && npm run build:web`
Expected: PASS.

**Step 4: Update design doc status**

Add:
- completed tasks
- known limitations (`partial` still may undercount output if upstream never returns delta).

**Step 5: Final commit**

```bash
git add docs/plans/2026-03-06-vertex-cost-accounting-design.md README.md
git commit -m "docs: clarify real vs rated billing semantics for vertex usage"
```

---

## Notes for Execution

1. Keep TDD discipline: do not implement before failing tests exist.
2. Avoid changing quota enforcement semantics in this plan (still uses rated cost).
3. For any flaky stream tests, prefer deterministic EventEmitter-based mocked streams over timers.

