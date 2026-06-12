const CHAT_COMPLETIONS_PATH = '/chat/completions'

function buildChatCompletionsUrl(endpointUrl) {
  const rawUrl = String(endpointUrl || '').trim()
  if (!rawUrl) {
    return rawUrl
  }

  try {
    const url = new URL(rawUrl)
    url.pathname = appendChatCompletionsPath(url.pathname)
    return url.toString()
  } catch {
    return appendChatCompletionsPath(rawUrl)
  }
}

function appendChatCompletionsPath(pathOrUrl) {
  const trimmed = String(pathOrUrl || '').trim()
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')

  if (withoutTrailingSlash.endsWith(CHAT_COMPLETIONS_PATH)) {
    return withoutTrailingSlash
  }

  return `${withoutTrailingSlash}${CHAT_COMPLETIONS_PATH}`
}

module.exports = {
  buildChatCompletionsUrl
}
