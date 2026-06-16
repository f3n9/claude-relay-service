const express = require('express')
const request = require('supertest')

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  getConfig: jest.fn(),
  updateConfig: jest.fn(),
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  createAccount: jest.fn(),
  updateAccount: jest.fn(),
  deleteAccount: jest.fn(),
  resetAccountStatus: jest.fn(),
  resetUsage: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  unbindAccountFromAllKeys: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn(),
  getAccountGroups: jest.fn(),
  setAccountGroups: jest.fn(),
  removeAccountFromAllGroups: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getAccountUsageStats: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../config/config', () => ({}), { virtual: true })

const axios = require('axios')
const bridgeAccountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const accountGroupService = require('../src/services/accountGroupService')
const redis = require('../src/models/redis')
const ProxyHelper = require('../src/utils/proxyHelper')
const bridgeAdminRouter = require('../src/routes/admin/claudeOpenAIBridgeAccounts')

describe('Claude OpenAI bridge admin routes', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', bridgeAdminRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ProxyHelper.createProxyAgent.mockReturnValue(null)
    accountGroupService.getAccountGroups.mockResolvedValue([])
    accountGroupService.getGroup.mockResolvedValue({ id: 'group-1', platform: 'claude' })
    accountGroupService.getGroupMembers.mockResolvedValue([])
    accountGroupService.setAccountGroups.mockResolvedValue()
    accountGroupService.removeAccountFromAllGroups.mockResolvedValue()
    apiKeyService.unbindAccountFromAllKeys.mockResolvedValue(0)
    redis.getAccountUsageStats.mockResolvedValue({
      daily: { requests: 0, tokens: 0, allTokens: 0 },
      total: { requests: 0, tokens: 0, allTokens: 0 },
      averages: { rpm: 0, tpm: 0 }
    })
  })

  it('reads and updates bridge config through the account service', async () => {
    const app = buildApp()

    bridgeAccountService.getConfig.mockResolvedValue({ enabled: false })
    bridgeAccountService.updateConfig.mockResolvedValue({ enabled: true })

    const getResponse = await request(app).get('/admin/claude-openai-bridge/config')
    const putResponse = await request(app)
      .put('/admin/claude-openai-bridge/config')
      .send({ enabled: true })

    expect(getResponse.status).toBe(200)
    expect(getResponse.body).toEqual({ success: true, data: { enabled: false } })
    expect(putResponse.status).toBe(200)
    expect(putResponse.body).toEqual({ success: true, data: { enabled: true } })
    expect(bridgeAccountService.updateConfig).toHaveBeenCalledWith({ enabled: true })
  })

  it('delegates account CRUD and admin reset operations to the account service', async () => {
    const app = buildApp()

    bridgeAccountService.getAllAccounts.mockResolvedValue([{ id: 'bridge-1' }])
    bridgeAccountService.createAccount.mockResolvedValue({ id: 'bridge-2', name: 'new bridge' })
    bridgeAccountService.updateAccount.mockResolvedValue({ success: true })
    bridgeAccountService.deleteAccount.mockResolvedValue({ success: true })
    bridgeAccountService.resetAccountStatus.mockResolvedValue({ success: true })
    bridgeAccountService.resetUsage.mockResolvedValue({ success: true })
    bridgeAccountService.getAccount.mockResolvedValue({ id: 'bridge-1', accountType: 'shared' })

    const listResponse = await request(app).get('/admin/claude-openai-bridge/accounts')
    const createResponse = await request(app)
      .post('/admin/claude-openai-bridge/accounts')
      .send({ name: 'new bridge', endpointUrl: 'https://bridge.example.com/v1', apiKey: 'secret' })
    const updateResponse = await request(app)
      .put('/admin/claude-openai-bridge/accounts/bridge-1')
      .send({ name: 'renamed' })
    const deleteResponse = await request(app).delete(
      '/admin/claude-openai-bridge/accounts/bridge-1'
    )
    const resetStatusResponse = await request(app).post(
      '/admin/claude-openai-bridge/accounts/bridge-1/reset-status'
    )
    const resetUsageResponse = await request(app).post(
      '/admin/claude-openai-bridge/accounts/bridge-1/reset-usage'
    )

    expect(listResponse.body).toEqual({
      success: true,
      data: [
        {
          id: 'bridge-1',
          groupInfos: [],
          usage: {
            daily: { requests: 0, tokens: 0, allTokens: 0 },
            total: { requests: 0, tokens: 0, allTokens: 0 },
            averages: { rpm: 0, tpm: 0 }
          }
        }
      ]
    })
    expect(createResponse.body).toEqual({
      success: true,
      data: { id: 'bridge-2', name: 'new bridge' }
    })
    expect(updateResponse.body).toEqual({ success: true, data: { success: true } })
    expect(deleteResponse.body).toEqual({ success: true, data: { success: true } })
    expect(resetStatusResponse.body).toEqual({ success: true, data: { success: true } })
    expect(resetUsageResponse.body).toEqual({ success: true, data: { success: true } })
    expect(bridgeAccountService.getAllAccounts).toHaveBeenCalledWith(true)
    expect(bridgeAccountService.createAccount).toHaveBeenCalledWith({
      name: 'new bridge',
      endpointUrl: 'https://bridge.example.com/v1',
      apiKey: 'secret'
    })
    expect(bridgeAccountService.updateAccount).toHaveBeenCalledWith('bridge-1', {
      name: 'renamed'
    })
    expect(bridgeAccountService.deleteAccount).toHaveBeenCalledWith('bridge-1')
    expect(apiKeyService.unbindAccountFromAllKeys).toHaveBeenCalledWith(
      'bridge-1',
      'claude-openai-bridge'
    )
    expect(bridgeAccountService.resetAccountStatus).toHaveBeenCalledWith('bridge-1')
    expect(bridgeAccountService.resetUsage).toHaveBeenCalledWith('bridge-1')
  })

  it('returns usage stats for bridge account list rows', async () => {
    const app = buildApp()

    bridgeAccountService.getAllAccounts.mockResolvedValue([{ id: 'bridge-1', name: 'Bridge 1' }])
    redis.getAccountUsageStats.mockResolvedValue({
      daily: { requests: 3, allTokens: 1200, cost: 0.25 },
      total: { requests: 8, allTokens: 3000 },
      averages: { rpm: 0.5, tpm: 10 }
    })

    const response = await request(app).get('/admin/claude-openai-bridge/accounts')

    expect(response.status).toBe(200)
    expect(redis.getAccountUsageStats).toHaveBeenCalledWith('bridge-1', 'claude-openai-bridge')
    expect(response.body.data[0]).toMatchObject({
      id: 'bridge-1',
      usage: {
        daily: { requests: 3, allTokens: 1200, cost: 0.25 },
        total: { requests: 8, allTokens: 3000 },
        averages: { rpm: 0.5, tpm: 10 }
      }
    })
  })

  it('persists group membership when creating and updating group bridge accounts', async () => {
    const app = buildApp()

    bridgeAccountService.createAccount.mockResolvedValue({ id: 'bridge-2', name: 'group bridge' })
    bridgeAccountService.getAccount.mockResolvedValue({ id: 'bridge-2', accountType: 'shared' })
    bridgeAccountService.updateAccount.mockResolvedValue({ success: true })

    await request(app)
      .post('/admin/claude-openai-bridge/accounts')
      .send({
        name: 'group bridge',
        endpointUrl: 'https://bridge.example.com/v1',
        apiKey: 'secret',
        accountType: 'group',
        groupIds: ['group-1', 'group-2']
      })
    await request(app)
      .put('/admin/claude-openai-bridge/accounts/bridge-2')
      .send({
        accountType: 'group',
        groupIds: ['group-3']
      })

    expect(accountGroupService.setAccountGroups).toHaveBeenNthCalledWith(
      1,
      'bridge-2',
      ['group-1', 'group-2'],
      'claude'
    )
    expect(accountGroupService.setAccountGroups).toHaveBeenNthCalledWith(
      2,
      'bridge-2',
      ['group-3'],
      'claude'
    )
  })

  it('toggles active and schedulable flags from the current account state', async () => {
    const app = buildApp()

    bridgeAccountService.getAccount
      .mockResolvedValueOnce({ id: 'bridge-1', isActive: true })
      .mockResolvedValueOnce({ id: 'bridge-1', schedulable: false })
    bridgeAccountService.updateAccount.mockResolvedValue({ success: true })

    const toggleResponse = await request(app).put(
      '/admin/claude-openai-bridge/accounts/bridge-1/toggle'
    )
    const schedulableResponse = await request(app).put(
      '/admin/claude-openai-bridge/accounts/bridge-1/toggle-schedulable'
    )

    expect(toggleResponse.body).toEqual({
      success: true,
      data: { id: 'bridge-1', isActive: false }
    })
    expect(schedulableResponse.body).toEqual({
      success: true,
      schedulable: true,
      data: { id: 'bridge-1', schedulable: true }
    })
    expect(bridgeAccountService.updateAccount).toHaveBeenNthCalledWith(1, 'bridge-1', {
      isActive: false
    })
    expect(bridgeAccountService.updateAccount).toHaveBeenNthCalledWith(2, 'bridge-1', {
      schedulable: true
    })
  })

  it('tests an account using requested target model, endpoint credentials, and proxy agent', async () => {
    const app = buildApp()
    const proxy = { type: 'http', host: '127.0.0.1', port: 8118 }
    const agent = { proxyAgent: true }

    bridgeAccountService.getAccount.mockResolvedValue({
      id: 'bridge-1',
      name: 'Bridge 1',
      endpointUrl: 'https://bridge.example.com/v1/chat/completions',
      apiKey: 'bridge-secret',
      proxy,
      modelMappings: [
        { sourceModel: 'claude-sonnet-4', targetModel: 'gpt-4.1-mini', enabled: true }
      ]
    })
    ProxyHelper.createProxyAgent.mockReturnValue(agent)
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: 'pong' } }]
      }
    })

    const response = await request(app)
      .post('/admin/claude-openai-bridge/accounts/bridge-1/test')
      .send({ targetModel: 'gpt-4.1' })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      success: true,
      data: {
        accountId: 'bridge-1',
        accountName: 'Bridge 1',
        model: 'gpt-4.1',
        responseText: 'pong'
      }
    })
    expect(ProxyHelper.createProxyAgent).toHaveBeenCalledWith(proxy)
    expect(axios.post).toHaveBeenCalledWith(
      'https://bridge.example.com/v1/chat/completions',
      {
        model: 'gpt-4.1',
        stream: false,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Say "Hello" in one word.' }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer bridge-secret'
        },
        timeout: 30000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false
      }
    )
  })

  it('tests an account against chat completions when the endpoint is an OpenAI-compatible v1 base URL', async () => {
    const app = buildApp()

    bridgeAccountService.getAccount.mockResolvedValue({
      id: 'bridge-1',
      name: 'Bridge 1',
      endpointUrl: 'https://bc-openai-1.services.ai.azure.com/openai/v1',
      apiKey: 'bridge-secret',
      modelMappings: [
        { sourceModel: 'claude-sonnet-4', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ]
    })
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: 'pong' } }]
      }
    })

    const response = await request(app).post('/admin/claude-openai-bridge/accounts/bridge-1/test')

    expect(response.status).toBe(200)
    expect(axios.post.mock.calls[0][0]).toBe(
      'https://bc-openai-1.services.ai.azure.com/openai/v1/chat/completions'
    )
  })

  it('tests an account with the first enabled mapping target model by default', async () => {
    const app = buildApp()

    bridgeAccountService.getAccount.mockResolvedValue({
      id: 'bridge-1',
      endpointUrl: 'https://bridge.example.com/v1/chat/completions',
      apiKey: 'bridge-secret',
      modelMappings: [
        { sourceModel: 'disabled', targetModel: 'gpt-disabled', enabled: false },
        { sourceModel: 'enabled', targetModel: 'gpt-enabled', enabled: true }
      ]
    })
    axios.post.mockResolvedValue({ data: { choices: [] } })

    const response = await request(app).post('/admin/claude-openai-bridge/accounts/bridge-1/test')

    expect(response.status).toBe(200)
    expect(axios.post.mock.calls[0][1].model).toBe('gpt-enabled')
  })

  it('returns a consistent error response when account service throws', async () => {
    const app = buildApp()

    bridgeAccountService.createAccount.mockRejectedValue(
      new Error('Endpoint URL and API Key are required')
    )

    const response = await request(app).post('/admin/claude-openai-bridge/accounts').send({})

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      success: false,
      message: 'Endpoint URL and API Key are required'
    })
  })
})
