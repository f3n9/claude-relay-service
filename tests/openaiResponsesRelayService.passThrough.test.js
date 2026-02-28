const { EventEmitter } = require('events')

jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/headerFilter', () => ({
  cdnHeaders: [],
  filterForOpenAI: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(),
  sanitizeErrorForClient: jest.fn((data) => data)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../config/config', () => ({
  requestTimeout: 60000
}))

const axios = require('axios')
const { filterForOpenAI } = require('../src/utils/headerFilter')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')

function createReq(overrides = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    path: '/responses',
    headers: {
      'user-agent': 'client-ua/1.0',
      'x-codex-beta-features': 'custom_tool_input',
      'x-api-key': 'relay-api-key',
      'content-type': 'application/json'
    },
    body: {
      model: 'gpt-4.1',
      stream: false
    }
  })

  Object.assign(req, overrides)
  return req
}

function createRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.status = jest.fn().mockImplementation(() => res)
  res.json = jest.fn().mockImplementation(() => res)
  res.setHeader = jest.fn()
  res.end = jest.fn()
  return res
}

function getHeader(headers, name) {
  if (Object.prototype.hasOwnProperty.call(headers || {}, name)) {
    return headers[name]
  }
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lowerName) {
      return value
    }
  }
  return undefined
}

describe('openaiResponsesRelayService passThrough behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    openaiResponsesAccountService.updateAccount.mockResolvedValue({ success: true })
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue({ success: true })
    openaiResponsesAccountService.updateUsageQuota.mockResolvedValue({ success: true })

    axios.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        ok: true
      }
    })
  })

  it('preserves incoming headers when passThrough is enabled', async () => {
    expect(typeof openaiResponsesRelayService._isPassThroughEnabled).toBe('function')

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      baseApi: 'https://example.com/v1',
      apiVersion: '2026-01-01-preview',
      apiKey: 'upstream-api-key',
      userAgent: 'account-ua/9.9',
      passThrough: 'true',
      dailyQuota: '0'
    })

    filterForOpenAI.mockReturnValue({ filtered: 'legacy' })

    const req = createReq()
    const res = createRes()

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Responses Account', passThrough: 'true' },
      { id: 'key-1' }
    )

    expect(axios).toHaveBeenCalledTimes(1)
    const options = axios.mock.calls[0][0]

    expect(options.url).toBe('https://example.com/v1/responses?api-version=2026-01-01-preview')
    expect(filterForOpenAI).not.toHaveBeenCalled()
    expect(getHeader(options.headers, 'x-codex-beta-features')).toBe('custom_tool_input')
    expect(getHeader(options.headers, 'user-agent')).toBe('client-ua/1.0')
    expect(getHeader(options.headers, 'authorization')).toBe('Bearer upstream-api-key')
    expect(getHeader(options.headers, 'x-api-key')).toBeUndefined()
  })

  it('keeps legacy filtered-header behavior when passThrough is disabled', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      baseApi: 'https://example.com/v1',
      apiKey: 'upstream-api-key',
      userAgent: 'account-ua/9.9',
      passThrough: 'false',
      dailyQuota: '0'
    })

    filterForOpenAI.mockReturnValue({
      'user-agent': 'filtered-client',
      'x-openai-meta': 'keep-me'
    })

    const req = createReq()
    const res = createRes()

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Responses Account', passThrough: 'false' },
      { id: 'key-1' }
    )

    expect(filterForOpenAI).toHaveBeenCalledWith(req.headers)
    const options = axios.mock.calls[0][0]
    expect(options.url).toBe('https://example.com/v1/responses?api-version=2025-04-01-preview')
    expect(getHeader(options.headers, 'x-openai-meta')).toBe('keep-me')
    expect(getHeader(options.headers, 'User-Agent')).toBe('account-ua/9.9')
    expect(getHeader(options.headers, 'authorization')).toBe('Bearer upstream-api-key')
  })
})
