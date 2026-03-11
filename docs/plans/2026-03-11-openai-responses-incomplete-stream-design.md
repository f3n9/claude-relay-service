# OpenAI Responses Incomplete Stream Design

## Context

`/openai/responses` pass-through mode can receive upstream SSE streams that close normally without
emitting a terminal Responses event such as `response.completed`, `response.failed`, or
`response.incomplete`.

The current implementation in `src/services/relay/openaiResponsesRelayService.js` treats every
stream `end` as success. That causes the relay to log a completed request even when no terminal
event was observed, which matches the observed production signature:

- `Stream response completed`
- `hasUsage: false`
- `actualModel: unknown`

Downstream clients such as OpenClaw can then interpret the truncated stream as a generic overload
condition.

## Goal

Make incomplete upstream Responses streams fail explicitly instead of silently completing.

## Recommended Approach

Track stream-level state inside `_handleStreamResponse`:

- whether any parsable SSE event was seen
- whether a terminal Responses event was seen
- whether any bytes were forwarded to the downstream client

On upstream stream `end`:

- if a terminal event was seen, preserve existing behavior
- if no terminal event was seen and no bytes were written yet, return `502` JSON
- if no terminal event was seen but bytes were already streamed, emit an SSE `event: error` payload
  and then end the response

## Error Semantics

The new error path should describe the real failure mode: upstream stream ended unexpectedly before
completion. It should not be mapped to a false success, and it should not depend on the upstream
having returned an explicit 429/529.

This keeps behavior aligned with other stream bridges in the repository that already guard against
silent upstream truncation.

## Scope

Modify only the OpenAI Responses relay streaming path:

- `src/services/relay/openaiResponsesRelayService.js`
- `tests/openaiResponsesRelayService.passThrough.test.js`

Do not change non-stream responses or general route-level error handling in this fix.

## Testing

Add regression coverage for:

1. stream ends without terminal event and without any forwarded bytes -> `502` JSON error
2. stream ends without terminal event after partial bytes were forwarded -> SSE error event then end
3. existing completed stream behavior remains unchanged
