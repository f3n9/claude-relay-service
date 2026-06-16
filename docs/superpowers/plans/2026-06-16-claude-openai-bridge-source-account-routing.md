# Claude OpenAI Bridge Source Account Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Claude Messages requests to bridge accounts only after the normal Claude scheduler selects a source account, using per-source-account routing rules.

**Architecture:** Add normalized `bridgeRoutingRules` storage to Claude-side account services, add a small resolver that evaluates rules against the selected source account and validates the bridge account, move `/api` bridge dispatch after normal scheduling, and extend usage/request-detail metadata to show both source and bridge accounts. Keep bridge account USD quota behavior and existing OpenAI-compatible conversion.

**Tech Stack:** Node.js, Express, Redis-backed account services, Jest/SuperTest, Vue admin SPA.

---

### Task 1: Bridge Routing Rule Storage

**Files:**
- Create: `src/utils/bridgeRoutingRules.js`
- Modify: `src/services/account/claudeAccountService.js`
- Modify: `src/services/account/claudeConsoleAccountService.js`
- Modify: `src/services/account/gcpVertexAccountService.js`
- Modify: `src/services/account/bedrockAccountService.js`
- Modify: `src/services/account/ccrAccountService.js`
- Test: `tests/bridgeRoutingRules.test.js`

- [ ] Write tests for normalizing `sourceModel`, `bridgeAccountId`, `targetModel`, and `enabled`.
- [ ] Run `npm test -- --runTestsByPath tests/bridgeRoutingRules.test.js --runInBand`; expect missing module failure.
- [ ] Implement `normalizeBridgeRoutingRules()` and `parseBridgeRoutingRules()`.
- [ ] Add `bridgeRoutingRules` persistence/read support to source account services.
- [ ] Run the focused test; expect pass.

### Task 2: Source Account Bridge Resolver

**Files:**
- Create: `src/services/claudeOpenAIBridgeSourceRoutingService.js`
- Modify: `src/services/account/claudeOpenAIBridgeAccountService.js`
- Test: `tests/claudeOpenAIBridgeSourceRoutingService.test.js`

- [ ] Write tests that selected source account rules resolve the bridge account and target model.
- [ ] Write tests that disabled rules, non-matching source models, global disabled config, and exhausted bridge USD quota return no bridge selection.
- [ ] Run the focused test; expect missing module or missing function failure.
- [ ] Implement resolver with `resolveBridgeSelection({ sourceAccountId, sourceAccountType, sourceModel })`.
- [ ] Add reusable bridge account eligibility/selection helper without globally scanning bridge mappings.
- [ ] Run focused tests; expect pass.

### Task 3: Move `/api` Bridge Decision After Scheduler

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/services/relay/claudeOpenAIBridgeRelayService.js`
- Test: `tests/api.claudeOpenAIBridgeRouting.test.js`
- Test: `tests/claudeOpenAIBridgeRelayService.test.js`

- [ ] Rewrite route tests so normal scheduler is called before bridge routing.
- [ ] Test that a rule on the selected account bridges and a rule on another account does not.
- [ ] Test relay request metadata includes source account and bridge account context.
- [ ] Run focused tests; expect failure with current pre-scheduler bridge behavior.
- [ ] Move bridge resolution to after account selection in stream and non-stream paths.
- [ ] Pass source account context into bridge relay.
- [ ] Run focused tests; expect pass.

### Task 4: Usage And History Integration

**Files:**
- Modify: `src/services/requestDetailService.js`
- Modify: `src/routes/admin/usageStats.js`
- Modify: `src/models/redis.js`
- Test: `tests/requestDetailService.test.js`
- Test: `tests/usageStats.route.test.js`
- Test: `tests/admin.claudeOpenAIBridgeAccounts.test.js`

- [ ] Write tests that request detail resolves `claude-openai-bridge` account names and carries bridge source metadata.
- [ ] Write tests that admin usage history resolves bridge account type/name.
- [ ] Write tests that Redis account usage stats resolves bridge account metadata for averages.
- [ ] Run focused tests; expect failures for missing bridge support.
- [ ] Add bridge account resolver/name support in request detail and usage stats.
- [ ] Add bridge account metadata lookup in Redis account usage stats.
- [ ] Run focused tests; expect pass.

### Task 5: Admin UI Rule Editing

**Files:**
- Modify: `web/admin-spa/src/components/accounts/AccountForm.vue`
- Modify: `web/admin-spa/src/views/AccountsView.vue` if account list payload shaping needs bridge rule display support.

- [ ] Add form state for `bridgeRoutingRules`.
- [ ] Add controls to choose source model, bridge account, target model, and enabled state.
- [ ] Include rules in create/update payloads for Claude-side accounts.
- [ ] Run `npm run build:web`; expect pass.

### Task 6: Final Verification

**Files:**
- All changed files.

- [ ] Run bridge focused backend tests with `--runTestsByPath`.
- [ ] Run `npm run build:web`.
- [ ] Run `npm test -- --runInBand --testPathIgnorePatterns=.worktrees --forceExit`.
- [ ] Run `git diff --check`.
- [ ] Commit implementation.
