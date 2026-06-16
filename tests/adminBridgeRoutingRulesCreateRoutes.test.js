jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  createAccount: jest.fn()
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  createAccount: jest.fn()
}))
jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  createAccount: jest.fn()
}))
jest.mock('../src/services/account/bedrockAccountService', () => ({
  createAccount: jest.fn()
}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  createAccount: jest.fn()
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/gcpVertexRelayService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({
  addAccountToGroup: jest.fn(),
  setAccountGroups: jest.fn(),
  removeAccountFromAllGroups: jest.fn()
}))
jest.mock('../src/services/accountTestSchedulerService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/oauthHelper', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')

const bridgeRoutingRules = [
  {
    sourceModel: 'deepseek-v4-flash',
    bridgeAccountId: 'bridge-1',
    targetModel: 'DeepSeek-V4-Flash',
    enabled: true
  }
]

function getHandler(router, path, method = 'post') {
  const routeLayer = router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method]
  )
  return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
}

function createMockResponse() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe('admin source account bridge routing rules create routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeAccountService.createAccount.mockResolvedValue({ id: 'claude-1', name: 'Claude' })
    claudeConsoleAccountService.createAccount.mockResolvedValue({
      id: 'console-1',
      name: 'Console'
    })
    gcpVertexAccountService.createAccount.mockResolvedValue({
      success: true,
      data: { id: 'vertex-1', name: 'Vertex' }
    })
    bedrockAccountService.createAccount.mockResolvedValue({
      success: true,
      data: { id: 'bedrock-1', name: 'Bedrock' }
    })
    ccrAccountService.createAccount.mockResolvedValue({ id: 'ccr-1', name: 'CCR' })
  })

  it('passes bridge routing rules when creating Claude official accounts', async () => {
    const router = require('../src/routes/admin/claudeAccounts')
    const handler = getHandler(router, '/claude-accounts')
    const res = createMockResponse()

    await handler(
      {
        body: {
          name: 'Claude',
          bridgeRoutingRules
        }
      },
      res
    )

    expect(claudeAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRoutingRules })
    )
  })

  it('passes bridge routing rules when creating Claude Console accounts', async () => {
    const router = require('../src/routes/admin/claudeConsoleAccounts')
    const handler = getHandler(router, '/claude-console-accounts')
    const res = createMockResponse()

    await handler(
      {
        body: {
          name: 'Console',
          apiUrl: 'https://console.example.com',
          apiKey: 'secret',
          bridgeRoutingRules
        }
      },
      res
    )

    expect(claudeConsoleAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRoutingRules })
    )
  })

  it('passes bridge routing rules when creating GCP Vertex accounts', async () => {
    const router = require('../src/routes/admin/gcpVertexAccounts')
    const handler = getHandler(router, '/')
    const res = createMockResponse()

    await handler(
      {
        body: {
          name: 'Vertex',
          serviceAccountJson: {
            project_id: 'project-1',
            private_key: 'private-key',
            client_email: 'svc@example.com'
          },
          bridgeRoutingRules
        }
      },
      res
    )

    expect(gcpVertexAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRoutingRules })
    )
  })

  it('passes bridge routing rules when creating Bedrock accounts', async () => {
    const router = require('../src/routes/admin/bedrockAccounts')
    const handler = getHandler(router, '/')
    const res = createMockResponse()

    await handler(
      {
        body: {
          name: 'Bedrock',
          awsCredentials: {
            accessKeyId: 'ak',
            secretAccessKey: 'sk'
          },
          bridgeRoutingRules
        }
      },
      res
    )

    expect(bedrockAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRoutingRules })
    )
  })

  it('passes bridge routing rules when creating CCR accounts', async () => {
    const router = require('../src/routes/admin/ccrAccounts')
    const handler = getHandler(router, '/')
    const res = createMockResponse()

    await handler(
      {
        body: {
          name: 'CCR',
          apiUrl: 'https://ccr.example.com',
          apiKey: 'secret',
          bridgeRoutingRules
        }
      },
      res
    )

    expect(ccrAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRoutingRules })
    )
  })
})
