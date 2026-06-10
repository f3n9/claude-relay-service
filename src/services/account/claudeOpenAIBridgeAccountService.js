const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { createEncryptor, sortAccountsByPriority } = require('../../utils/commonHelper')

const encryptor = createEncryptor('claude-openai-bridge-salt')

const ACCOUNT_KEY_PREFIX = 'claude_openai_bridge_account:'
const ACCOUNT_INDEX_KEY = 'claude_openai_bridge_account:index'
const CONFIG_KEY = 'claude_openai_bridge:config'
const PLATFORM = 'claude-openai-bridge'

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return Boolean(value)
}

function normalizeNumber(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : defaultValue
}

function normalizeMappings(modelMappings = []) {
  let mappings = modelMappings

  if (typeof mappings === 'string') {
    try {
      mappings = JSON.parse(mappings)
    } catch {
      mappings = []
    }
  }

  if (!Array.isArray(mappings)) {
    return []
  }

  return mappings
    .map((mapping) => ({
      sourceModel: String(mapping?.sourceModel || '').trim(),
      targetModel: String(mapping?.targetModel || '').trim(),
      enabled: normalizeBoolean(mapping?.enabled, true)
    }))
    .filter((mapping) => mapping.sourceModel && mapping.targetModel)
}

function serializeProxy(proxy) {
  if (!proxy) {
    return ''
  }
  if (typeof proxy === 'string') {
    return proxy
  }
  return JSON.stringify(proxy)
}

function parseProxy(proxy) {
  if (!proxy) {
    return null
  }
  if (typeof proxy === 'object') {
    return proxy
  }
  try {
    return JSON.parse(proxy)
  } catch {
    return null
  }
}

function accountKey(accountId) {
  return `${ACCOUNT_KEY_PREFIX}${accountId}`
}

function isAccountEligible(account) {
  return (
    normalizeBoolean(account.isActive, true) &&
    normalizeBoolean(account.schedulable, true) &&
    (account.status || 'active') === 'active'
  )
}

function maskAndFormatAccount(accountData, { includeSecret = false } = {}) {
  const modelMappings = normalizeMappings(accountData.modelMappings)
  return {
    ...accountData,
    platform: PLATFORM,
    apiKey: includeSecret
      ? encryptor.decrypt(accountData.apiKey || '')
      : accountData.apiKey
        ? '***'
        : '',
    proxy: parseProxy(accountData.proxy),
    modelMappings,
    mappingCount: modelMappings.filter((mapping) => mapping.enabled).length,
    isActive: normalizeBoolean(accountData.isActive, true),
    schedulable: normalizeBoolean(accountData.schedulable, true),
    disableAutoProtection: normalizeBoolean(accountData.disableAutoProtection, false),
    priority: normalizeNumber(accountData.priority, 50),
    rateLimitDuration: normalizeNumber(accountData.rateLimitDuration, 60),
    dailyQuota: normalizeNumber(accountData.dailyQuota, 0),
    dailyUsage: normalizeNumber(accountData.dailyUsage, 0)
  }
}

async function getConfig() {
  const client = redis.getClientSafe()
  const rawConfig = await client.get(CONFIG_KEY)

  if (!rawConfig) {
    return { enabled: false }
  }

  try {
    const parsed = JSON.parse(rawConfig)
    return { enabled: normalizeBoolean(parsed.enabled, false) }
  } catch {
    return { enabled: false }
  }
}

async function updateConfig(updates = {}) {
  const config = {
    enabled: normalizeBoolean(updates.enabled, false)
  }

  const client = redis.getClientSafe()
  await client.set(CONFIG_KEY, JSON.stringify(config))
  logger.info('Updated Claude OpenAI bridge config', config)
  return config
}

async function createAccount(options = {}) {
  const endpointUrl = String(options.endpointUrl || '').trim()
  const apiKey = String(options.apiKey || '')

  if (!endpointUrl || !apiKey) {
    throw new Error('Endpoint URL and API Key are required')
  }

  const now = new Date().toISOString()
  const accountId = uuidv4()
  const accountData = {
    id: accountId,
    platform: PLATFORM,
    name: options.name || 'Claude OpenAI Bridge Account',
    description: options.description || '',
    endpointUrl,
    apiKey: encryptor.encrypt(apiKey),
    proxy: serializeProxy(options.proxy),
    isActive: normalizeBoolean(options.isActive, true).toString(),
    schedulable: normalizeBoolean(options.schedulable, true).toString(),
    status: options.status || 'active',
    errorMessage: options.errorMessage || '',
    priority: String(normalizeNumber(options.priority, 50)),
    rateLimitDuration: String(normalizeNumber(options.rateLimitDuration, 60)),
    rateLimitedAt: '',
    rateLimitResetAt: '',
    dailyQuota: String(normalizeNumber(options.dailyQuota, 0)),
    dailyUsage: String(normalizeNumber(options.dailyUsage, 0)),
    lastResetDate: redis.getDateStringInTimezone(),
    quotaResetTime: options.quotaResetTime || '00:00',
    quotaStoppedAt: '',
    disableAutoProtection: normalizeBoolean(options.disableAutoProtection, false).toString(),
    modelMappings: JSON.stringify(normalizeMappings(options.modelMappings)),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: options.lastUsedAt || ''
  }

  const client = redis.getClientSafe()
  await client.hset(accountKey(accountId), accountData)
  await redis.addToIndex(ACCOUNT_INDEX_KEY, accountId)

  logger.success(`Created Claude OpenAI bridge account: ${accountData.name} (${accountId})`)

  return maskAndFormatAccount(accountData)
}

async function getAccount(accountId) {
  const client = redis.getClientSafe()
  const accountData = await client.hgetall(accountKey(accountId))

  if (!accountData || !accountData.id) {
    return null
  }

  return maskAndFormatAccount(accountData, { includeSecret: true })
}

async function getAllAccounts(includeInactive = false) {
  const client = redis.getClientSafe()
  const accountIds = await redis.getAllIdsByIndex(
    ACCOUNT_INDEX_KEY,
    `${ACCOUNT_KEY_PREFIX}*`,
    /^claude_openai_bridge_account:(.+)$/
  )
  const accounts = []

  for (const accountId of accountIds) {
    const accountData = await client.hgetall(accountKey(accountId))
    if (!accountData || !accountData.id) {
      continue
    }

    const account = maskAndFormatAccount(accountData)
    if (!includeInactive && !account.isActive) {
      continue
    }

    accounts.push(account)
  }

  return accounts
}

async function updateAccount(accountId, updates = {}) {
  const existing = await getAccount(accountId)
  if (!existing) {
    throw new Error('Account not found')
  }

  const normalizedUpdates = { ...updates, updatedAt: new Date().toISOString() }

  if (normalizedUpdates.apiKey) {
    normalizedUpdates.apiKey = encryptor.encrypt(String(normalizedUpdates.apiKey))
  } else if (normalizedUpdates.apiKey === '') {
    delete normalizedUpdates.apiKey
  }

  if (normalizedUpdates.endpointUrl !== undefined) {
    normalizedUpdates.endpointUrl = String(normalizedUpdates.endpointUrl).trim()
  }

  if (normalizedUpdates.proxy !== undefined) {
    normalizedUpdates.proxy = serializeProxy(normalizedUpdates.proxy)
  }

  if (normalizedUpdates.modelMappings !== undefined) {
    normalizedUpdates.modelMappings = JSON.stringify(
      normalizeMappings(normalizedUpdates.modelMappings)
    )
  }

  for (const field of ['isActive', 'schedulable', 'disableAutoProtection']) {
    if (normalizedUpdates[field] !== undefined) {
      normalizedUpdates[field] = normalizeBoolean(normalizedUpdates[field], false).toString()
    }
  }

  const numberDefaults = {
    priority: 50,
    rateLimitDuration: 60,
    dailyQuota: 0,
    dailyUsage: 0
  }
  for (const [field, defaultValue] of Object.entries(numberDefaults)) {
    if (normalizedUpdates[field] !== undefined) {
      normalizedUpdates[field] = String(normalizeNumber(normalizedUpdates[field], defaultValue))
    }
  }

  const client = redis.getClientSafe()
  await client.hset(accountKey(accountId), normalizedUpdates)

  logger.info(`Updated Claude OpenAI bridge account: ${existing.name || accountId}`)

  return { success: true }
}

async function deleteAccount(accountId) {
  const client = redis.getClientSafe()
  await client.del(accountKey(accountId))
  await redis.removeFromIndex(ACCOUNT_INDEX_KEY, accountId)

  logger.info(`Deleted Claude OpenAI bridge account: ${accountId}`)

  return { success: true }
}

async function selectAccountForModel(sourceModel) {
  const config = await getConfig()
  if (!config.enabled) {
    return null
  }

  const accounts = await getAllAccounts(true)
  const eligibleAccounts = accounts
    .filter(isAccountEligible)
    .map((account) => {
      const mapping = account.modelMappings.find(
        (candidate) => candidate.enabled && candidate.sourceModel === sourceModel
      )
      return mapping ? { ...account, matchedMapping: mapping } : null
    })
    .filter(Boolean)

  if (eligibleAccounts.length === 0) {
    return null
  }

  const [selected] = sortAccountsByPriority(eligibleAccounts)
  const account = await getAccount(selected.id)

  if (!account) {
    return null
  }

  return {
    account,
    mapping: selected.matchedMapping
  }
}

async function markAccountUsed(accountId) {
  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() })
  return { success: true }
}

async function markAccountRateLimited(accountId, durationMinutes = null) {
  const account = await getAccount(accountId)
  if (!account) {
    return { success: false }
  }

  if (account.disableAutoProtection) {
    logger.info(
      `Claude OpenAI bridge account ${accountId} has auto-protection disabled, skipping rate-limit mark`
    )
    return { success: true, skipped: true }
  }

  const duration = normalizeNumber(durationMinutes, account.rateLimitDuration || 60)
  const now = new Date()
  const resetAt = new Date(now.getTime() + duration * 60000)

  await updateAccount(accountId, {
    status: 'rateLimited',
    schedulable: false,
    rateLimitedAt: now.toISOString(),
    rateLimitResetAt: resetAt.toISOString(),
    errorMessage: `Rate limited until ${resetAt.toISOString()}`
  })

  logger.warn(
    `Claude OpenAI bridge account ${account.name || accountId} marked rate limited until ${resetAt.toISOString()}`
  )

  return {
    success: true,
    rateLimitedAt: now.toISOString(),
    rateLimitResetAt: resetAt.toISOString()
  }
}

async function markAccountUnauthorized(accountId, message = 'Unauthorized') {
  const account = await getAccount(accountId)
  if (!account) {
    return { success: false }
  }

  await updateAccount(accountId, {
    status: 'unauthorized',
    schedulable: false,
    errorMessage: message
  })

  logger.warn(`Claude OpenAI bridge account ${account.name || accountId} marked unauthorized`)

  return { success: true }
}

async function markAccountError(accountId, message = 'Upstream error') {
  const account = await getAccount(accountId)
  if (!account) {
    return { success: false }
  }

  await updateAccount(accountId, {
    status: 'error',
    schedulable: false,
    errorMessage: message
  })

  logger.warn(`Claude OpenAI bridge account ${account.name || accountId} marked error`)

  return { success: true }
}

async function resetAccountStatus(accountId) {
  await updateAccount(accountId, {
    status: 'active',
    schedulable: true,
    errorMessage: '',
    rateLimitedAt: '',
    rateLimitResetAt: ''
  })

  return { success: true }
}

async function resetUsage(accountId) {
  await updateAccount(accountId, {
    dailyUsage: 0,
    lastResetDate: redis.getDateStringInTimezone(),
    quotaStoppedAt: ''
  })

  return { success: true }
}

module.exports = {
  getConfig,
  updateConfig,
  createAccount,
  getAccount,
  getAllAccounts,
  updateAccount,
  deleteAccount,
  selectAccountForModel,
  markAccountUsed,
  markAccountRateLimited,
  markAccountUnauthorized,
  markAccountError,
  resetAccountStatus,
  resetUsage,
  _normalizeMappings: normalizeMappings
}
