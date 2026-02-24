# Vertex Claude 4.6 Model ID Mapping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `claude-opus-4-6` and `claude-sonnet-4-6` are forwarded to the correct GCP Vertex Anthropic publisher model IDs.

**Architecture:** Centralize mapping in `gcpVertexRelayService._mapVertexModelId()` so both streaming and non-streaming code paths use identical endpoint model IDs. Preserve explicit Vertex `@` version ids and strip relay-only suffixes like `[1m]` before building the endpoint.

**Tech Stack:** Node.js (CommonJS), Jest, Axios, Google Vertex AI Platform REST API.

---

### Task 1: Add failing relay endpoint tests for 4.6 model ids

**Files:**
- Modify: `tests/gcpVertexRelayService.test.js`

**Step 1: Write the failing test**

Add tests asserting the Vertex endpoint path contains:
- `/models/claude-opus-4-6:rawPredict` when request model is `claude-opus-4-6`
- `/models/claude-sonnet-4-6:rawPredict` when request model is `claude-sonnet-4-6`
- For `claude-opus-4-6[1m]`, endpoint must NOT include `%5B1m%5D`

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/gcpVertexRelayService.test.js`
Expected: FAIL because `_mapVertexModelId()` does not map `claude-sonnet-4-6` and/or does not strip `[1m]`.

**Step 3: Commit**

```bash
git add tests/gcpVertexRelayService.test.js
git commit -m "test: cover Vertex model id mapping for 4.6"
```

---

### Task 2: Implement Vertex model id mapping for Opus/Sonnet 4.6

**Files:**
- Modify: `src/services/relay/gcpVertexRelayService.js`

**Step 1: Implement minimal mapping**

Update `_mapVertexModelId(modelId)`:
- If model id contains `@`, return as-is.
- Strip `[1m]` suffix (case-insensitive) before mapping.
- Map:
  - `claude-opus-4-6` -> `claude-opus-4-6`
  - `claude-sonnet-4-6` -> `claude-sonnet-4-6`

**Step 2: Run test to verify it passes**

Run: `npm test -- tests/gcpVertexRelayService.test.js`
Expected: PASS.

**Step 3: Run full tests**

Run: `npm test`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/services/relay/gcpVertexRelayService.js
git commit -m "fix: map Vertex model ids for Claude 4.6"
```

