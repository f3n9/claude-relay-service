# Vertex Claude 4.6 Model ID Mapping Design

**Goal:** Ensure requests for `claude-opus-4-6` and `claude-sonnet-4-6` are forwarded to the correct GCP Vertex Anthropic publisher model IDs.

**Context:** The relay builds Vertex endpoints like:
`/publishers/anthropic/models/<MODEL_ID>:rawPredict` and `:streamRawPredict`.
The `<MODEL_ID>` must match the Vertex publisher model ID.

## Requirements

- When clients request `claude-opus-4-6`, the relay must call Vertex with model id `claude-opus-4-6`.
- When clients request `claude-sonnet-4-6`, the relay must call Vertex with model id `claude-sonnet-4-6`.
- Preserve pass-through behavior for explicit versioned Vertex ids using `@` (e.g. `claude-sonnet-4-5@20250929`).
- Strip relay-only suffixes like `[1m]` from the model before building the Vertex endpoint path to avoid invalid/encoded model ids.

## Proposed Changes

- Update `src/services/relay/gcpVertexRelayService.js` `_mapVertexModelId()`:
  - If the requested model contains `@`, return as-is.
  - Remove `[1m]` suffix (case-insensitive) before applying mapping rules.
  - Add a mapping entry for `claude-sonnet-4-6`.
  - Keep existing mappings (e.g. `claude-sonnet-4-5-20250929` -> `claude-sonnet-4-5@20250929`).

## Test Plan

- Extend `tests/gcpVertexRelayService.test.js`:
  - Non-stream endpoint for `claude-opus-4-6` uses `/models/claude-opus-4-6:rawPredict`.
  - Non-stream endpoint for `claude-sonnet-4-6` uses `/models/claude-sonnet-4-6:rawPredict`.
  - `[1m]` variant (e.g. `claude-opus-4-6[1m]`) does not appear in the Vertex endpoint (no `%5B1m%5D`).
  - Stream endpoint for at least one of them uses `:streamRawPredict`.

## Non-Goals

- Updating pricing tables, limits, or token accounting.
- Adding per-account model mapping UI/fields for Vertex.

