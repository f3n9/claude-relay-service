# Claude OpenAI Bridge Routing and Usage Design

## Goal

When `/api` receives a Claude Messages request, the service should route matching models to a configured Claude OpenAI bridge account, rewrite the upstream OpenAI-compatible `model` field using that account's mapping, and record enough usage/history data to show which bridge account handled the request.

## Existing Behavior To Keep

- The global Claude OpenAI bridge switch controls whether bridge routing is considered.
- Each bridge account owns `modelMappings` entries with `sourceModel`, `targetModel`, and `enabled`.
- `/api` calls `selectAccountForModel(sourceModel, { boundAccountId })` before normal Claude scheduling.
- A matched bridge request is sent to the selected account's OpenAI-compatible `/chat/completions` endpoint.
- The upstream request body uses the mapping's `targetModel`.
- The downstream Claude response keeps the original source model.
- Bridge account `dailyQuota` and `dailyUsage` are USD-denominated local cost limits.

## Routing

The existing routing model remains the source of truth:

1. Read the incoming Claude Messages `model` as `sourceModel`.
2. If the bridge global switch is disabled, skip bridge routing.
3. If the API key has `claudeOpenAIBridgeAccountId`, try that account or group first.
4. Otherwise search shared bridge accounts.
5. Only accounts with an enabled mapping whose `sourceModel` exactly equals the incoming model are eligible.
6. Choose among eligible accounts using the existing priority sorter.
7. Convert the Claude Messages body to OpenAI chat completions format and set upstream `model` to the mapping's `targetModel`.

If no bridge account matches, `/api` falls through to the existing Claude/Vertex/Bedrock routing.

## Usage And History

For bridge-handled requests, usage records must represent the actual account that processed the request:

- `accountId`: selected bridge account id.
- `accountType`: `claude-openai-bridge`.
- `model`: original source model from the Claude Messages request.
- `inputTokens` and `outputTokens`: values converted from upstream OpenAI-compatible usage.
- `cost` and `realCost`: calculated from the source model, preserving the service's existing rated-cost behavior.

Request detail metadata should also retain bridge-specific routing evidence:

- `bridgeTargetModel`: mapped upstream model.
- `bridgeRequestBody`: OpenAI chat completions body sent upstream, with its `model` set to the target model.

Admin API key history, account history, and global request detail views should resolve and display bridge account names using `accountType = claude-openai-bridge`.

## USD Daily Limits

Bridge account daily quotas remain USD-denominated:

1. After a bridge response yields non-zero cost, add that request cost to the bridge account's `dailyUsage`.
2. If `dailyUsage >= dailyQuota`, mark the account quota-stopped and unschedulable.
3. Future model selection must not choose quota-stopped bridge accounts.
4. When the daily reset window rolls over, stale quota-stopped bridge accounts are reset before selection and become schedulable again.

API key daily cost limits remain handled by the existing API key/rate-limit path. The bridge work must not bypass API key cost counters.

## Implementation Scope

This change should not introduce a new global routing policy table. The bridge account service already owns the model mapping and selection rules. The implementation should focus on completing integration points that still treat bridge accounts as unknown accounts.

Expected integration points:

- `src/services/requestDetailService.js`: add bridge account type name and account resolver.
- `src/routes/admin/usageStats.js`: add bridge type name and account resolver in usage history/detail APIs.
- `src/models/redis.js`: teach account usage stats how to resolve bridge account metadata.
- `src/services/account/claudeOpenAIBridgeAccountService.js`: ensure USD quota stop/reset behavior is covered by tests.
- `src/services/relay/claudeOpenAIBridgeRelayService.js`: preserve current usage recording semantics and add tests where metadata/history expectations are missing.

## Testing

Add or update focused Jest tests before implementation:

- `/api` routes a matching model to the expected bridge account and target model.
- If two bridge accounts support different models, each model selects the matching account.
- A bridge request records API key usage with `accountType = claude-openai-bridge` and selected bridge `accountId`.
- Request detail display resolves `claude-openai-bridge` account names.
- Admin usage history resolves bridge account names and type labels.
- Redis account usage stats resolves bridge account metadata for averages.
- A bridge account with exhausted USD `dailyQuota` is not selected; after the reset date changes, it is eligible again.

## Out Of Scope

- Moving model mappings into a separate global routing table.
- Changing bridge account `dailyQuota` from USD to token-based limits.
- Changing pricing behavior to use the upstream target model.
- Adding fallback retries across multiple bridge accounts after an upstream error.
