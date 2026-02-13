jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  createAccount: jest.fn(),
  deleteAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  resetAccountStatus: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  setAccountGroups: jest.fn(),
  addAccountToGroup: jest.fn(),
  getAccountGroups: jest.fn(),
  getGroupMembers: jest.fn(),
  removeAccountFromAllGroups: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  unbindAccountFromAllKeys: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getAccountUsageStats: jest.fn()
}))

jest.mock('../src/services/relay/gcpVertexRelayService', () => ({
  relayRequest: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const router = require('../src/routes/admin/gcpVertexAccounts')

describe('GCP Vertex Accounts Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const getCreateHandler = () => {
    const routeLayer = router.stack.find(
      (layer) => layer.route && layer.route.path === '/' && layer.route.methods.post
    )

    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  const getUpdateHandler = () => {
    const routeLayer = router.stack.find(
      (layer) => layer.route && layer.route.path === '/:accountId' && layer.route.methods.put
    )

    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  const createMockResponse = () => {
    const res = {}
    res.status = jest.fn().mockReturnValue(res)
    res.json = jest.fn().mockReturnValue(res)
    return res
  }

  it('rolls back created account when group binding fails on create', async () => {
    const createHandler = getCreateHandler()
    const req = {
      body: {
        name: 'Vertex Group Account',
        serviceAccountJson: {
          project_id: 'project-1',
          private_key: 'test-key',
          client_email: 'test@example.com'
        },
        accountType: 'group',
        groupIds: ['group-1']
      }
    }
    const res = createMockResponse()

    gcpVertexAccountService.createAccount.mockResolvedValue({
      success: true,
      data: {
        id: 'vertex-account-1',
        name: 'Vertex Group Account',
        accountType: 'group'
      }
    })
    accountGroupService.setAccountGroups.mockRejectedValue(new Error('invalid group id'))
    gcpVertexAccountService.deleteAccount.mockResolvedValue({ success: true })

    await createHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Failed to bind GCP Vertex account to groups',
      message: 'invalid group id'
    })
    expect(accountGroupService.setAccountGroups).toHaveBeenCalledWith(
      'vertex-account-1',
      ['group-1'],
      'claude'
    )
    expect(accountGroupService.removeAccountFromAllGroups).toHaveBeenCalledWith(
      'vertex-account-1',
      'claude'
    )
    expect(gcpVertexAccountService.deleteAccount).toHaveBeenCalledWith('vertex-account-1')
    expect(
      accountGroupService.removeAccountFromAllGroups.mock.invocationCallOrder[0]
    ).toBeLessThan(gcpVertexAccountService.deleteAccount.mock.invocationCallOrder[0])
  })

  it('rolls back to previous groups when group update fails mid-way', async () => {
    const updateHandler = getUpdateHandler()
    const req = {
      params: { accountId: 'vertex-account-2' },
      body: {
        accountType: 'group',
        groupIds: ['group-new-1', 'group-new-2']
      }
    }
    const res = createMockResponse()

    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-account-2',
      accountType: 'group'
    })
    accountGroupService.getAccountGroups.mockResolvedValue([{ id: 'group-old-1' }, { id: 'group-old-2' }])
    accountGroupService.setAccountGroups
      .mockRejectedValueOnce(new Error('invalid group in update'))
      .mockResolvedValueOnce(undefined)

    await updateHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Failed to update GCP Vertex account groups',
      message: 'invalid group in update'
    })
    expect(accountGroupService.setAccountGroups).toHaveBeenNthCalledWith(
      1,
      'vertex-account-2',
      ['group-new-1', 'group-new-2'],
      'claude'
    )
    expect(accountGroupService.setAccountGroups).toHaveBeenNthCalledWith(
      2,
      'vertex-account-2',
      ['group-old-1', 'group-old-2'],
      'claude'
    )
    expect(gcpVertexAccountService.updateAccount).not.toHaveBeenCalled()
  })
})
