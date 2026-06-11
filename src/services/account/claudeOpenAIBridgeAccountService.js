const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { createEncryptor, sortAccountsByPriority } = require('../../utils/commonHelper')

const encryptor = createEncryptor('claude-openai-bridge-salt')

const ACCOUNT_KEY_PREFIX = 'claude_openai_bridge_account:'
const ACCOUNT_INDEX_KEY = 'claude_openai_bridge_account:index'
const CONFIG_KEY = 'claude_openai_bridge:config'
const PLATFORM = 'claude-openai-bridge'
const API_KEY_MASK_SENTINELS = new Set(['***'])
const MUTABLE_ACCOUNT_FIELDS = new Set([
  'name',
  'description',
  'endpointUrl',
  'apiKey',
  'accountType',
  'groupId',
  'groupIds',
  'expiresAt',
  'proxy',
  'isActive',
  'schedulable',
  'status',
  'errorMessage',
  'priority',
  'rateLimitDuration',
  'rateLimitedAt',
  'rateLimitResetAt',
  'dailyQuota',
  'dailyUsage',
  'lastResetDate',
  'quotaResetTime',
  'quotaStoppedAt',
  'disableAutoProtection',
  'modelMappings',
  'lastUsedAt'
])

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

function isApiKeyUpdate(value) {
  if (value === undefined || value === null) {
    return false
  }
  const normalized = String(value).trim()
  return normalized !== '' && !API_KEY_MASK_SENTINELS.has(normalized)
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

function normalizeGroupIds(groupIds = []) {
  if (typeof groupIds === 'string') {
    try {
      groupIds = JSON.parse(groupIds)
    } catch {
      groupIds = groupIds ? [groupIds] : []
    }
  }

  if (!Array.isArray(groupIds)) {
    return []
  }

  return groupIds.map((groupId) => String(groupId).trim()).filter(Boolean)
}

function parseGroupIds(groupIds) {
  if (!groupIds) {
    return []
  }
  if (Array.isArray(groupIds)) {
    return groupIds
  }
  try {
    const parsed = JSON.parse(groupIds)
    return normalizeGroupIds(parsed)
  } catch {
    return normalizeGroupIds(groupIds)
  }
}

function accountKey(accountId) {
  return `${ACCOUNT_KEY_PREFIX}${accountId}`
}

function isAccountEligible(account) {
  const dailyQuota = normalizeNumber(account.dailyQuota, 0)
  const dailyUsage = normalizeNumber(account.dailyUsage, 0)
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : null

  return (
    normalizeBoolean(account.isActive, true) &&
    normalizeBoolean(account.schedulable, true) &&
    (account.status || 'active') === 'active' &&
    !account.quotaStoppedAt &&
    (!expiresAt || !Number.isFinite(expiresAt) || expiresAt > Date.now()) &&
    (dailyQuota <= 0 || dailyUsage < dailyQuota)
  )
}

function isRateLimitExpired(account) {
  if ((account.status || 'active') !== 'rateLimited') {
    return false
  }

  const now = Date.now()
  if (account.rateLimitResetAt) {
    const resetAt = new Date(account.rateLimitResetAt).getTime()
    return Number.isFinite(resetAt) && now >= resetAt
  }

  if (account.rateLimitedAt) {
    const rateLimitedAt = new Date(account.rateLimitedAt).getTime()
    const duration = normalizeNumber(account.rateLimitDuration, 60)
    return Number.isFinite(rateLimitedAt) && duration > 0 && now - rateLimitedAt >= duration * 60000
  }

  return false
}

function isQuotaStopped(account) {
  return (account.status || 'active') === 'quotaExceeded' || Boolean(account.quotaStoppedAt)
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
    accountType: accountData.accountType || 'shared',
    groupId: accountData.groupId || '',
    groupIds: parseGroupIds(accountData.groupIds),
    expiresAt: accountData.expiresAt || null,
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
    accountType: options.accountType || 'shared',
    groupId: options.groupId || '',
    groupIds: JSON.stringify(normalizeGroupIds(options.groupIds)),
    expiresAt: options.expiresAt || '',
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

  const normalizedUpdates = Object.entries(updates).reduce((allowed, [field, value]) => {
    if (MUTABLE_ACCOUNT_FIELDS.has(field)) {
      allowed[field] = value
    }
    return allowed
  }, {})

  normalizedUpdates.updatedAt = new Date().toISOString()

  if (isApiKeyUpdate(normalizedUpdates.apiKey)) {
    normalizedUpdates.apiKey = encryptor.encrypt(String(normalizedUpdates.apiKey))
  } else {
    delete normalizedUpdates.apiKey
  }

  if (normalizedUpdates.endpointUrl !== undefined) {
    normalizedUpdates.endpointUrl = String(normalizedUpdates.endpointUrl).trim()
    if (!normalizedUpdates.endpointUrl) {
      throw new Error('Endpoint URL cannot be empty')
    }
  }

  if (normalizedUpdates.proxy !== undefined) {
    normalizedUpdates.proxy = serializeProxy(normalizedUpdates.proxy)
  }

  if (normalizedUpdates.accountType !== undefined) {
    normalizedUpdates.accountType = normalizedUpdates.accountType || 'shared'
  }

  if (normalizedUpdates.groupId !== undefined) {
    normalizedUpdates.groupId = normalizedUpdates.groupId || ''
  }

  if (normalizedUpdates.groupIds !== undefined) {
    normalizedUpdates.groupIds = JSON.stringify(normalizeGroupIds(normalizedUpdates.groupIds))
  }

  if (normalizedUpdates.expiresAt !== undefined) {
    normalizedUpdates.expiresAt = normalizedUpdates.expiresAt || ''
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

async function checkAndClearRateLimit(accountId) {
  const account = await getAccount(accountId)
  if (!account || !isRateLimitExpired(account)) {
    return false
  }

  await updateAccount(accountId, {
    status: 'active',
    schedulable: true,
    errorMessage: '',
    rateLimitedAt: '',
    rateLimitResetAt: ''
  })

  logger.info(`Rate limit cleared for Claude OpenAI bridge account: ${account.name || accountId}`)
  return true
}

function findEnabledMapping(account, sourceModel) {
  return (account.modelMappings || []).find(
    (candidate) => candidate.enabled && candidate.sourceModel === sourceModel
  )
}

async function selectAccountFromCandidates(sourceModel, candidates) {
  const eligibleAccounts = candidates
    .filter(Boolean)
    .filter(isAccountEligible)
    .map((account) => {
      const mapping = findEnabledMapping(account, sourceModel)
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

async function selectBoundAccountForModel(sourceModel, binding) {
  if (!binding || typeof binding !== 'string') {
    return null
  }

  if (binding.startsWith('group:')) {
    const groupId = binding.substring(6)
    const accountGroupService = require('../accountGroupService')
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    if (!memberIds || memberIds.length === 0) {
      return null
    }

    const accounts = await Promise.all(memberIds.map((accountId) => getAccount(accountId)))
    return selectAccountFromCandidates(sourceModel, accounts)
  }

  const account = await getAccount(binding)
  return selectAccountFromCandidates(sourceModel, [account])
}

async function selectAccountForModel(sourceModel, options = {}) {
  const config = await getConfig()
  if (!config.enabled) {
    return null
  }

  const boundSelection = await selectBoundAccountForModel(sourceModel, options.boundAccountId)
  if (boundSelection) {
    return boundSelection
  }

  const accounts = await getAllAccounts(true)
  const recoveredIds = []
  for (const account of accounts) {
    if (await checkAndClearRateLimit(account.id)) {
      recoveredIds.push(account.id)
    }
  }

  const accountsForSelection =
    recoveredIds.length === 0
      ? accounts
      : await Promise.all(accounts.map((account) => getAccount(account.id)))

  return selectAccountFromCandidates(
    sourceModel,
    accountsForSelection.filter((account) => (account.accountType || 'shared') === 'shared')
  )
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

  const duration = normalizeNumber(durationMinutes ?? account.rateLimitDuration, 60)
  if (duration <= 0) {
    logger.info(
      `Claude OpenAI bridge account ${accountId} has rate-limit duration 0, skipping rate-limit mark`
    )
    return { success: true, skipped: true }
  }

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
  const account = await getAccount(accountId)
  if (!account) {
    return { success: false }
  }

  const updates = {
    dailyUsage: 0,
    lastResetDate: redis.getDateStringInTimezone(),
    quotaStoppedAt: ''
  }

  if (isQuotaStopped(account)) {
    updates.status = 'active'
    updates.schedulable = true
    updates.errorMessage = ''
  }

  await updateAccount(accountId, updates)

  return { success: true }
}

async function resetDailyUsageWindow(accountId, account, amount, today) {
  const dailyUsage = normalizeNumber(amount, 0)
  const updates = {
    dailyUsage,
    lastResetDate: today,
    quotaStoppedAt: ''
  }

  if (isQuotaStopped(account)) {
    updates.status = 'active'
    updates.schedulable = true
    updates.errorMessage = ''
  }

  await updateAccount(accountId, updates)
  return dailyUsage
}

async function recordUsage(accountId, usageAmount = 0) {
  const account = await getAccount(accountId)
  if (!account) {
    return { success: false }
  }

  const today = redis.getDateStringInTimezone()
  const staleUsageWindow = account.lastResetDate !== today
  const usageIncrement = Math.max(0, normalizeNumber(usageAmount, 0))
  const client = redis.getClientSafe()
  const dailyUsage = staleUsageWindow
    ? await resetDailyUsageWindow(accountId, account, usageIncrement, today)
    : normalizeNumber(
        await client.hincrbyfloat(accountKey(accountId), 'dailyUsage', usageIncrement),
        0
      )
  const dailyQuota = normalizeNumber(account.dailyQuota, 0)
  const quotaExceeded = dailyQuota > 0 && dailyUsage >= dailyQuota
  const now = new Date().toISOString()
  const updates = {}

  if (quotaExceeded) {
    updates.quotaStoppedAt = staleUsageWindow ? now : account.quotaStoppedAt || now
    updates.status = 'quotaExceeded'
    updates.schedulable = false
    updates.errorMessage = 'Daily quota exceeded'
  } else if (isQuotaStopped(account)) {
    updates.quotaStoppedAt = ''
    updates.errorMessage = ''
    updates.status = 'active'
    updates.schedulable = true
  }

  if (staleUsageWindow) {
    updates.dailyUsage = dailyUsage
    updates.lastResetDate = today
  }

  if (Object.keys(updates).length > 0) {
    await updateAccount(accountId, updates)
  }

  return {
    success: true,
    dailyUsage,
    quotaExceeded
  }
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
  checkAndClearRateLimit,
  markAccountUsed,
  markAccountRateLimited,
  markAccountUnauthorized,
  markAccountError,
  resetAccountStatus,
  resetUsage,
  recordUsage,
  updateUsageQuota: recordUsage,
  _normalizeMappings: normalizeMappings
}
