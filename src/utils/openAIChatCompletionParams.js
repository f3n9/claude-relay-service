function usesMaxCompletionTokens(targetModel) {
  const match = String(targetModel || '').match(/(?:^|[^a-z0-9])gpt-(\d+)(?=$|[._-])/i)
  return match ? Number(match[1]) >= 5 : false
}

function applyTokenLimitForModel(body, source = {}, targetModel) {
  if (usesMaxCompletionTokens(targetModel)) {
    const value =
      source.max_completion_tokens !== undefined
        ? source.max_completion_tokens
        : source.max_tokens

    if (value !== undefined) {
      body.max_completion_tokens = value
    }
    delete body.max_tokens
    return body
  }

  if (source.max_tokens !== undefined) {
    body.max_tokens = source.max_tokens
  }
  if (source.max_completion_tokens !== undefined) {
    body.max_completion_tokens = source.max_completion_tokens
  }
  return body
}

module.exports = {
  usesMaxCompletionTokens,
  applyTokenLimitForModel
}
