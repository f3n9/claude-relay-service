const redisClient = require('../models/redis')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const config = require('../../config/config')
const logger = require('../utils/logger')

// 加密相关常量
const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16

// 🚀 安全的加密密钥生成，支持动态salt
const ENCRYPTION_SALT = config.security.azureOpenaiSalt || 'azure-openai-account-default-salt'

class EncryptionKeyManager {
  constructor() {
    this.keyCache = new Map()
    this.keyRotationInterval = 24 * 60 * 60 * 1000 // 24小时
  }

  getKey(version = 'current') {
    const cached = this.keyCache.get(version)
    if (cached && Date.now() - cached.timestamp < this.keyRotationInterval) {
      return cached.key
    }

    // 生成新密钥
    const key = crypto.scryptSync(config.security.encryptionKey, ENCRYPTION_SALT, 32)
    this.keyCache.set(version, {
      key,
      timestamp: Date.now()
    })

    logger.debug('🔑 Azure OpenAI encryption key generated/refreshed')
    return key
  }

  // 清理过期密钥
  cleanup() {
    const now = Date.now()
    for (const [version, cached] of this.keyCache.entries()) {
      if (now - cached.timestamp > this.keyRotationInterval) {
        this.keyCache.delete(version)
      }
    }
  }
}

const encryptionKeyManager = new EncryptionKeyManager()

// 定期清理过期密钥
setInterval(
  () => {
    encryptionKeyManager.cleanup()
  },
  60 * 60 * 1000
) // 每小时清理一次

// 生成加密密钥 - 使用安全的密钥管理器
function generateEncryptionKey() {
  return encryptionKeyManager.getKey()
}

// Azure OpenAI 账户键前缀
const AZURE_OPENAI_ACCOUNT_KEY_PREFIX = 'azure_openai:account:'
const SHARED_AZURE_OPENAI_ACCOUNTS_KEY = 'shared_azure_openai_accounts'
const ACCOUNT_SESSION_MAPPING_PREFIX = 'azure_openai_session_account_mapping:'

// 加密函数
function encrypt(text) {
  if (!text) {
    return ''
  }
  const key = generateEncryptionKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text)
  encrypted = Buffer.concat([encrypted, cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

// 解密函数 - 移除缓存以提高安全性
function decrypt(text) {
  if (!text) {
    return ''
  }

  try {
    const key = generateEncryptionKey()
    // IV 是固定长度的 32 个十六进制字符（16 字节）
    const ivHex = text.substring(0, 32)
    const encryptedHex = text.substring(33) // 跳过冒号

    if (ivHex.length !== 32 || !encryptedHex) {
      throw new Error('Invalid encrypted text format')
    }

    const iv = Buffer.from(ivHex, 'hex')
    const encryptedText = Buffer.from(encryptedHex, 'hex')
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    let decrypted = decipher.update(encryptedText)
    decrypted = Buffer.concat([decrypted, decipher.final()])
    const result = decrypted.toString()

    return result
  } catch (error) {
    logger.error('Azure OpenAI decryption error:', error.message)
    return ''
  }
}

// 创建账户
async function createAccount(accountData) {
  const accountId = uuidv4()
  const now = new Date().toISOString()

  const account = {
    id: accountId,
    name: accountData.name,
    description: accountData.description || '',
    accountType: accountData.accountType || 'shared',
    groupId: accountData.groupId || null,
    priority: accountData.priority || 50,
    // Azure OpenAI 特有字段
    azureEndpoint: accountData.azureEndpoint || '',
    apiVersion: accountData.apiVersion || '2024-02-01', // 使用稳定版本
    deploymentName: accountData.deploymentName || '',
    resourceName: accountData.resourceName || '',
    apiKey: encrypt(accountData.apiKey || ''),
    // 支持的模型
    supportedModels: JSON.stringify(accountData.supportedModels || ['gpt-4', 'codex-mini']),
    // 状态字段
    isActive: accountData.isActive !== false ? 'true' : 'false',
    status: 'active',
    schedulable: accountData.schedulable !== false ? 'true' : 'false',
    createdAt: now,
    updatedAt: now
  }

  // 代理配置
  if (accountData.proxy) {
    account.proxy =
      typeof accountData.proxy === 'string' ? accountData.proxy : JSON.stringify(accountData.proxy)
  }

  const client = redisClient.getClientSafe()
  await client.hset(`${AZURE_OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`, account)

  // 如果是共享账户，添加到共享账户集合
  if (account.accountType === 'shared') {
    await client.sadd(SHARED_AZURE_OPENAI_ACCOUNTS_KEY, accountId)
  }

  logger.info(`Created Azure OpenAI account: ${accountId}`)
  return account
}

// 获取账户
async function getAccount(accountId) {
  const client = redisClient.getClientSafe()
  const accountData = await client.hgetall(`${AZURE_OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`)

  if (!accountData || Object.keys(accountData).length === 0) {
    return null
  }

  // 解密敏感数据（仅用于内部处理，不返回给前端）
  if (accountData.apiKey) {
    accountData.apiKey = decrypt(accountData.apiKey)
  }

  // 解析代理配置
  if (accountData.proxy && typeof accountData.proxy === 'string') {
    try {
      accountData.proxy = JSON.parse(accountData.proxy)
    } catch (e) {
      accountData.proxy = null
    }
  }

  // 解析支持的模型
  if (accountData.supportedModels && typeof accountData.supportedModels === 'string') {
    try {
      accountData.supportedModels = JSON.parse(accountData.supportedModels)
    } catch (e) {
      accountData.supportedModels = ['gpt-4', 'codex-mini']
    }
  }

  return accountData
}

// 更新账户
async function updateAccount(accountId, updates) {
  const existingAccount = await getAccount(accountId)
  if (!existingAccount) {
    throw new Error('Account not found')
  }

  updates.updatedAt = new Date().toISOString()

  // 加密敏感数据
  if (updates.apiKey) {
    updates.apiKey = encrypt(updates.apiKey)
  }

  // 处理代理配置
  if (updates.proxy) {
    updates.proxy =
      typeof updates.proxy === 'string' ? updates.proxy : JSON.stringify(updates.proxy)
  }

  // 处理支持的模型
  if (updates.supportedModels) {
    updates.supportedModels =
      typeof updates.supportedModels === 'string'
        ? updates.supportedModels
        : JSON.stringify(updates.supportedModels)
  }

  // 更新账户类型时处理共享账户集合
  const client = redisClient.getClientSafe()
  if (updates.accountType && updates.accountType !== existingAccount.accountType) {
    if (updates.accountType === 'shared') {
      await client.sadd(SHARED_AZURE_OPENAI_ACCOUNTS_KEY, accountId)
    } else {
      await client.srem(SHARED_AZURE_OPENAI_ACCOUNTS_KEY, accountId)
    }
  }

  await client.hset(`${AZURE_OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`, updates)

  logger.info(`Updated Azure OpenAI account: ${accountId}`)

  // 合并更新后的账户数据
  const updatedAccount = { ...existingAccount, ...updates }

  // 返回时解析代理配置
  if (updatedAccount.proxy && typeof updatedAccount.proxy === 'string') {
    try {
      updatedAccount.proxy = JSON.parse(updatedAccount.proxy)
    } catch (e) {
      updatedAccount.proxy = null
    }
  }

  return updatedAccount
}

// 删除账户
async function deleteAccount(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  // 从 Redis 删除
  const client = redisClient.getClientSafe()
  await client.del(`${AZURE_OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`)

  // 从共享账户集合中移除
  if (account.accountType === 'shared') {
    await client.srem(SHARED_AZURE_OPENAI_ACCOUNTS_KEY, accountId)
  }

  // 清理会话映射 - 优化Redis操作
  const sessionMappingPattern = `${ACCOUNT_SESSION_MAPPING_PREFIX}*`
  const sessionMappings = await client.keys(sessionMappingPattern)

  // 批量检查会话映射
  if (sessionMappings.length > 0) {
    const pipeline = client.pipeline()
    const keysToDelete = []

    for (const key of sessionMappings) {
      const mappedAccountId = await client.get(key)
      if (mappedAccountId === accountId) {
        keysToDelete.push(key)
      }
    }

    // 批量删除
    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        pipeline.del(key)
      }
      await pipeline.exec()
      logger.info(`Cleaned up ${keysToDelete.length} session mappings for account ${accountId}`)
    }
  }

  logger.info(`Deleted Azure OpenAI account: ${accountId}`)
  return true
}

// 获取所有账户 - 优化批量操作
async function getAllAccounts() {
  const client = redisClient.getClientSafe()
  const keys = await client.keys(`${AZURE_OPENAI_ACCOUNT_KEY_PREFIX}*`)
  const accounts = []

  // 批量获取账户数据
  const pipeline = client.pipeline()
  for (const key of keys) {
    pipeline.hgetall(key)
  }
  const results = await pipeline.exec()

  for (let i = 0; i < results.length; i++) {
    const [err, accountData] = results[i]
    if (err || !accountData || Object.keys(accountData).length === 0) {
      continue
    }

    // 屏蔽敏感信息（apiKey不应该返回给前端）
    delete accountData.apiKey

    // 获取限流状态信息
    const rateLimitInfo = await getAccountRateLimitInfo(accountData.id)

    // 解析代理配置
    if (accountData.proxy) {
      try {
        accountData.proxy = JSON.parse(accountData.proxy)
        // 屏蔽代理密码
        if (accountData.proxy && accountData.proxy.password) {
          accountData.proxy.password = '******'
        }
      } catch (e) {
        // 如果解析失败，设置为null
        accountData.proxy = null
      }
    }

    // 解析支持的模型
    if (accountData.supportedModels && typeof accountData.supportedModels === 'string') {
      try {
        accountData.supportedModels = JSON.parse(accountData.supportedModels)
      } catch (e) {
        accountData.supportedModels = ['gpt-4', 'codex-mini']
      }
    }

    accounts.push({
      ...accountData,
      // 标识为 Azure OpenAI 账户
      platform: 'azure_openai',
      // 添加限流状态信息（统一格式）
      rateLimitStatus: rateLimitInfo
        ? {
            isRateLimited: rateLimitInfo.isRateLimited,
            rateLimitedAt: rateLimitInfo.rateLimitedAt,
            minutesRemaining: rateLimitInfo.minutesRemaining
          }
        : {
            isRateLimited: false,
            rateLimitedAt: null,
            minutesRemaining: 0
          }
    })
  }

  return accounts
}

// 选择可用账户（支持专属和共享账户）
async function selectAvailableAccount(apiKeyId, sessionHash = null, requestedModel = null) {
  // 首先检查是否有粘性会话
  const client = redisClient.getClientSafe()
  if (sessionHash) {
    const mappedAccountId = await client.get(`${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (mappedAccountId) {
      const account = await getAccount(mappedAccountId)
      if (account && account.isActive === 'true') {
        logger.debug(`Using sticky session account: ${mappedAccountId}`)
        return account
      }
    }
  }

  // 获取 API Key 信息
  const apiKeyData = await client.hgetall(`api_key:${apiKeyId}`)

  // 检查是否绑定了 Azure OpenAI 账户
  if (apiKeyData.azureOpenaiAccountId) {
    const account = await getAccount(apiKeyData.azureOpenaiAccountId)
    if (account && account.isActive === 'true') {
      // 检查模型支持
      if (
        requestedModel &&
        account.supportedModels &&
        !account.supportedModels.includes(requestedModel)
      ) {
        throw new Error(`Account ${account.name} does not support model ${requestedModel}`)
      }

      // 创建粘性会话映射
      if (sessionHash) {
        await client.setex(
          `${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`,
          3600, // 1小时过期
          account.id
        )
      }

      return account
    }
  }

  // 从共享账户池选择
  const sharedAccountIds = await client.smembers(SHARED_AZURE_OPENAI_ACCOUNTS_KEY)
  const availableAccounts = []

  for (const accountId of sharedAccountIds) {
    const account = await getAccount(accountId)
    if (account && account.isActive === 'true' && !isRateLimited(account)) {
      // 检查模型支持
      if (
        requestedModel &&
        account.supportedModels &&
        !account.supportedModels.includes(requestedModel)
      ) {
        continue
      }
      availableAccounts.push(account)
    }
  }

  if (availableAccounts.length === 0) {
    throw new Error('No available Azure OpenAI accounts')
  }

  // 选择使用最少的账户
  const selectedAccount = availableAccounts.reduce((prev, curr) => {
    const prevUsage = parseInt(prev.totalUsage || 0)
    const currUsage = parseInt(curr.totalUsage || 0)
    return prevUsage <= currUsage ? prev : curr
  })

  // 创建粘性会话映射
  if (sessionHash) {
    await client.setex(
      `${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`,
      3600, // 1小时过期
      selectedAccount.id
    )
  }

  return selectedAccount
}

// 检查账户是否被限流
function isRateLimited(account) {
  if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
    const limitedAt = new Date(account.rateLimitedAt).getTime()
    const now = Date.now()
    const limitDuration = 60 * 60 * 1000 // 1小时

    return now < limitedAt + limitDuration
  }
  return false
}

// 设置账户限流状态
async function setAccountRateLimited(accountId, isLimited) {
  const updates = {
    rateLimitStatus: isLimited ? 'limited' : 'normal',
    rateLimitedAt: isLimited ? new Date().toISOString() : null
  }

  await updateAccount(accountId, updates)
  logger.info(
    `Set rate limit status for Azure OpenAI account ${accountId}: ${updates.rateLimitStatus}`
  )
}

// 切换账户调度状态
async function toggleSchedulable(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  // 切换调度状态
  const newSchedulable = account.schedulable === 'false' ? 'true' : 'false'

  await updateAccount(accountId, {
    schedulable: newSchedulable
  })

  logger.info(`Toggled schedulable status for Azure OpenAI account ${accountId}: ${newSchedulable}`)

  return {
    success: true,
    schedulable: newSchedulable === 'true'
  }
}

// 获取账户限流信息
async function getAccountRateLimitInfo(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    return null
  }

  if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
    const limitedAt = new Date(account.rateLimitedAt).getTime()
    const now = Date.now()
    const limitDuration = 60 * 60 * 1000 // 1小时
    const remainingTime = Math.max(0, limitedAt + limitDuration - now)

    return {
      isRateLimited: remainingTime > 0,
      rateLimitedAt: account.rateLimitedAt,
      minutesRemaining: Math.ceil(remainingTime / (60 * 1000))
    }
  }

  return {
    isRateLimited: false,
    rateLimitedAt: null,
    minutesRemaining: 0
  }
}

// 更新账户使用统计
async function updateAccountUsage(accountId, tokens = 0) {
  const account = await getAccount(accountId)
  if (!account) {
    return
  }

  const updates = {
    lastUsedAt: new Date().toISOString()
  }

  // 如果有 tokens 参数且大于0，同时更新使用统计
  if (tokens > 0) {
    const totalUsage = parseInt(account.totalUsage || 0) + tokens
    updates.totalUsage = totalUsage.toString()
  }

  await updateAccount(accountId, updates)
}

// 健康检查 Azure OpenAI 部署
async function healthCheckAccount(accountId) {
  try {
    const account = await getAccount(accountId)
    if (!account) {
      return { healthy: false, error: 'Account not found' }
    }

    const axios = require('axios')
    const response = await axios.get(
      `${account.azureEndpoint}/openai/deployments/${account.deploymentName}?api-version=${account.apiVersion}`,
      {
        headers: { 'api-key': account.apiKey },
        timeout: 10000
      }
    )

    if (response.status === 200) {
      // 更新健康状态
      await updateAccount(accountId, {
        status: 'active',
        lastHealthCheck: new Date().toISOString()
      })
      return { healthy: true, deployment: response.data }
    } else {
      await updateAccount(accountId, { status: 'unhealthy' })
      return { healthy: false, error: `HTTP ${response.status}` }
    }
  } catch (error) {
    logger.error(`Health check failed for Azure OpenAI account ${accountId}:`, error.message)
    await updateAccount(accountId, { status: 'unhealthy' })
    return { healthy: false, error: error.message }
  }
}

// 批量健康检查所有活跃账户
async function performHealthChecks() {
  const accounts = await getAllAccounts()
  const activeAccounts = accounts.filter((account) => account.isActive === 'true')

  const healthResults = []
  for (const account of activeAccounts) {
    const result = await healthCheckAccount(account.id)
    healthResults.push({
      accountId: account.id,
      accountName: account.name,
      ...result
    })
  }

  logger.info(`Health check completed for ${activeAccounts.length} Azure OpenAI accounts`)
  return healthResults
}

// API Key 数据迁移 - 添加 azureOpenaiAccountId 支持
async function migrateApiKeysForAzureSupport() {
  const client = redisClient.getClientSafe()
  const keys = await client.keys('api_key:*')
  let migratedCount = 0

  for (const key of keys) {
    try {
      const keyData = await client.hgetall(key)
      if (!keyData.azureOpenaiAccountId) {
        await client.hset(key, 'azureOpenaiAccountId', '')
        migratedCount++
      }
    } catch (error) {
      logger.error(`Failed to migrate API key ${key}:`, error)
    }
  }

  logger.info(`Migrated ${migratedCount} API keys to support Azure OpenAI`)
  return migratedCount
}

// 为了兼容性，保留recordUsage作为updateAccountUsage的别名
const recordUsage = updateAccountUsage

module.exports = {
  createAccount,
  getAccount,
  updateAccount,
  deleteAccount,
  getAllAccounts,
  selectAvailableAccount,
  setAccountRateLimited,
  toggleSchedulable,
  getAccountRateLimitInfo,
  updateAccountUsage,
  recordUsage, // 别名，指向updateAccountUsage
  encrypt,
  decrypt,
  generateEncryptionKey,
  healthCheckAccount,
  performHealthChecks,
  migrateApiKeysForAzureSupport
}
