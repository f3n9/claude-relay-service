# Claude OpenAI Bridge Routing and Usage Design

## Goal

When `/api` receives a Claude Messages request, the service should first select the normal Claude-side account exactly as it does today. If that selected account has a bridge routing rule whose source model matches the request model, the service should hand the request to the rule's bridge account, rewrite the upstream OpenAI-compatible `model` field to the rule's target model, and record enough usage/history data to show both the originally selected Claude account and the bridge account that actually handled the request.

## Existing Behavior To Keep

- The global Claude OpenAI bridge switch controls whether bridge routing is considered.
- `/api` uses the existing API key configuration, account binding/group rules, availability checks, and account priorities to choose a Claude-side account.
- A selected Claude-side account may own bridge routing rules with `sourceModel`, `bridgeAccountId`, `targetModel`, and `enabled`.
- A matched bridge request is sent to the routing rule's bridge account OpenAI-compatible `/chat/completions` endpoint.
- The upstream request body uses the routing rule's `targetModel`.
- The downstream Claude response keeps the original source model.
- Bridge account `dailyQuota` and `dailyUsage` are USD-denominated local cost limits.

## Routing

The existing Claude account scheduler remains the first routing authority:

1. Read the incoming Claude Messages `model` as `sourceModel`.
2. Run the existing `/api` Claude scheduling path with the current API key, bindings, groups, priorities, model support checks, rate-limit checks, and availability checks.
3. If no normal Claude-side account can be selected, keep the existing error behavior.
4. If the bridge global switch is disabled, use the selected Claude-side account normally.
5. Load the selected Claude-side account's bridge routing rules.
6. If no enabled rule has `sourceModel` exactly equal to the incoming model, use the selected Claude-side account normally.
7. If a rule matches, load the rule's `bridgeAccountId` and verify that bridge account is active, schedulable, not quota-stopped, not rate-limited, not expired, and configured with endpoint/API key.
8. Convert the Claude Messages body to OpenAI chat completions format and set upstream `model` to the rule's `targetModel`.
9. Send the converted request to the bridge account.

The bridge service must not globally scan bridge accounts before normal Claude account selection. The selected Claude-side account decides whether a request is bridged.

The normal selected account can be any Claude-side account type currently returned by the unified Claude scheduler, including Claude official, Claude Console, Vertex, Bedrock, or CCR. A bridge routing rule on any of those account types has the same meaning: this account would have handled the request, but delegates matching models to the configured bridge account.

## Usage And History

For bridge-handled requests, usage records must represent the actual account that processed the request:

- `accountId`: selected bridge account id.
- `accountType`: `claude-openai-bridge`.
- `model`: original source model from the Claude Messages request.
- `inputTokens` and `outputTokens`: values converted from upstream OpenAI-compatible usage.
- `cost` and `realCost`: calculated from the source model, preserving the service's existing rated-cost behavior.

Request detail metadata should retain bridge-specific routing evidence and original scheduler context:

- `bridgeSourceAccountId`: id of the normal Claude-side account selected before bridge routing.
- `bridgeSourceAccountType`: account type selected before bridge routing.
- `bridgeSourceAccountName`: display name of the normal Claude-side account, when available.
- `bridgeAccountId`: selected bridge account id.
- `bridgeAccountName`: selected bridge account display name, when available.
- `bridgeTargetModel`: mapped upstream model.
- `bridgeRequestBody`: OpenAI chat completions body sent upstream, with its `model` set to the target model.

Admin API key history, account history, and global request detail views should resolve and display the bridge account as the actual processing account using `accountType = claude-openai-bridge`. When request detail metadata is available, views should also expose the original selected Claude-side account so operators can see which account delegated the request.

## USD Daily Limits

Bridge account daily quotas remain USD-denominated:

1. After a bridge response yields non-zero cost, add that request cost to the bridge account's `dailyUsage`.
2. If `dailyUsage >= dailyQuota`, mark the account quota-stopped and unschedulable.
3. Future model selection must not choose quota-stopped bridge accounts.
4. When the daily reset window rolls over, stale quota-stopped bridge accounts are reset before selection and become schedulable again.

API key daily cost limits remain handled by the existing API key/rate-limit path. The bridge work must not bypass API key cost counters.

## Implementation Scope

This change should not introduce a new global routing policy table and should not let bridge accounts preempt normal scheduling. Bridge routing rules belong to the selected Claude-side account.

Expected integration points:

- Claude-side account storage and admin APIs/forms: add `bridgeRoutingRules` to supported account types that can be selected by `/api`.
- `/api` route: move bridge decision point to after `unifiedClaudeScheduler.selectAccountForApiKey()` returns the normal account.
- Bridge routing helper: resolve rules from the selected account and validate the target bridge account.
- `src/services/requestDetailService.js`: add bridge account type name and account resolver.
- `src/routes/admin/usageStats.js`: add bridge type name and account resolver in usage history/detail APIs.
- `src/models/redis.js`: teach account usage stats how to resolve bridge account metadata.
- `src/services/account/claudeOpenAIBridgeAccountService.js`: ensure USD quota stop/reset behavior is covered by tests.
- `src/services/relay/claudeOpenAIBridgeRelayService.js`: accept selected-source-account context, preserve current usage recording semantics, and add tests where metadata/history expectations are missing.

## Testing

Add or update focused Jest tests before implementation:

- `/api` first selects the normal Claude-side account before evaluating bridge routing rules.
- A matching rule on the selected account routes to the expected bridge account and target model.
- A rule on a non-selected account does not affect the request.
- If the selected account has multiple rules, only an enabled exact `sourceModel` match is used.
- A bridge request records API key usage with `accountType = claude-openai-bridge` and selected bridge `accountId`.
- Request detail metadata records the original selected Claude-side account and the actual bridge account.
- Request detail display resolves `claude-openai-bridge` account names.
- Admin usage history resolves bridge account names and type labels.
- Redis account usage stats resolves bridge account metadata for averages.
- A bridge account with exhausted USD `dailyQuota` is not selected; after the reset date changes, it is eligible again.

## Out Of Scope

- Moving model mappings into a separate global routing table.
- Changing bridge account `dailyQuota` from USD to token-based limits.
- Changing pricing behavior to use the upstream target model.
- Adding fallback retries across multiple bridge accounts after an upstream error.
- Globally matching bridge accounts before the normal Claude account scheduler runs.
