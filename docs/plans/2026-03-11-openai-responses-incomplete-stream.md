# OpenAI Responses Incomplete Stream Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/openai/responses` fail explicitly when an upstream SSE stream ends without a terminal Responses event.

**Architecture:** Extend `OpenAIResponsesRelayService._handleStreamResponse` with stream-state tracking for parsed events, terminal events, and forwarded bytes. On stream end, branch into success, `502` JSON, or SSE error emission depending on whether a valid terminal event was observed and whether downstream bytes have already been sent.

**Tech Stack:** Node.js, Jest, EventEmitter-based stream tests, Express-style response mocks.

---

### Task 1: Add failing regression tests

**Files:**
- Modify: `tests/openaiResponsesRelayService.passThrough.test.js`
- Test: `tests/openaiResponsesRelayService.passThrough.test.js`

**Step 1: Write the failing test**

Add one test where the upstream stream ends immediately without any terminal event and assert:

- `res.status(502)` is called
- `res.json({ error: { message: 'Upstream stream ended before completion' } })` is called

Add one test where the upstream emits a normal SSE data chunk without a terminal event, then ends:

- `res.write(...)` receives the original chunk
- `res.write(...)` also receives an SSE `event: error`
- `res.end()` is called

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/openaiResponsesRelayService.passThrough.test.js`

Expected: FAIL because `_handleStreamResponse` currently treats stream `end` as success.

**Step 3: Commit**

Do not commit yet.

### Task 2: Implement minimal incomplete-stream handling

**Files:**
- Modify: `src/services/relay/openaiResponsesRelayService.js`
- Modify: `tests/openaiResponsesRelayService.passThrough.test.js`

**Step 1: Write minimal implementation**

Inside `_handleStreamResponse`:

- track whether any parsable SSE event was seen
- track whether a terminal Responses event was seen
- track whether any bytes were written to the client
- on `response.completed`, `response.failed`, or `response.incomplete`, mark terminal state
- on `end`, if terminal state is missing:
  - log a warning with account/model/event context
  - if no bytes were written, return `502` JSON with message `Upstream stream ended before completion`
  - otherwise emit an SSE `event: error` message describing the interrupted upstream stream, then end

**Step 2: Run tests to verify they pass**

Run: `npm test -- tests/openaiResponsesRelayService.passThrough.test.js`

Expected: PASS

**Step 3: Refactor carefully**

Keep the change local to stream completion handling. Preserve existing usage accounting and canceled
stream behavior.

### Task 3: Verify and commit

**Files:**
- Modify: `src/services/relay/openaiResponsesRelayService.js`
- Modify: `tests/openaiResponsesRelayService.passThrough.test.js`

**Step 1: Run focused verification**

Run: `npm test -- tests/openaiResponsesRelayService.passThrough.test.js`

Run: `./node_modules/.bin/eslint src/services/relay/openaiResponsesRelayService.js tests/openaiResponsesRelayService.passThrough.test.js`

Expected: both commands pass

**Step 2: Review git diff**

Run: `git diff -- src/services/relay/openaiResponsesRelayService.js tests/openaiResponsesRelayService.passThrough.test.js docs/plans/2026-03-11-openai-responses-incomplete-stream-design.md docs/plans/2026-03-11-openai-responses-incomplete-stream.md`

Expected: only the intended stream-state fix, tests, and plan docs are included

**Step 3: Commit**

```bash
git add src/services/relay/openaiResponsesRelayService.js tests/openaiResponsesRelayService.passThrough.test.js docs/plans/2026-03-11-openai-responses-incomplete-stream-design.md docs/plans/2026-03-11-openai-responses-incomplete-stream.md
git commit -m "fix: fail incomplete openai-responses streams explicitly"
```
