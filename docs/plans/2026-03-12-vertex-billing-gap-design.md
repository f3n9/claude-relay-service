# Vertex Billing Gap Design

## Context

`claude-vertex` usage is still materially below actual Google Cloud billing. The remaining gap no
longer looks like a single missing route. The request paths mostly record usage when upstream usage
exists, but the effective billing logic still underestimates several Vertex-specific cost drivers.

## Confirmed Risk Areas

1. `pricingService.calculateCost()` only enables Claude 200K+ long-context pricing when the model
   name contains `[1m]` or the request carries Anthropic `context-1m` beta metadata.
2. `gcpVertexRelayService` knows the Vertex `location`, but that endpoint context is not passed
   into cost calculation.
3. Admin aggregate cost endpoints still recalculate some summaries from model-level token buckets,
   which loses request-level billing signals such as long-context mode, fast mode, and any future
   endpoint-specific premiums.

## Goal

Reduce the remaining Vertex billing gap by aligning request-time cost calculation and admin
aggregate summaries with the actual Vertex billing context.

## Approaches

### Approach A: Pricing only

Patch only `pricingService`.

Pros:
- Smallest code change.

Cons:
- Existing summary endpoints that recalculate from aggregated tokens remain inaccurate.
- Vertex endpoint context would still need propagation.

### Approach B: Summary only

Patch only admin usage aggregation to read stored costs everywhere.

Pros:
- Improves displayed totals immediately.

Cons:
- Leaves request-time real cost wrong for newly recorded data.

### Approach C: Request-time pricing + summary preference for stored costs

Recommended.

1. Pass Vertex account location into usage billing metadata.
2. Teach `pricingService` to treat Vertex Claude requests above 200K input as long-context priced
   even without Anthropic beta signals.
3. Apply Vertex regional endpoint premium from pricing metadata.
4. Make legacy admin aggregate endpoints prefer stored `realCostMicro/ratedCostMicro` when present,
   and avoid token-only recalculation when stored costs are available.

Pros:
- Fixes the billing base and the displayed totals.
- Preserves current routing and usage capture model.

Cons:
- Touches pricing, routes, and admin aggregation together.

## Recommended Design

### 1. Vertex billing metadata propagation

When `claude-vertex` requests record usage, attach request metadata that cost calculation can use:

- `request_provider = 'vertex'`
- `request_region = <vertex location>`

This should be added in both:

- Anthropic `/v1/messages` route
- OpenAI-compatible Claude route

### 2. Vertex long-context pricing inference

In `pricingService.calculateCost()`:

- Keep the existing `[1m]` and Anthropic beta detection.
- Add a Vertex-specific path:
  - when provider is Vertex
  - model is Claude
  - total input tokens exceed 200K
  - pricing data advertises large input capacity (for example `max_input_tokens > 200000`)
  then enable 200K+ pricing even without `[1m]` or Anthropic beta metadata.

This targets models such as Vertex Claude Sonnet 4.6 where cloud billing can apply long-context
pricing without the Anthropic beta signal used elsewhere in the relay.

### 3. Vertex regional endpoint premium

In `pricingService.calculateCost()`:

- inspect `request_region`
- if provider is Vertex and region is not `global`
- apply `provider_specific_entry.us` as a general regional premium multiplier when present

This is deliberately narrow and only uses pricing metadata already shipped with the model record.

### 4. Aggregate summary preference for stored costs

Admin summary endpoints should prefer persisted `realCostMicro/ratedCostMicro` from Redis buckets
when those fields exist, instead of recomputing from tokens.

That includes:

- API key hourly/daily summaries
- account hourly/daily summaries
- `/admin/usage-costs` 7-day and total periods when indexed usage already carries stored cost

## Scope

Modify:

- `src/services/pricingService.js`
- `src/routes/api.js`
- `src/routes/openaiClaudeRoutes.js`
- `src/routes/admin/usageStats.js`
- tests covering pricing, route metadata propagation, and admin aggregate cost preference

Do not modify:

- schedulers
- upstream request protocol
- Redis schema beyond consuming already stored cost fields

## Testing

Add regression coverage for:

1. Vertex Claude Sonnet 4.6 over 200K input without `[1m]` or beta still uses 200K+ pricing
2. Vertex non-global region applies regional premium
3. Vertex route handlers pass provider/region metadata into `recordUsageWithDetails`
4. Admin aggregate cost endpoints prefer stored micro-cost values over token recalculation
