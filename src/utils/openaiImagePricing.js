// Standard (non-Batch) OpenAI prices, USD per token. Verified 2026-09-05:
// https://developers.openai.com/api/docs/pricing
// Image API output_tokens are image tokens unless output_tokens_details says otherwise.
const fallback = require('../../resources/model-pricing/model_prices_and_context_window.json')
const image2 = {
  input_cost_per_token: 5e-6,
  cache_read_input_token_cost: 1.25e-6,
  input_cost_per_image_token: 8e-6,
  cache_read_input_image_token_cost: 2e-6,
  output_cost_per_image_token: 30e-6,
  output_cost_per_token: 0
}

function getOfficialImagePricing(model) {
  if (/^gpt-image-2(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
    return image2
  }
  return fallback[model]
}

function tokens(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
}

function calculateImageCost(usage, model) {
  const pricing = getOfficialImagePricing(model)
  if (!pricing?.output_cost_per_image_token) {
    throw new Error(`No official image pricing available for ${model}`)
  }
  const input = usage.input_tokens_details || {}
  const cached = input.cached_tokens_details || {}
  const inputTokens = tokens(usage.input_tokens)
  const imageTokens = Math.min(inputTokens, tokens(input.image_tokens))
  const textTokens = inputTokens - imageTokens
  const totalCached = Math.min(
    inputTokens,
    tokens(input.cached_tokens ?? usage.cache_read_input_tokens)
  )
  // Image generations are text-only by default. If a provider reports mixed
  // inputs and only an aggregate cache count, allocate the remainder to images.
  const cachedText = Math.min(
    textTokens,
    totalCached,
    cached.text_tokens !== undefined
      ? tokens(cached.text_tokens)
      : Math.max(0, totalCached - tokens(cached.image_tokens))
  )
  const cachedImages = Math.min(imageTokens, totalCached - cachedText)
  const outputTokens = tokens(usage.output_tokens)
  const textOutput = Math.min(outputTokens, tokens(usage.output_tokens_details?.text_tokens))
  const imageOutput = outputTokens - textOutput
  const inputCost =
    (textTokens - cachedText) * pricing.input_cost_per_token +
    (imageTokens - cachedImages) * pricing.input_cost_per_image_token
  const cacheReadCost =
    cachedText * pricing.cache_read_input_token_cost +
    cachedImages * pricing.cache_read_input_image_token_cost
  const outputCost =
    imageOutput * pricing.output_cost_per_image_token +
    textOutput * (pricing.output_cost_per_token || 0)
  return {
    model,
    usingDynamicPricing: false,
    pricing: {
      input: pricing.input_cost_per_token * 1e6,
      output: pricing.output_cost_per_image_token * 1e6,
      cacheRead: pricing.cache_read_input_token_cost * 1e6,
      cacheWrite: 0
    },
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedText + cachedImages,
      totalTokens: inputTokens + outputTokens
    },
    costs: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheCreate: 0,
      cacheWrite: 0,
      ephemeral5m: 0,
      ephemeral1h: 0,
      total: inputCost + outputCost + cacheReadCost
    },
    imageTokenDetails: {
      textTokens,
      imageTokens,
      cachedText,
      cachedImages,
      textOutput,
      imageOutput
    },
    debug: { pricingSource: 'openai-official', usedFallbackPricing: false }
  }
}

module.exports = { calculateImageCost }
