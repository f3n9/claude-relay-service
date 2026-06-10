# Claude OpenAI Bridge Design

## Context

`/api/v1/messages` currently accepts Claude Messages API requests and routes them through the
normal Claude-side account scheduler after request validation. The new requirement is to intercept a
configured subset of Claude model names and send those requests to an OpenAI-compatible
`chat/completions` endpoint, then return the upstream response in Claude Messages API format.

This bridge must be independent from the existing OpenAI and OpenAI-Responses account pools. Admins
need a dedicated configuration surface for bridge accounts, model mappings, endpoint credentials,
proxy settings, quota controls, and an overall enable switch.

## Goals

- Add a global enable switch for the bridge. When disabled, `/api` behavior stays unchanged.
- Add admin-managed `claude-openai-bridge` accounts with endpoint URL, API key, proxy, quota, status,
  priority, and model mapping configuration.
- Intercept only `/api/v1/messages` requests whose `model` exactly matches an enabled mapping.
- Convert Claude Messages requests to OpenAI-compatible `/chat/completions` requests and replace the
  request model with the configured target model.
- Convert OpenAI-compatible non-stream and stream responses back to Claude Messages API response
  format.
- Preserve usage accounting, request detail metadata, rate-limit counters, and useful operational
  logs.
- Support normal text, tool calling, function calling, and common generation parameters where the
  two API shapes overlap.

## Non-Goals

- Do not reuse the existing OpenAI OAuth or OpenAI-Responses account scheduler.
- Do not change normal Claude, Claude Console, Vertex, Bedrock, CCR, Gemini, or count-tokens routing
  when the bridge is disabled or when no model mapping matches.
- Do not implement OpenAI legacy `/v1/completions`; the target is OpenAI-compatible
  `chat/completions`.
- Do not require endpoint URL path rewriting. The account stores the complete request URL, for
  example `https://bc-openai-1.openai.azure.com/openai/v1/chat/completions`.

## Admin Configuration

Add a global setting, stored in Redis through a small config service:

- `claudeOpenAIBridge.enabled`: boolean, default `false`

Add a dedicated bridge account resource. Each account contains:

- `id`
- `name`
- `description`
- `endpointUrl`: complete OpenAI-compatible chat completions URL
- `apiKey`: encrypted at rest and never returned in plaintext through list/detail APIs
- `proxy`: optional proxy configuration, matching the shape used by existing account services
- `isActive`: boolean
- `schedulable`: boolean
- `status`: `active`, `rateLimited`, `quotaExceeded`, `unauthorized`, or `error`
- `priority`: integer, default `50`; lower numbers are selected first
- `rateLimitDuration`: minutes used when upstream rate-limit handling marks the account temporarily
  unavailable
- `dailyQuota`: daily spending quota, `0` meaning unlimited
- `dailyUsage`: tracked daily cost
- `quotaResetTime`
- `disableAutoProtection`: boolean
- `modelMappings`: array of exact source-to-target model mappings
- `createdAt`, `updatedAt`, `lastUsedAt`

Initial mappings can be configured as:

```json
[
  { "sourceModel": "deepseek-v4-pro", "targetModel": "DeepSeek-V4-Pro", "enabled": true },
  { "sourceModel": "deepseek-v4-flash", "targetModel": "DeepSeek-V4-Flash", "enabled": true },
  { "sourceModel": "kimi-k2.6", "targetModel": "Kimi-K2.6", "enabled": true },
  { "sourceModel": "grok-4.3", "targetModel": "grok-4.3", "enabled": true }
]
```

If more than one active account maps the same source model, select an eligible account by ascending
`priority`, then oldest `lastUsedAt`, then oldest `createdAt`.

## Backend API

Add admin routes:

- `GET /admin/claude-openai-bridge/config`
- `PUT /admin/claude-openai-bridge/config`
- `GET /admin/claude-openai-bridge/accounts`
- `POST /admin/claude-openai-bridge/accounts`
- `PUT /admin/claude-openai-bridge/accounts/:id`
- `DELETE /admin/claude-openai-bridge/accounts/:id`
- `PUT /admin/claude-openai-bridge/accounts/:id/toggle`
- `PUT /admin/claude-openai-bridge/accounts/:id/toggle-schedulable`
- `POST /admin/claude-openai-bridge/accounts/:id/reset-status`
- `POST /admin/claude-openai-bridge/accounts/:id/reset-usage`
- `POST /admin/claude-openai-bridge/accounts/:id/test`

The test endpoint sends a minimal OpenAI-compatible request to `endpointUrl` with the first enabled
target model or an admin-supplied target model.

## Request Routing

In `src/routes/api.js`, after the existing request body validation, service permission check, model
restriction check, 1M-context authorization check, logging, dump, and forced Gemini vendor branch,
check the bridge:

1. If the global switch is disabled, continue with current logic.
2. If no enabled account has an enabled exact mapping for `req.body.model`, continue with current
   logic.
3. If a mapping exists, select an eligible bridge account.
4. Log that the request is being handled by the bridge instead of normal Claude scheduling.
5. Call the bridge relay service and return its response.

This means non-matching models and disabled bridge configuration keep current behavior exactly.

The bridge does not first select a Claude account. Logs should still make the handoff explicit by
recording the incoming service family as `claude-messages` and the selected destination as the
bridge account:

```json
{
  "route": "/v1/messages",
  "sourceService": "claude-messages",
  "sourceModel": "deepseek-v4-flash",
  "bridgeAccountId": "account-id",
  "bridgeAccountName": "Azure BC OpenAI",
  "targetEndpoint": "https://bc-openai-1.openai.azure.com/openai/v1/chat/completions",
  "targetModel": "DeepSeek-V4-Flash",
  "stream": true
}
```

If the API key is conceptually bound to a Claude account today, the log can also include
`apiKeyClaudeBinding` fields from the key data. The bridge should not consume that Claude account.

## Request Conversion

Convert Claude Messages request fields into OpenAI-compatible chat completions:

- `model`: use mapping `targetModel`
- `messages`: convert Claude `system` and `messages`
- `max_tokens`: copy from Claude `max_tokens`
- `temperature`: copy if present
- `top_p`: copy if present
- `stop`: from Claude `stop_sequences`
- `stream`: copy boolean
- `tools`: convert Claude tools to OpenAI function tools
- `tool_choice`: convert `auto`, `any`, `none`, and named tool choices
- `metadata`, `user`, or vendor-specific fields: do not forward unless explicitly supported
- `reasoning_effort`: pass through if present
- `presence_penalty` and `frequency_penalty`: pass through if present

Message conversion:

- Claude top-level `system` string or text blocks become one OpenAI `system` message.
- Claude `user` and `assistant` text blocks become OpenAI `user` and `assistant` messages.
- Claude `tool_use` blocks in assistant messages become OpenAI `tool_calls`.
- Claude `tool_result` blocks in user messages become OpenAI `tool` messages with
  `tool_call_id`.
- Claude image blocks with base64 source become OpenAI image content blocks when possible.
- Unsupported content blocks should be converted to text placeholders only when needed to preserve
  conversation continuity; otherwise omit them and log at debug level.

## Response Conversion

For non-stream OpenAI-compatible responses:

- Return Claude-style `message` JSON.
- Text `message.content` becomes `{ "type": "text", "text": "..." }`.
- `tool_calls` and legacy `function_call` become Claude `{ "type": "tool_use", ... }` blocks.
- `finish_reason: "tool_calls"` maps to `stop_reason: "tool_use"`.
- `finish_reason: "length"` maps to `stop_reason: "max_tokens"`.
- `finish_reason: "stop"` maps to `stop_reason: "end_turn"`.
- Usage maps `prompt_tokens` to `input_tokens` and `completion_tokens` to `output_tokens`.
- The response `model` should be the original source model, so callers see the model they requested.

For stream responses:

- Accept upstream OpenAI SSE events from `chat.completion.chunk` shape.
- Emit Claude Messages SSE events:
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `content_block_stop`
  - `message_delta`
  - `message_stop`
- Text deltas stream as Claude `text_delta`.
- Tool call deltas stream as Claude `tool_use` blocks with `input_json_delta`.
- Usage from an upstream terminal or usage chunk should be captured when present.
- If upstream closes before a terminal chunk, end the Claude stream with an error event if bytes have
  already been sent; otherwise return a JSON upstream error.

## Usage, Quota, And Rate Limits

Record successful usage through existing `apiKeyService.recordUsage` or `recordUsageWithDetails`
with:

- `accountId`: bridge account id
- `accountType`: `claude-openai-bridge`
- `model`: original source model
- input/output/cache tokens derived from converted usage
- request detail metadata including original Claude request and converted target model

Daily quota should use the calculated request cost from the existing cost calculator when pricing
exists for the source model. If pricing is missing, record token usage and leave daily cost as `0`,
matching the repository's existing fallback behavior.

When upstream returns `429`, mark the bridge account rate-limited unless `disableAutoProtection` is
enabled. When upstream returns `401` or `403`, mark it temporarily unavailable or unauthorized using
the same safety posture as existing account services. When upstream returns repeated `5xx`, mark it
temporarily unavailable unless auto-protection is disabled.

Rate-limit counters attached to the caller API key should be updated after usage is recorded.

## Frontend

Add a new Account Management platform tab for `Claude OpenAI Bridge`.

The tab should support:

- listing accounts with status, enabled state, schedulable state, quota, priority, endpoint host,
  model mapping count, and last-used time
- global bridge enable switch
- create/edit modal for endpoint URL, API key, proxy, quota, priority, flags, and model mappings
- add/remove model mapping rows
- test account action
- reset status and reset usage actions

The UI should follow the existing accounts page density and control style.

## Testing

Backend tests should cover:

- global switch disabled keeps current `/api/v1/messages` branch untouched
- no mapping keeps current branch untouched
- matching model selects a bridge account and posts to its configured endpoint URL
- request model replacement uses `targetModel`
- non-stream text response is converted to Claude Messages JSON
- non-stream tool call response is converted to Claude `tool_use`
- stream text chunks are converted to Claude SSE events
- stream tool call chunks are converted to Claude tool-use SSE events
- usage is recorded against `claude-openai-bridge` and original source model
- upstream 429/401/5xx updates bridge account status according to auto-protection settings

Frontend verification should include:

- `npm run install:web && npm run build:web`
- admin tab can render empty state, account rows, and mapping rows
