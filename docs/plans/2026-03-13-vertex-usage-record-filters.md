# Claude Vertex Usage Record Filters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose `claude-vertex` reconciliation fields inside existing usage-record monitoring and filtering flows for both API key and account views.

**Architecture:** Extend admin usage-record APIs to return and filter on stored reconciliation-related metadata, then wire the two existing Vue views and shared detail modal to surface those fields. Keep scope limited to usage records and avoid any new persistence or log parsing pipeline.

**Tech Stack:** Express, Jest, Vue 3, Element Plus

---

### Task 1: Add failing admin route tests

**Files:**
- Modify: `tests/usageStats.route.test.js`

**Step 1: Write failing API key usage-record filter test**
- Assert `/api-keys/:keyId/usage-records` can filter by `accountType=claude-vertex`, `usageCaptureState=partial`, and `requestRegion=us-east5`.
- Assert response records include `usageCaptureState` and `requestRegion`.
- Assert `availableFilters` includes account types, usage states, and regions.

**Step 2: Run focused test to verify failure**
Run: `npm test -- --runInBand tests/usageStats.route.test.js`
Expected: FAIL because route filters/fields are not implemented yet.

### Task 2: Implement admin API support

**Files:**
- Modify: `src/routes/admin/usageStats.js`

**Step 1: Parse new query params**
- Read `accountType`, `usageCaptureState`, `requestRegion` in both usage-record endpoints.

**Step 2: Apply filters before summary/pagination**
- Filter records by those query params.

**Step 3: Expose fields and filter options**
- Include `usageCaptureState` and `requestRegion` in each enriched record.
- Add `accountTypes`, `usageCaptureStates`, `requestRegions` to `availableFilters`.
- Echo filter values in `filters`.

**Step 4: Run focused test to verify pass**
Run: `npm test -- --runInBand tests/usageStats.route.test.js`
Expected: PASS.

### Task 3: Wire usage-record views

**Files:**
- Modify: `web/admin-spa/src/views/ApiKeyUsageRecordsView.vue`
- Modify: `web/admin-spa/src/views/AccountUsageRecordsView.vue`
- Modify: `web/admin-spa/src/components/apikeys/RecordDetailModal.vue`

**Step 1: Add filter state and request params**
- Add `accountType`, `usageCaptureState`, `requestRegion` to local filters and request builders.

**Step 2: Add filter controls**
- Render selects using `availableFilters` payload.

**Step 3: Show reconciliation fields in detail modal**
- Display account type, usage capture state, and request region.

**Step 4: Keep CSV export aligned**
- Include the same fields in exports for easier offline reconciliation.

### Task 4: Verify end-to-end regressions

**Files:**
- Modify: `tests/usageStats.route.test.js`
- Verify touched backend vertex tests still pass

**Step 1: Run focused backend suite**
Run: `npm test -- --runInBand tests/usageStats.route.test.js tests/api.vertexStreamRateLimit.test.js tests/api.vertexNonStreamPartialUsage.test.js tests/openaiClaudeRoutes.vertexPartialUsage.test.js`
Expected: PASS.

**Step 2: Optional frontend verification**
- If lightweight build verification is practical, run the existing frontend lint/build command later.
