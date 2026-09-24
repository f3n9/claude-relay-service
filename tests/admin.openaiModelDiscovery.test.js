const express = require('express')
const request = require('supertest')
jest.mock('../src/middleware/auth', () => ({ authenticateAdmin: (req, res, next) => next() }))
jest.mock('../src/services/account/openaiAccountService', () => ({
  createAccount: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  createAccount: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn()
}))
jest.mock('../src/services/accountGroupService', () => ({
  removeAccountFromAllGroups: jest.fn(),
  setAccountGroups: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn(), success: jest.fn() }))
const oauth = require('../src/services/account/openaiAccountService')
const api = require('../src/services/account/openaiResponsesAccountService')
const groups = require('../src/services/accountGroupService')
const app = express()
app.use(express.json())
app.use('/oauth', require('../src/routes/admin/openaiAccounts'))
app.use('/', require('../src/routes/admin/openaiResponsesAccounts'))
beforeEach(() => {
  jest.clearAllMocks()
  for (const service of [oauth, api]) {
    service.createAccount.mockImplementation(async (data) => ({ id: 'account-1', ...data }))
    service.getAccount.mockResolvedValue({ id: 'account-1' })
    service.updateAccount.mockResolvedValue({ success: true })
  }
})
describe.each([
  ['/oauth', oauth],
  ['/openai-responses-accounts', api]
])('%s discovery config', (path, service) => {
  test('create and edit forward normalized rules and allow clearing', async () => {
    expect(
      (
        await request(app)
          .post(path)
          .send({ name: 'test', modelDiscoveryPatterns: [' gpt-5 ', 'gpt-5', 'gpt-5.6-*'] })
      ).status
    ).toBe(200)
    expect(service.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ modelDiscoveryPatterns: ['gpt-5', 'gpt-5.6-*'] })
    )
    expect(
      (await request(app).put(`${path}/account-1`).send({ modelDiscoveryPatterns: [] })).status
    ).toBe(200)
    expect(service.updateAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ modelDiscoveryPatterns: [] })
    )
  })
  test('forwards the model-listing switch on create and edit', async () => {
    expect(
      (await request(app).post(path).send({ name: 'test', disableModelListing: true })).status
    ).toBe(200)
    expect(service.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ disableModelListing: true })
    )
    expect(
      (await request(app).put(`${path}/account-1`).send({ disableModelListing: false })).status
    ).toBe(200)
    expect(service.updateAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ disableModelListing: false })
    )
  })
  test.each(['post', 'put'])(
    '%s rejects invalid rules before account or group writes',
    async (method) => {
      const target = method === 'put' ? `${path}/account-1` : path
      const res = await request(app)
        [method](target)
        .send({
          name: 'test',
          accountType: 'group',
          groupIds: ['group-1'],
          modelDiscoveryPatterns: [42]
        })
      expect(res.status).toBe(400)
      expect(service.createAccount).not.toHaveBeenCalled()
      expect(service.updateAccount).not.toHaveBeenCalled()
      expect(groups.setAccountGroups).not.toHaveBeenCalled()
      expect(groups.removeAccountFromAllGroups).not.toHaveBeenCalled()
    }
  )
})
