# Claude Vertex Reconciliation Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reconciliation logs only for `claude-vertex` so operators can compare upstream Vertex usage and locally recorded usage for `/api` requests.

**Architecture:** Keep all request routing unchanged and add minimal logging at the final accounting points in `src/routes/api.js`, plus lightweight diagnostic logs in `src/services/relay/gcpVertexRelayService.js` for partial or alternate usage-capture paths. Preserve existing usage recording behavior and avoid broad refactors.

**Tech Stack:** Node.js, Express, Jest

---

### Task 1: Add failing tests for Vertex reconciliation logs

**Files:**
- Modify: `tests/api.vertexStreamRateLimit.test.js`
- Modify: `tests/api.vertexNonStreamPartialUsage.test.js`
- Modify: `tests/gcpVertexRelayService.test.js`

**Step 1: Write the failing tests**
- Add a stream test asserting a structured `logger.info` reconciliation log is emitted after `recordUsageWithDetails` for `claude-vertex` stream usage.
- Add a non-stream test asserting a structured `logger.info` reconciliation log is emitted when partial usage is recorded for Vertex.
- Add a relay diagnostic test asserting a warning/debug log is emitted when no complete usage is available or when an alternate SSE usage source is parsed.

**Step 2: Run tests to verify they fail**
Run: `npm test -- --runInBand tests/api.vertexStreamRateLimit.test.js tests/api.vertexNonStreamPartialUsage.test.js tests/gcpVertexRelayService.test.js`
Expected: FAIL because the new reconciliation log expectations are not implemented yet.

### Task 2: Implement minimal Vertex reconciliation logs

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/services/relay/gcpVertexRelayService.js`

**Step 1: Add stream reconciliation log**
- In the `claude-vertex` stream usage callback branch, after building normalized usage values, emit a single structured `logger.info` log containing request/account/model/mode/usage state/token totals.

**Step 2: Add non-stream reconciliation log**
- In the `claude-vertex` non-stream usage branch, emit the same structured reconciliation log after normalized usage is derived and before/after `recordUsageWithDetails`.

**Step 3: Add minimal diagnostic relay logs**
- Keep relay logs limited to useful diagnostics: alternate SSE usage source, partial usage emission, and missing usage on stream completion.

**Step 4: Keep scope minimal**
- Do not change routing, retry behavior, scheduler selection, or any non-Vertex logging paths.

### Task 3: Verify the changes

**Files:**
- Test: `tests/api.vertexStreamRateLimit.test.js`
- Test: `tests/api.vertexNonStreamPartialUsage.test.js`
- Test: `tests/gcpVertexRelayService.test.js`
- Test: `tests/openaiClaudeRoutes.vertexPartialUsage.test.js`
- Test: `tests/apiKeyService.usageCaptureState.test.js`

**Step 1: Run focused Vertex tests**
Run: `npm test -- --runInBand tests/api.vertexStreamRateLimit.test.js tests/api.vertexNonStreamPartialUsage.test.js tests/gcpVertexRelayService.test.js tests/openaiClaudeRoutes.vertexPartialUsage.test.js tests/apiKeyService.usageCaptureState.test.js`
Expected: PASS

**Step 2: Review log field consistency**
- Confirm the reconciliation logs use the same field names for stream and non-stream: `mode`, `requestId`, `accountId`, `model`, `request_region`, `usage_capture_state`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `total_tokens`.

### Task 4: Final handoff

**Files:**
- Modify: `docs/plans/2026-03-13-vertex-reconciliation-logging.md`

**Step 1: Summarize results**
- Report the exact files changed and tests run.
- Highlight that logging was added only for `claude-vertex`.

