const express = require('express')
const axios = require('axios')
const { authenticateAdmin } = require('../../middleware/auth')
const bridgeAccountService = require('../../services/account/claudeOpenAIBridgeAccountService')
const apiKeyService = require('../../services/apiKeyService')
const accountGroupService = require('../../services/accountGroupService')
const redis = require('../../models/redis')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { buildChatCompletionsUrl } = require('../../utils/claudeOpenAIBridgeEndpoint')

const router = express.Router()

function sendSuccess(res, data) {
  return res.json({ success: true, data })
}

function sendError(res, error, fallbackStatus = 500) {
  const message = error?.message || 'Unknown error'
  const status = message.includes('not found') ? 404 : fallbackStatus
  logger.error('Claude OpenAI bridge admin route error:', error)
  return res.status(status).json({ success: false, message })
}

function isFalse(value) {
  return value === false || value === 'false'
}

function getDefaultTargetModel(account) {
  const mapping = (account.modelMappings || []).find((item) => item.enabled !== false)
  return mapping?.targetModel || ''
}

function emptyUsageStats() {
  return {
    daily: { tokens: 0, requests: 0, allTokens: 0 },
    total: { tokens: 0, requests: 0, allTokens: 0 },
    averages: { rpm: 0, tpm: 0 }
  }
}

async function getBridgeAccountUsageStats(accountId) {
  try {
    const usageStats = await redis.getAccountUsageStats(accountId, 'claude-openai-bridge')
    return {
      daily: usageStats?.daily || emptyUsageStats().daily,
      total: usageStats?.total || emptyUsageStats().total,
      averages: usageStats?.averages || emptyUsageStats().averages
    }
  } catch (error) {
    logger.warn(`Failed to get Claude OpenAI bridge usage stats for ${accountId}:`, error.message)
    return emptyUsageStats()
  }
}

router.get('/claude-openai-bridge/config', authenticateAdmin, async (req, res) => {
  try {
    return sendSuccess(res, await bridgeAccountService.getConfig())
  } catch (error) {
    return sendError(res, error)
  }
})

router.put('/claude-openai-bridge/config', authenticateAdmin, async (req, res) => {
  try {
    return sendSuccess(res, await bridgeAccountService.updateConfig(req.body || {}))
  } catch (error) {
    return sendError(res, error, 400)
  }
})

router.get('/claude-openai-bridge/accounts', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.query
    let accounts = await bridgeAccountService.getAllAccounts(true)

    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        const ungroupedAccounts = []
        for (const account of accounts) {
          const groups = await accountGroupService.getAccountGroups(account.id)
          if (!groups || groups.length === 0) {
            ungroupedAccounts.push(account)
          }
        }
        accounts = ungroupedAccounts
      } else {
        const group = await accountGroupService.getGroup(groupId)
        if (group && group.platform === 'claude') {
          const groupMembers = await accountGroupService.getGroupMembers(groupId)
          accounts = accounts.filter((account) => groupMembers.includes(account.id))
        } else {
          accounts = []
        }
      }
    }

    const accountsWithGroups = await Promise.all(
      accounts.map(async (account) => {
        const [groupInfos, usage] = await Promise.all([
          accountGroupService.getAccountGroups(account.id),
          getBridgeAccountUsageStats(account.id)
        ])

        return {
          ...account,
          groupInfos,
          usage
        }
      })
    )

    return sendSuccess(res, accountsWithGroups)
  } catch (error) {
    return sendError(res, error)
  }
})

router.post('/claude-openai-bridge/accounts', authenticateAdmin, async (req, res) => {
  try {
    const accountData = req.body || {}
    if (
      accountData.accountType === 'group' &&
      !accountData.groupId &&
      (!accountData.groupIds || accountData.groupIds.length === 0)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Group ID is required for group type accounts'
      })
    }

    const account = await bridgeAccountService.createAccount(accountData)
    if (accountData.accountType === 'group') {
      const groupIds =
        Array.isArray(accountData.groupIds) && accountData.groupIds.length > 0
          ? accountData.groupIds
          : [accountData.groupId].filter(Boolean)
      if (groupIds.length > 0) {
        await accountGroupService.setAccountGroups(account.id, groupIds, 'claude')
      }
    }

    return sendSuccess(res, account)
  } catch (error) {
    return sendError(res, error, 400)
  }
})

router.put('/claude-openai-bridge/accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const updates = req.body || {}
    const currentAccount = await bridgeAccountService.getAccount(req.params.id)
    if (!currentAccount) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }

    if (updates.accountType !== undefined) {
      if (currentAccount.accountType === 'group') {
        await accountGroupService.removeAccountFromAllGroups(req.params.id, 'claude')
      }

      if (updates.accountType === 'group') {
        const groupIds =
          Array.isArray(updates.groupIds) && updates.groupIds.length > 0
            ? updates.groupIds
            : [updates.groupId].filter(Boolean)

        if (groupIds.length > 0) {
          await accountGroupService.setAccountGroups(req.params.id, groupIds, 'claude')
        } else {
          await accountGroupService.removeAccountFromAllGroups(req.params.id, 'claude')
        }
      }
    }

    return sendSuccess(res, await bridgeAccountService.updateAccount(req.params.id, updates))
  } catch (error) {
    return sendError(res, error, 400)
  }
})

router.delete('/claude-openai-bridge/accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await bridgeAccountService.deleteAccount(req.params.id)
    await accountGroupService.removeAccountFromAllGroups(req.params.id, 'claude')
    await apiKeyService.unbindAccountFromAllKeys(req.params.id, 'claude-openai-bridge')
    return sendSuccess(res, result)
  } catch (error) {
    return sendError(res, error)
  }
})

router.put('/claude-openai-bridge/accounts/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const account = await bridgeAccountService.getAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }

    const isActive = !(account.isActive === true || account.isActive === 'true')
    await bridgeAccountService.updateAccount(req.params.id, { isActive })
    return sendSuccess(res, { id: req.params.id, isActive })
  } catch (error) {
    return sendError(res, error, 400)
  }
})

router.put(
  '/claude-openai-bridge/accounts/:id/toggle-schedulable',
  authenticateAdmin,
  async (req, res) => {
    try {
      const account = await bridgeAccountService.getAccount(req.params.id)
      if (!account) {
        return res.status(404).json({ success: false, message: 'Account not found' })
      }

      const schedulable = isFalse(account.schedulable)
      await bridgeAccountService.updateAccount(req.params.id, { schedulable })
      return res.json({ success: true, schedulable, data: { id: req.params.id, schedulable } })
    } catch (error) {
      return sendError(res, error, 400)
    }
  }
)

router.post(
  '/claude-openai-bridge/accounts/:id/reset-status',
  authenticateAdmin,
  async (req, res) => {
    try {
      return sendSuccess(res, await bridgeAccountService.resetAccountStatus(req.params.id))
    } catch (error) {
      return sendError(res, error, 400)
    }
  }
)

router.post(
  '/claude-openai-bridge/accounts/:id/reset-usage',
  authenticateAdmin,
  async (req, res) => {
    try {
      return sendSuccess(res, await bridgeAccountService.resetUsage(req.params.id))
    } catch (error) {
      return sendError(res, error, 400)
    }
  }
)

router.post('/claude-openai-bridge/accounts/:id/test', authenticateAdmin, async (req, res) => {
  try {
    const account = await bridgeAccountService.getAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }

    const model = req.body?.targetModel || getDefaultTargetModel(account)
    if (!model) {
      return res.status(400).json({ success: false, message: 'No enabled target model configured' })
    }

    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    const startedAt = Date.now()
    const axiosOptions = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.apiKey}`
      },
      timeout: 30000
    }

    if (proxyAgent) {
      axiosOptions.httpAgent = proxyAgent
      axiosOptions.httpsAgent = proxyAgent
      axiosOptions.proxy = false
    }

    const response = await axios.post(
      buildChatCompletionsUrl(account.endpointUrl),
      {
        model,
        stream: false,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Say "Hello" in one word.' }]
      },
      axiosOptions
    )

    return sendSuccess(res, {
      accountId: account.id,
      accountName: account.name,
      model,
      latency: Date.now() - startedAt,
      responseText: response.data?.choices?.[0]?.message?.content || '',
      response: response.data
    })
  } catch (error) {
    return sendError(res, error, 400)
  }
})

module.exports = router
