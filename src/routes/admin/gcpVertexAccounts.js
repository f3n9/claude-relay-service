/**
 * Admin Routes - GCP Vertex Claude Accounts Management
 */

const express = require('express')
const router = express.Router()
const gcpVertexAccountService = require('../../services/account/gcpVertexAccountService')
const apiKeyService = require('../../services/apiKeyService')
const accountGroupService = require('../../services/accountGroupService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const { formatAccountExpiry, mapExpiryField } = require('./utils')
const { createClaudeTestPayload } = require('../../utils/testPayloadHelper')
const gcpVertexRelayService = require('../../services/relay/gcpVertexRelayService')

// ☁️ GCP Vertex 账户管理

// 获取所有 GCP Vertex 账户
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    const result = await gcpVertexAccountService.getAllAccounts()
    if (!result.success) {
      return res
        .status(500)
        .json({ error: 'Failed to get GCP Vertex accounts', message: result.error })
    }

    let accounts = result.data

    if (platform && platform !== 'all' && platform !== 'claude-vertex') {
      accounts = []
    }

    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        const filteredAccounts = []
        for (const account of accounts) {
          const groups = await accountGroupService.getAccountGroups(account.id)
          if (!groups || groups.length === 0) {
            filteredAccounts.push(account)
          }
        }
        accounts = filteredAccounts
      } else {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      }
    }

    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id, 'claude-vertex')
          const groupInfos = await accountGroupService.getAccountGroups(account.id)
          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            groupInfos,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages
            }
          }
        } catch (statsError) {
          logger.warn(
            `⚠️ Failed to get usage stats for GCP Vertex account ${account.id}:`,
            statsError.message
          )
          const groupInfos = await accountGroupService.getAccountGroups(account.id)
          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            groupInfos,
            usage: {
              daily: { tokens: 0, requests: 0, allTokens: 0 },
              total: { tokens: 0, requests: 0, allTokens: 0 },
              averages: { rpm: 0, tpm: 0 }
            }
          }
        }
      })
    )

    return res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('❌ Failed to get GCP Vertex accounts:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get GCP Vertex accounts', message: error.message })
  }
})

// 创建新的 GCP Vertex 账户
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const mappedBody = mapExpiryField(req.body || {}, 'GCP Vertex', 'create')
    const {
      name,
      description,
      serviceAccountJson,
      projectId,
      location,
      defaultModel,
      anthropicVersion,
      priority,
      accountType,
      groupId,
      groupIds,
      rateLimitDuration,
      subscriptionExpiresAt,
      proxy
    } = mappedBody

    const normalizedAccountType = accountType || 'shared'
    const normalizedGroupIds = Array.isArray(groupIds)
      ? groupIds.filter((id) => typeof id === 'string' && id.trim())
      : []

    if (!name) {
      return res.status(400).json({ error: 'Name is required' })
    }

    if (priority !== undefined && (priority < 1 || priority > 100)) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    if (!['shared', 'dedicated', 'group'].includes(normalizedAccountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    if (
      normalizedAccountType === 'group' &&
      normalizedGroupIds.length === 0 &&
      (!groupId || typeof groupId !== 'string' || !groupId.trim())
    ) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    const result = await gcpVertexAccountService.createAccount({
      name,
      description: description || '',
      serviceAccountJson,
      projectId,
      location,
      defaultModel,
      anthropicVersion,
      priority: priority || 50,
      accountType: normalizedAccountType,
      rateLimitDuration: rateLimitDuration ?? 60,
      subscriptionExpiresAt,
      proxy
    })

    if (!result.success) {
      return res
        .status(500)
        .json({ error: 'Failed to create GCP Vertex account', message: result.error })
    }

    if (normalizedAccountType === 'group') {
      try {
        if (normalizedGroupIds.length > 0) {
          await accountGroupService.setAccountGroups(result.data.id, normalizedGroupIds, 'claude')
        } else if (typeof groupId === 'string' && groupId.trim()) {
          await accountGroupService.addAccountToGroup(result.data.id, groupId.trim(), 'claude')
        }
      } catch (groupError) {
        logger.error(`❌ Failed to bind GCP Vertex account ${result.data.id} to groups:`, groupError)
        return res
          .status(500)
          .json({ error: 'Failed to bind GCP Vertex account to groups', message: groupError.message })
      }
    }

    logger.success(`☁️ Admin created GCP Vertex account: ${name}`)
    const formattedAccount = formatAccountExpiry(result.data)
    return res.json({ success: true, data: formattedAccount })
  } catch (error) {
    logger.error('❌ Failed to create GCP Vertex account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to create GCP Vertex account', message: error.message })
  }
})

// 更新 GCP Vertex 账户
router.put('/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const updates = req.body

    const mappedUpdates = mapExpiryField(updates, 'GCP Vertex', accountId)
    const { accountType: rawAccountType, groupId, groupIds } = mappedUpdates

    if (
      mappedUpdates.priority !== undefined &&
      (mappedUpdates.priority < 1 || mappedUpdates.priority > 100)
    ) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    if (rawAccountType && !['shared', 'dedicated', 'group'].includes(rawAccountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    if (
      rawAccountType === 'group' &&
      (!groupId || typeof groupId !== 'string' || !groupId.trim()) &&
      (!Array.isArray(groupIds) || groupIds.length === 0)
    ) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    const currentAccount = await gcpVertexAccountService.getAccount(accountId)
    if (!currentAccount) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const normalizedGroupIds = Array.isArray(groupIds)
      ? groupIds.filter((gid) => typeof gid === 'string' && gid.trim())
      : []
    const hasGroupIdsField = Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')
    const hasGroupIdField = Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupId')
    const targetAccountType = rawAccountType || currentAccount.accountType || 'shared'

    delete mappedUpdates.groupId
    delete mappedUpdates.groupIds

    if (rawAccountType) {
      mappedUpdates.accountType = targetAccountType
    }

    const result = await gcpVertexAccountService.updateAccount(accountId, mappedUpdates)

    if (!result.success) {
      return res
        .status(500)
        .json({ error: 'Failed to update GCP Vertex account', message: result.error })
    }

    try {
      if (currentAccount.accountType === 'group' && targetAccountType !== 'group') {
        await accountGroupService.removeAccountFromAllGroups(accountId)
      } else if (targetAccountType === 'group') {
        if (hasGroupIdsField) {
          if (normalizedGroupIds.length > 0) {
            await accountGroupService.setAccountGroups(accountId, normalizedGroupIds, 'claude')
          } else {
            await accountGroupService.removeAccountFromAllGroups(accountId)
          }
        } else if (hasGroupIdField && typeof groupId === 'string' && groupId.trim()) {
          await accountGroupService.setAccountGroups(accountId, [groupId.trim()], 'claude')
        }
      }
    } catch (groupError) {
      logger.error(`❌ Failed to update GCP Vertex account ${accountId} groups:`, groupError)
      return res
        .status(500)
        .json({ error: 'Failed to update GCP Vertex account groups', message: groupError.message })
    }

    const formattedAccount = formatAccountExpiry(result.data)
    return res.json({ success: true, data: formattedAccount })
  } catch (error) {
    logger.error('❌ Failed to update GCP Vertex account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update GCP Vertex account', message: error.message })
  }
})

// 删除 GCP Vertex 账户
router.delete('/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const account = await gcpVertexAccountService.getAccount(accountId)
    await apiKeyService.unbindAccountFromAllKeys(accountId, 'claude-vertex')
    if (account && account.accountType === 'group') {
      await accountGroupService.removeAccountFromAllGroups(accountId)
    }
    await gcpVertexAccountService.deleteAccount(accountId)
    return res.json({ success: true, message: 'Account deleted successfully' })
  } catch (error) {
    logger.error('❌ Failed to delete GCP Vertex account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to delete GCP Vertex account', message: error.message })
  }
})

// 切换账户启用状态
router.put('/:accountId/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const account = await gcpVertexAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const updateResult = await gcpVertexAccountService.updateAccount(accountId, {
      isActive: !account.isActive
    })
    if (!updateResult.success) {
      return res
        .status(500)
        .json({ error: 'Failed to toggle account status', message: updateResult.error })
    }
    logger.success(
      `🔄 Admin toggled GCP Vertex account status: ${accountId} -> ${!account.isActive}`
    )
    return res.json({ success: true, data: updateResult.data })
  } catch (error) {
    logger.error('❌ Failed to toggle GCP Vertex account status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle account status', message: error.message })
  }
})

// 切换调度状态
router.put('/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const account = await gcpVertexAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const updateResult = await gcpVertexAccountService.updateAccount(accountId, {
      schedulable: !account.schedulable
    })
    if (!updateResult.success) {
      return res
        .status(500)
        .json({ error: 'Failed to toggle schedulable status', message: updateResult.error })
    }
    logger.success(
      `🔄 Admin toggled GCP Vertex account schedulable status: ${accountId} -> ${!account.schedulable}`
    )
    return res.json({
      success: true,
      schedulable: !account.schedulable,
      data: updateResult.data
    })
  } catch (error) {
    logger.error('❌ Failed to toggle GCP Vertex account schedulable status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle schedulable status', message: error.message })
  }
})

// 测试账户连通性（非流式，前端非 SSE）
router.post('/:accountId/test', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const { model } = req.body || {}
    const account = await gcpVertexAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }

    const testPayload = createClaudeTestPayload(model || account.defaultModel)
    const fakeKey = { id: 'admin-test', name: 'admin-test' }
    const response = await gcpVertexRelayService.relayRequest(
      testPayload,
      fakeKey,
      null,
      null,
      {},
      accountId
    )

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return res.status(400).json({
        success: false,
        message: `Upstream error (${response.statusCode})`,
        data: response.body
      })
    }

    let responseText = 'Test passed'
    try {
      const parsed = JSON.parse(response.body)
      const textPart = Array.isArray(parsed?.content)
        ? parsed.content.find((part) => part.type === 'text')
        : null
      if (textPart?.text) {
        responseText = textPart.text
      }
    } catch {
      responseText = response.body
    }

    return res.json({ success: true, data: { responseText } })
  } catch (error) {
    logger.error('❌ Failed to test GCP Vertex account:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
})

// 重置账户状态
router.post('/:accountId/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const result = await gcpVertexAccountService.resetAccountStatus(accountId)

    if (!result.success) {
      return res.status(404).json({ success: false, message: result.error || 'Account not found' })
    }

    logger.success(`Admin reset status for GCP Vertex account: ${accountId}`)
    return res.json({ success: true, data: result.data })
  } catch (error) {
    logger.error('❌ Failed to reset GCP Vertex account status:', error)
    return res.status(500).json({ error: 'Failed to reset status', message: error.message })
  }
})

module.exports = router
