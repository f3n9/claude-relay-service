# OpenAI image generation

`POST /openai/v1/images/generations` (alias: `/openai/images/generations`)
uses existing API key authentication and OpenAI account bindings. The default
image model is `gpt-image-2`.

OpenAI API accounts (`openai-responses`) call the provider's native Images API.
OAuth accounts use the Codex Responses image tool with `gpt-5.4-mini` as the
outer model. Providers must support the requested model and endpoint.
API key model restrictions apply to the requested image model and, for OAuth
accounts, the outer Codex model before sending the generation request.

## Streaming

Send `stream: true` and optionally `partial_images: 0..3`. The response is SSE,
with `image_generation.partial_image` and `image_generation.completed` events.
Without streaming the response remains the Images API JSON object. A failure
before the first event returns an HTTP error; a failure after streaming starts
returns an `error` event and closes the stream. Disconnects cancel upstream work.

The official documentation checked on 2026-09-05 is inconsistent: the model
catalog says Streaming is unsupported, but the image-generation guide includes
an explicit `gpt-image-2`, `stream: true` example and the Images API reference
defines streaming. This implementation follows that endpoint-specific contract.

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/models/gpt-image-2

## Pricing

Default standard (not Batch) OpenAI rates for `gpt-image-2`, checked 2026-09-05,
in USD per million tokens:

| Category | Input | Cached input | Output |
| -------- | ----: | -----------: | -----: |
| Text     |     5 |         1.25 |      — |
| Image    |     8 |            2 |     30 |

Source: https://developers.openai.com/api/docs/pricing

The calculator uses the upstream usage and token details, not the base64 length
or a flat per-image estimate. Older GPT Image models use their image-specific
rates from the bundled price table. Existing service/API key multipliers apply
after computing official cost. The resulting amounts feed request records,
account totals, quotas, and API key rate-limit counters. Stored request records
also contain the image token breakdown. Existing historical records are not
recalculated. Prices are a code snapshot and need updating when OpenAI changes them.

Image inputs default to zero when no breakdown is reported (the generations
endpoint normally receives text). If mixed input cache usage lacks a modality
breakdown, cached tokens are allocated to text first, then images; exact mixed
cache billing requires provider details. Aggregate reports without modality
details cannot reconstruct mixed-input costs; use stored monetary totals.

Codex `response.usage` describes the outer model. Separately reported image tool
usage is billed at image rates. If Codex omits tool usage, the service logs that
image cost is unavailable and records only the reported outer-model usage.
If only image tool usage is reported, it is still recorded without inventing
outer-model tokens.
It does not invent image token counts. Native Images API accounts are the path
for image-token billing based on the official Images usage response.
