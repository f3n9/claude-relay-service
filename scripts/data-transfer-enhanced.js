#!/usr/bin/env node

/**
 * 增强版数据导出/导入工具
 * 支持加密数据的处理
 */

const fs = require('fs').promises
const crypto = require('crypto')
const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')
const { distributedLock } = require('../src/utils/distributedLock')
const readline = require('readline')
const config = require('../config/config')

// 解析命令行参数
const args = process.argv.slice(2)
const command = args[0]
const params = {}

/**
 * 安全的命令行参数解析
 * 防止参数注入和恶意输入
 */
function parseCommandLineArgs() {
  args.slice(1).forEach((arg, index) => {
    // 输入验证：检查参数格式
    if (typeof arg !== 'string') {
      throw new Error(`Invalid argument at index ${index}: must be string`)
    }

    // 长度限制防止DoS攻击
    if (arg.length > 1000) {
      throw new Error(`Argument too long at index ${index}: ${arg.length} characters`)
    }

    // 解析键值对
    const [key, value] = arg.split('=')

    // 验证键名格式
    if (!key || !key.startsWith('--')) {
      throw new Error(`Invalid argument format: ${arg}`)
    }

    const cleanKey = key.replace('--', '')

    // 键名安全性检查
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanKey)) {
      throw new Error(`Invalid parameter name: ${cleanKey}`)
    }

    // 防止路径遍历和注入
    if (cleanKey.includes('..') || cleanKey.includes('/') || cleanKey.includes('\\')) {
      throw new Error(`Potentially dangerous parameter name: ${cleanKey}`)
    }

    // 设置参数值
    params[cleanKey] = value || true
  })
}

/**
 * 安全的文件路径验证
 * 防止路径遍历攻击
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path must be a non-empty string')
  }

  // 长度限制
  if (filePath.length > 500) {
    throw new Error('File path too long')
  }

  // 防止路径遍历
  if (filePath.includes('..') || filePath.includes('~')) {
    throw new Error('Path traversal detected in file path')
  }

  // 防止绝对路径到敏感目录
  const dangerousPaths = ['/etc', '/var', '/usr', '/root', '/sys', '/proc']
  if (dangerousPaths.some((path) => filePath.startsWith(path))) {
    throw new Error('Access to sensitive system directories not allowed')
  }

  return filePath
}

/**
 * 安全的JSON解析
 * 防止原型污染和内存耗尽攻击
 */
function safeJsonParse(jsonString, maxSize = 50 * 1024 * 1024) {
  // 50MB default limit
  if (!jsonString || typeof jsonString !== 'string') {
    throw new Error('JSON input must be a non-empty string')
  }

  // 大小限制防止内存耗尽
  if (jsonString.length > maxSize) {
    throw new Error(`JSON too large: ${jsonString.length} bytes (max: ${maxSize})`)
  }

  // 防止原型污染的辅助函数
  function removePrototypePollution(obj) {
    if (obj && typeof obj === 'object') {
      const dangerousKeys = ['__proto__', 'constructor', 'prototype']
      for (const key of dangerousKeys) {
        delete obj[key]
      }

      Object.keys(obj).forEach((key) => {
        if (obj[key] && typeof obj[key] === 'object') {
          removePrototypePollution(obj[key])
        }
      })
    }
  }

  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (error) {
    throw new Error(`Invalid JSON format: ${error.message}`)
  }

  // 防止原型污染
  if (parsed && typeof parsed === 'object') {
    removePrototypePollution(parsed)
  }

  return parsed
}

// 安全解析参数
try {
  parseCommandLineArgs()
} catch (error) {
  logger.error('❌ Invalid command line arguments:', error.message)
  process.exit(1)
}

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function askConfirmation(question) {
  return new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (answer) => {
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y')
    })
  })
}

// Claude 账户解密函数
function decryptClaudeData(encryptedData) {
  if (!encryptedData || !config.security.encryptionKey) {
    return encryptedData
  }

  try {
    if (encryptedData.includes(':')) {
      const parts = encryptedData.split(':')
      const key = crypto.scryptSync(config.security.encryptionKey, 'salt', 32)
      const iv = Buffer.from(parts[0], 'hex')
      const encrypted = parts[1]

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }
    return encryptedData
  } catch (error) {
    logger.warn(`⚠️  Failed to decrypt data: ${error.message}`)
    return encryptedData
  }
}

// Gemini 账户解密函数
function decryptGeminiData(encryptedData) {
  if (!encryptedData || !config.security.encryptionKey) {
    return encryptedData
  }

  try {
    if (encryptedData.includes(':')) {
      const parts = encryptedData.split(':')
      const key = crypto.scryptSync(config.security.encryptionKey, 'gemini-account-salt', 32)
      const iv = Buffer.from(parts[0], 'hex')
      const encrypted = parts[1]

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }
    return encryptedData
  } catch (error) {
    logger.warn(`⚠️  Failed to decrypt data: ${error.message}`)
    return encryptedData
  }
}

// 数据加密函数（用于导入）
function encryptClaudeData(data) {
  if (!data || !config.security.encryptionKey) {
    return data
  }

  const key = crypto.scryptSync(config.security.encryptionKey, 'salt', 32)
  const iv = crypto.randomBytes(16)

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let encrypted = cipher.update(data, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  return `${iv.toString('hex')}:${encrypted}`
}

function encryptGeminiData(data) {
  if (!data || !config.security.encryptionKey) {
    return data
  }

  const key = crypto.scryptSync(config.security.encryptionKey, 'gemini-account-salt', 32)
  const iv = crypto.randomBytes(16)

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let encrypted = cipher.update(data, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  return `${iv.toString('hex')}:${encrypted}`
}

// 导出使用统计数据
async function exportUsageStats(keyId) {
  try {
    const stats = {
      total: {},
      daily: {},
      monthly: {},
      hourly: {},
      models: {}
    }

    // 导出总统计
    const totalKey = `usage:${keyId}`
    const totalData = await redis.client.hgetall(totalKey)
    if (totalData && Object.keys(totalData).length > 0) {
      stats.total = totalData
    }

    // 导出每日统计（最近30天）
    const today = new Date()
    for (let i = 0; i < 30; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      const dailyKey = `usage:daily:${keyId}:${dateStr}`

      const dailyData = await redis.client.hgetall(dailyKey)
      if (dailyData && Object.keys(dailyData).length > 0) {
        stats.daily[dateStr] = dailyData
      }
    }

    // 导出每月统计（最近12个月）
    for (let i = 0; i < 12; i++) {
      const date = new Date(today)
      date.setMonth(date.getMonth() - i)
      const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const monthlyKey = `usage:monthly:${keyId}:${monthStr}`

      const monthlyData = await redis.client.hgetall(monthlyKey)
      if (monthlyData && Object.keys(monthlyData).length > 0) {
        stats.monthly[monthStr] = monthlyData
      }
    }

    // 导出小时统计（最近24小时）
    for (let i = 0; i < 24; i++) {
      const date = new Date(today)
      date.setHours(date.getHours() - i)
      const dateStr = date.toISOString().split('T')[0]
      const hour = String(date.getHours()).padStart(2, '0')
      const hourKey = `${dateStr}:${hour}`
      const hourlyKey = `usage:hourly:${keyId}:${hourKey}`

      const hourlyData = await redis.client.hgetall(hourlyKey)
      if (hourlyData && Object.keys(hourlyData).length > 0) {
        stats.hourly[hourKey] = hourlyData
      }
    }

    // 导出模型统计
    // 每日模型统计
    const modelDailyPattern = `usage:${keyId}:model:daily:*`
    const modelDailyKeys = await redis.client.keys(modelDailyPattern)
    for (const key of modelDailyKeys) {
      const match = key.match(/usage:.+:model:daily:(.+):(\d{4}-\d{2}-\d{2})$/)
      if (match) {
        const model = match[1]
        const date = match[2]
        const data = await redis.client.hgetall(key)
        if (data && Object.keys(data).length > 0) {
          if (!stats.models[model]) {
            stats.models[model] = { daily: {}, monthly: {} }
          }
          stats.models[model].daily[date] = data
        }
      }
    }

    // 每月模型统计
    const modelMonthlyPattern = `usage:${keyId}:model:monthly:*`
    const modelMonthlyKeys = await redis.client.keys(modelMonthlyPattern)
    for (const key of modelMonthlyKeys) {
      const match = key.match(/usage:.+:model:monthly:(.+):(\d{4}-\d{2})$/)
      if (match) {
        const model = match[1]
        const month = match[2]
        const data = await redis.client.hgetall(key)
        if (data && Object.keys(data).length > 0) {
          if (!stats.models[model]) {
            stats.models[model] = { daily: {}, monthly: {} }
          }
          stats.models[model].monthly[month] = data
        }
      }
    }

    return stats
  } catch (error) {
    logger.warn(`⚠️  Failed to export usage stats for ${keyId}: ${error.message}`)
    return null
  }
}

// 导入使用统计数据
async function importUsageStats(keyId, stats) {
  try {
    if (!stats) {
      return
    }

    const pipeline = redis.client.pipeline()
    let importCount = 0

    // 导入总统计
    if (stats.total && Object.keys(stats.total).length > 0) {
      for (const [field, value] of Object.entries(stats.total)) {
        pipeline.hset(`usage:${keyId}`, field, value)
      }
      importCount++
    }

    // 导入每日统计
    if (stats.daily) {
      for (const [date, data] of Object.entries(stats.daily)) {
        for (const [field, value] of Object.entries(data)) {
          pipeline.hset(`usage:daily:${keyId}:${date}`, field, value)
        }
        importCount++
      }
    }

    // 导入每月统计
    if (stats.monthly) {
      for (const [month, data] of Object.entries(stats.monthly)) {
        for (const [field, value] of Object.entries(data)) {
          pipeline.hset(`usage:monthly:${keyId}:${month}`, field, value)
        }
        importCount++
      }
    }

    // 导入小时统计
    if (stats.hourly) {
      for (const [hour, data] of Object.entries(stats.hourly)) {
        for (const [field, value] of Object.entries(data)) {
          pipeline.hset(`usage:hourly:${keyId}:${hour}`, field, value)
        }
        importCount++
      }
    }

    // 导入模型统计
    if (stats.models) {
      for (const [model, modelStats] of Object.entries(stats.models)) {
        // 每日模型统计
        if (modelStats.daily) {
          for (const [date, data] of Object.entries(modelStats.daily)) {
            for (const [field, value] of Object.entries(data)) {
              pipeline.hset(`usage:${keyId}:model:daily:${model}:${date}`, field, value)
            }
            importCount++
          }
        }

        // 每月模型统计
        if (modelStats.monthly) {
          for (const [month, data] of Object.entries(modelStats.monthly)) {
            for (const [field, value] of Object.entries(data)) {
              pipeline.hset(`usage:${keyId}:model:monthly:${model}:${month}`, field, value)
            }
            importCount++
          }
        }
      }
    }

    await pipeline.exec()
    logger.info(`  📊 Imported ${importCount} usage stat entries for API Key ${keyId}`)
  } catch (error) {
    logger.warn(`⚠️  Failed to import usage stats for ${keyId}: ${error.message}`)
  }
}

// 数据脱敏函数
function sanitizeData(data, type) {
  const sanitized = { ...data }

  switch (type) {
    case 'apikey':
      if (sanitized.apiKey) {
        sanitized.apiKey = `${sanitized.apiKey.substring(0, 10)}...[REDACTED]`
      }
      break

    case 'claude_account':
      if (sanitized.email) {
        sanitized.email = '[REDACTED]'
      }
      if (sanitized.password) {
        sanitized.password = '[REDACTED]'
      }
      if (sanitized.accessToken) {
        sanitized.accessToken = '[REDACTED]'
      }
      if (sanitized.refreshToken) {
        sanitized.refreshToken = '[REDACTED]'
      }
      if (sanitized.claudeAiOauth) {
        sanitized.claudeAiOauth = '[REDACTED]'
      }
      if (sanitized.proxyPassword) {
        sanitized.proxyPassword = '[REDACTED]'
      }
      break

    case 'gemini_account':
      if (sanitized.geminiOauth) {
        sanitized.geminiOauth = '[REDACTED]'
      }
      if (sanitized.accessToken) {
        sanitized.accessToken = '[REDACTED]'
      }
      if (sanitized.refreshToken) {
        sanitized.refreshToken = '[REDACTED]'
      }
      if (sanitized.proxyPassword) {
        sanitized.proxyPassword = '[REDACTED]'
      }
      break

    case 'admin':
      if (sanitized.password) {
        sanitized.password = '[REDACTED]'
      }
      break
  }

  return sanitized
}

// 导出数据 - 使用分布式锁防止并发操作
async function exportData() {
  const lockResource = 'data-export'

  try {
    // 验证输入参数
    const outputFile = params.output || `backup-${new Date().toISOString().split('T')[0]}.json`
    validateFilePath(outputFile)

    const types = params.types ? params.types.split(',') : ['all']
    const shouldSanitize = params.sanitize === true
    const shouldDecrypt = params.decrypt !== false // 默认解密

    logger.info('🔄 Starting data export...')
    logger.info(`📁 Output file: ${outputFile}`)
    logger.info(`📋 Data types: ${types.join(', ')}`)
    logger.info(`🔒 Sanitize sensitive data: ${shouldSanitize ? 'YES' : 'NO'}`)
    logger.info(`🔓 Decrypt data: ${shouldDecrypt ? 'YES' : 'NO'}`)

    // 使用分布式锁防止并发导出操作
    await distributedLock.withLock(
      lockResource,
      async () => {
        await redis.connect()
        logger.success('✅ Connected to Redis')

        const exportDataObj = {
          metadata: {
            version: '2.0',
            exportDate: new Date().toISOString(),
            sanitized: shouldSanitize,
            decrypted: shouldDecrypt,
            types,
            exportId: crypto.randomBytes(16).toString('hex') // 唯一导出标识
          },
          data: {}
        }

        // 导出 API Keys
        if (types.includes('all') || types.includes('apikeys')) {
          logger.info('📤 Exporting API Keys...')
          await exportApiKeysWithLock(exportDataObj, shouldSanitize, types)
        }

        // 导出 Claude 账户
        if (types.includes('all') || types.includes('accounts')) {
          logger.info('📤 Exporting Claude accounts...')
          await exportClaudeAccountsWithLock(exportDataObj, shouldSanitize, shouldDecrypt)
        }

        // 导出管理员
        if (types.includes('all') || types.includes('admins')) {
          logger.info('📤 Exporting admins...')
          await exportAdminsWithLock(exportDataObj, shouldSanitize)
        }

        // 导出全局模型统计（如果需要）
        if (types.includes('all') || types.includes('stats')) {
          logger.info('📤 Exporting global model statistics...')
          await exportGlobalStatsWithLock(exportDataObj)
        }

        // 写入文件
        await fs.writeFile(outputFile, JSON.stringify(exportDataObj, null, 2))

        // 显示导出摘要
        console.log(`\n${'='.repeat(60)}`)
        console.log('✅ Export Complete!')
        console.log('='.repeat(60))
        console.log(`Output file: ${outputFile}`)
        console.log(`File size: ${(await fs.stat(outputFile)).size} bytes`)

        if (exportDataObj.data.apiKeys) {
          console.log(`API Keys: ${exportDataObj.data.apiKeys.length}`)
        }
        if (exportDataObj.data.claudeAccounts) {
          console.log(`Claude Accounts: ${exportDataObj.data.claudeAccounts.length}`)
        }
        if (exportDataObj.data.geminiAccounts) {
          console.log(`Gemini Accounts: ${exportDataObj.data.geminiAccounts.length}`)
        }
        if (exportDataObj.data.admins) {
          console.log(`Admins: ${exportDataObj.data.admins.length}`)
        }
        console.log('='.repeat(60))

        if (shouldSanitize) {
          logger.warn('⚠️  Sensitive data has been sanitized in this export.')
        }
        if (shouldDecrypt) {
          logger.info('🔓 Encrypted data has been decrypted for portability.')
        }
      },
      {
        ttl: 300, // 5分钟锁定时间
        autoExtend: true,
        extendInterval: 60 // 每60秒延长一次
      }
    )
  } catch (error) {
    logger.error('💥 Export failed:', error)
    process.exit(1)
  } finally {
    await redis.disconnect()
    rl.close()
  }
}

// 原子化导出API Keys
async function exportApiKeysWithLock(exportDataObj, shouldSanitize, types) {
  const keys = await redis.client.keys('apikey:*')
  const apiKeys = []

  for (const key of keys) {
    if (key === 'apikey:hash_map') {
      continue
    }

    const data = await redis.client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      // 获取该 API Key 的 ID
      const keyId = data.id

      // 导出使用统计数据
      if (keyId && (types.includes('all') || types.includes('stats'))) {
        data.usageStats = await exportUsageStats(keyId)
      }

      apiKeys.push(shouldSanitize ? sanitizeData(data, 'apikey') : data)
    }
  }

  exportDataObj.data.apiKeys = apiKeys
  logger.success(`✅ Exported ${apiKeys.length} API Keys`)
}

// 原子化导出Claude账户
async function exportClaudeAccountsWithLock(exportDataObj, shouldSanitize, shouldDecrypt) {
  const keys = await redis.client.keys('claude:account:*')
  logger.info(`Found ${keys.length} Claude account keys in Redis`)
  const accounts = []

  for (const key of keys) {
    const data = await redis.client.hgetall(key)

    if (data && Object.keys(data).length > 0) {
      // 解密敏感字段
      if (shouldDecrypt && !shouldSanitize) {
        if (data.email) {
          data.email = decryptClaudeData(data.email)
        }
        if (data.password) {
          data.password = decryptClaudeData(data.password)
        }
        if (data.accessToken) {
          data.accessToken = decryptClaudeData(data.accessToken)
        }
        if (data.refreshToken) {
          data.refreshToken = decryptClaudeData(data.refreshToken)
        }
        if (data.claudeAiOauth) {
          const decrypted = decryptClaudeData(data.claudeAiOauth)
          try {
            data.claudeAiOauth = JSON.parse(decrypted)
          } catch (e) {
            data.claudeAiOauth = decrypted
          }
        }
      }

      accounts.push(shouldSanitize ? sanitizeData(data, 'claude_account') : data)
    }
  }

  exportDataObj.data.claudeAccounts = accounts
  logger.success(`✅ Exported ${accounts.length} Claude accounts`)

  // 导出 Gemini 账户
  logger.info('📤 Exporting Gemini accounts...')
  const geminiKeys = await redis.client.keys('gemini_account:*')
  logger.info(`Found ${geminiKeys.length} Gemini account keys in Redis`)
  const geminiAccounts = []

  for (const key of geminiKeys) {
    const data = await redis.client.hgetall(key)

    if (data && Object.keys(data).length > 0) {
      // 解密敏感字段
      if (shouldDecrypt && !shouldSanitize) {
        if (data.geminiOauth) {
          const decrypted = decryptGeminiData(data.geminiOauth)
          try {
            data.geminiOauth = JSON.parse(decrypted)
          } catch (e) {
            data.geminiOauth = decrypted
          }
        }
        if (data.accessToken) {
          data.accessToken = decryptGeminiData(data.accessToken)
        }
        if (data.refreshToken) {
          data.refreshToken = decryptGeminiData(data.refreshToken)
        }
      }

      geminiAccounts.push(shouldSanitize ? sanitizeData(data, 'gemini_account') : data)
    }
  }

  exportDataObj.data.geminiAccounts = geminiAccounts
  logger.success(`✅ Exported ${geminiAccounts.length} Gemini accounts`)
}

// 原子化导出管理员
async function exportAdminsWithLock(exportDataObj, shouldSanitize) {
  const keys = await redis.client.keys('admin:*')
  const admins = []

  for (const key of keys) {
    if (key.includes('admin_username:')) {
      continue
    }

    const data = await redis.client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      admins.push(shouldSanitize ? sanitizeData(data, 'admin') : data)
    }
  }

  exportDataObj.data.admins = admins
  logger.success(`✅ Exported ${admins.length} admins`)
}

// 原子化导出全局统计
async function exportGlobalStatsWithLock(exportDataObj) {
  const globalStats = {
    daily: {},
    monthly: {},
    hourly: {}
  }

  // 导出全局每日模型统计
  const globalDailyPattern = 'usage:model:daily:*'
  const globalDailyKeys = await redis.client.keys(globalDailyPattern)
  for (const key of globalDailyKeys) {
    const match = key.match(/usage:model:daily:(.+):(\d{4}-\d{2}-\d{2})$/)
    if (match) {
      const model = match[1]
      const date = match[2]
      const data = await redis.client.hgetall(key)
      if (data && Object.keys(data).length > 0) {
        if (!globalStats.daily[date]) {
          globalStats.daily[date] = {}
        }
        globalStats.daily[date][model] = data
      }
    }
  }

  // 导出全局每月模型统计
  const globalMonthlyPattern = 'usage:model:monthly:*'
  const globalMonthlyKeys = await redis.client.keys(globalMonthlyPattern)
  for (const key of globalMonthlyKeys) {
    const match = key.match(/usage:model:monthly:(.+):(\d{4}-\d{2})$/)
    if (match) {
      const model = match[1]
      const month = match[2]
      const data = await redis.client.hgetall(key)
      if (data && Object.keys(data).length > 0) {
        if (!globalStats.monthly[month]) {
          globalStats.monthly[month] = {}
        }
        globalStats.monthly[month][model] = data
      }
    }
  }

  // 导出全局每小时模型统计
  const globalHourlyPattern = 'usage:model:hourly:*'
  const globalHourlyKeys = await redis.client.keys(globalHourlyPattern)
  for (const key of globalHourlyKeys) {
    const match = key.match(/usage:model:hourly:(.+):(\d{4}-\d{2}-\d{2}:\d{2})$/)
    if (match) {
      const model = match[1]
      const hour = match[2]
      const data = await redis.client.hgetall(key)
      if (data && Object.keys(data).length > 0) {
        if (!globalStats.hourly[hour]) {
          globalStats.hourly[hour] = {}
        }
        globalStats.hourly[hour][model] = data
      }
    }
  }

  exportDataObj.data.globalModelStats = globalStats
  logger.success('✅ Exported global model statistics')
}

// 显示帮助信息
function showHelp() {
  console.log(`
Enhanced Data Transfer Tool for Claude Relay Service

This tool handles encrypted data export/import between environments.

Usage:
  node scripts/data-transfer-enhanced.js <command> [options]

Commands:
  export    Export data from Redis to a JSON file
  import    Import data from a JSON file to Redis

Export Options:
  --output=FILE        Output filename (default: backup-YYYY-MM-DD.json)
  --types=TYPE,...     Data types: apikeys,accounts,admins,stats,all (default: all)
                       stats: Include usage statistics with API keys
  --sanitize           Remove sensitive data from export
  --decrypt=false      Keep data encrypted (default: true - decrypt for portability)

Import Options:
  --input=FILE         Input filename (required)
  --force              Overwrite existing data without asking
  --skip-conflicts     Skip conflicting data without asking

Important Notes:
  - The tool automatically handles encryption/decryption during import
  - If importing decrypted data, it will be re-encrypted automatically
  - If importing encrypted data, it will be stored as-is
  - Sanitized exports cannot be properly imported (missing sensitive data)

Examples:
  # Export all data with decryption (for migration)
  node scripts/data-transfer-enhanced.js export

  # Export without decrypting (for backup)
  node scripts/data-transfer-enhanced.js export --decrypt=false

  # Import data (auto-handles encryption)
  node scripts/data-transfer-enhanced.js import --input=backup.json

  # Import with force overwrite
  node scripts/data-transfer-enhanced.js import --input=backup.json --force
`)
}

// 导入数据 - 使用分布式锁防止并发操作
async function importData() {
  const lockResource = 'data-import'

  try {
    const inputFile = params.input
    if (!inputFile) {
      logger.error('❌ Please specify input file with --input=filename.json')
      process.exit(1)
    }

    // 验证输入文件路径
    validateFilePath(inputFile)

    const forceOverwrite = params.force === true
    const skipConflicts = params['skip-conflicts'] === true

    logger.info('🔄 Starting data import...')
    logger.info(`📁 Input file: ${inputFile}`)
    logger.info(
      `⚡ Mode: ${forceOverwrite ? 'FORCE OVERWRITE' : skipConflicts ? 'SKIP CONFLICTS' : 'ASK ON CONFLICT'}`
    )

    // 使用分布式锁防止并发导入操作
    await distributedLock.withLock(
      lockResource,
      async () => {
        // 安全读取和解析文件
        const fileContent = await fs.readFile(inputFile, 'utf8')
        const importDataObj = safeJsonParse(fileContent)

        // 验证文件格式
        if (!importDataObj.metadata || !importDataObj.data) {
          throw new Error('Invalid backup file format - missing metadata or data sections')
        }

        logger.info(`📅 Backup date: ${importDataObj.metadata.exportDate}`)
        logger.info(`🔒 Sanitized: ${importDataObj.metadata.sanitized ? 'YES' : 'NO'}`)
        logger.info(`🔓 Decrypted: ${importDataObj.metadata.decrypted ? 'YES' : 'NO'}`)

        if (importDataObj.metadata.sanitized) {
          logger.warn('⚠️  This backup contains sanitized data. Sensitive fields will be missing!')
          const proceed = await askConfirmation('Continue with sanitized data?')
          if (!proceed) {
            logger.info('❌ Import cancelled')
            return
          }
        }

        // 显示导入摘要
        console.log(`\n${'='.repeat(60)}`)
        console.log('📋 Import Summary:')
        console.log('='.repeat(60))
        if (importDataObj.data.apiKeys) {
          console.log(`API Keys to import: ${importDataObj.data.apiKeys.length}`)
        }
        if (importDataObj.data.claudeAccounts) {
          console.log(`Claude Accounts to import: ${importDataObj.data.claudeAccounts.length}`)
        }
        if (importDataObj.data.geminiAccounts) {
          console.log(`Gemini Accounts to import: ${importDataObj.data.geminiAccounts.length}`)
        }
        if (importDataObj.data.admins) {
          console.log(`Admins to import: ${importDataObj.data.admins.length}`)
        }
        console.log(`${'='.repeat(60)}\n`)

        // 确认导入
        const confirmed = await askConfirmation('⚠️  Proceed with import?')
        if (!confirmed) {
          logger.info('❌ Import cancelled')
          return
        }

        // 连接 Redis
        await redis.connect()
        logger.success('✅ Connected to Redis')

        const stats = {
          imported: 0,
          skipped: 0,
          errors: 0
        }

        // 原子化导入操作
        await importApiKeysAtomic(importDataObj, forceOverwrite, skipConflicts, stats)
        await importClaudeAccountsAtomic(importDataObj, forceOverwrite, skipConflicts, stats)
        await importGeminiAccountsAtomic(importDataObj, forceOverwrite, skipConflicts, stats)
        await importAdminsAtomic(importDataObj, forceOverwrite, skipConflicts, stats)
        await importGlobalStatsAtomic(importDataObj, stats)

        // 显示导入结果
        console.log(`\n${'='.repeat(60)}`)
        console.log('✅ Import Complete!')
        console.log('='.repeat(60))
        console.log(`Successfully imported: ${stats.imported}`)
        console.log(`Skipped: ${stats.skipped}`)
        console.log(`Errors: ${stats.errors}`)
        console.log('='.repeat(60))
      },
      {
        ttl: 600, // 10分钟锁定时间（导入操作可能较慢）
        autoExtend: true,
        extendInterval: 120 // 每2分钟延长一次
      }
    )
  } catch (error) {
    logger.error('💥 Import failed:', error)
    process.exit(1)
  } finally {
    await redis.disconnect()
    rl.close()
  }
}

// 原子化导入API Keys
async function importApiKeysAtomic(importDataObj, forceOverwrite, skipConflicts, stats) {
  if (!importDataObj.data.apiKeys) {
    return
  }

  logger.info('\n📥 Importing API Keys...')
  for (const apiKey of importDataObj.data.apiKeys) {
    try {
      const exists = await redis.client.exists(`apikey:${apiKey.id}`)

      if (exists && !forceOverwrite) {
        if (skipConflicts) {
          logger.warn(`⏭️  Skipped existing API Key: ${apiKey.name} (${apiKey.id})`)
          stats.skipped++
          continue
        } else {
          const overwrite = await askConfirmation(
            `API Key "${apiKey.name}" (${apiKey.id}) exists. Overwrite?`
          )
          if (!overwrite) {
            stats.skipped++
            continue
          }
        }
      }

      // 保存使用统计数据以便单独导入
      const { usageStats } = apiKey

      // 从apiKey对象中删除usageStats字段，避免存储到主键中
      const apiKeyData = { ...apiKey }
      delete apiKeyData.usageStats

      // 使用 Pipeline 原子化存储
      const pipeline = redis.client.pipeline()
      for (const [field, value] of Object.entries(apiKeyData)) {
        pipeline.hset(`apikey:${apiKey.id}`, field, value)
      }
      await pipeline.exec()

      // 更新哈希映射
      if (apiKey.apiKey && !importDataObj.metadata.sanitized) {
        await redis.client.hset('apikey:hash_map', apiKey.apiKey, apiKey.id)
      }

      // 导入使用统计数据
      if (usageStats) {
        await importUsageStats(apiKey.id, usageStats)
      }

      logger.success(`✅ Imported API Key: ${apiKey.name} (${apiKey.id})`)
      stats.imported++
    } catch (error) {
      logger.error(`❌ Failed to import API Key ${apiKey.id}:`, error.message)
      stats.errors++
    }
  }
}

// 原子化导入Claude账户
async function importClaudeAccountsAtomic(importDataObj, forceOverwrite, skipConflicts, stats) {
  if (!importDataObj.data.claudeAccounts) {
    return
  }

  logger.info('\n📥 Importing Claude accounts...')
  for (const account of importDataObj.data.claudeAccounts) {
    try {
      const exists = await redis.client.exists(`claude:account:${account.id}`)

      if (exists && !forceOverwrite) {
        if (skipConflicts) {
          logger.warn(`⏭️  Skipped existing Claude account: ${account.name} (${account.id})`)
          stats.skipped++
          continue
        } else {
          const overwrite = await askConfirmation(
            `Claude account "${account.name}" (${account.id}) exists. Overwrite?`
          )
          if (!overwrite) {
            stats.skipped++
            continue
          }
        }
      }

      // 复制账户数据以避免修改原始数据
      const accountData = { ...account }

      // 如果数据已解密且不是脱敏数据，需要重新加密
      if (importDataObj.metadata.decrypted && !importDataObj.metadata.sanitized) {
        logger.info(`🔐 Re-encrypting sensitive data for Claude account: ${account.name}`)

        if (accountData.email) {
          accountData.email = encryptClaudeData(accountData.email)
        }
        if (accountData.password) {
          accountData.password = encryptClaudeData(accountData.password)
        }
        if (accountData.accessToken) {
          accountData.accessToken = encryptClaudeData(accountData.accessToken)
        }
        if (accountData.refreshToken) {
          accountData.refreshToken = encryptClaudeData(accountData.refreshToken)
        }
        if (accountData.claudeAiOauth) {
          // 如果是对象，先序列化再加密
          const oauthStr =
            typeof accountData.claudeAiOauth === 'object'
              ? JSON.stringify(accountData.claudeAiOauth)
              : accountData.claudeAiOauth
          accountData.claudeAiOauth = encryptClaudeData(oauthStr)
        }
      }

      // 使用 Pipeline 原子化存储
      const pipeline = redis.client.pipeline()
      for (const [field, value] of Object.entries(accountData)) {
        if (field === 'claudeAiOauth' && typeof value === 'object') {
          // 确保对象被序列化
          pipeline.hset(`claude:account:${account.id}`, field, JSON.stringify(value))
        } else {
          pipeline.hset(`claude:account:${account.id}`, field, value)
        }
      }
      await pipeline.exec()

      logger.success(`✅ Imported Claude account: ${account.name} (${account.id})`)
      stats.imported++
    } catch (error) {
      logger.error(`❌ Failed to import Claude account ${account.id}:`, error.message)
      stats.errors++
    }
  }
}

// 原子化导入Gemini账户
async function importGeminiAccountsAtomic(importDataObj, forceOverwrite, skipConflicts, stats) {
  if (!importDataObj.data.geminiAccounts) {
    return
  }

  logger.info('\n📥 Importing Gemini accounts...')
  for (const account of importDataObj.data.geminiAccounts) {
    try {
      const exists = await redis.client.exists(`gemini_account:${account.id}`)

      if (exists && !forceOverwrite) {
        if (skipConflicts) {
          logger.warn(`⏭️  Skipped existing Gemini account: ${account.name} (${account.id})`)
          stats.skipped++
          continue
        } else {
          const overwrite = await askConfirmation(
            `Gemini account "${account.name}" (${account.id}) exists. Overwrite?`
          )
          if (!overwrite) {
            stats.skipped++
            continue
          }
        }
      }

      // 复制账户数据以避免修改原始数据
      const accountData = { ...account }

      // 如果数据已解密且不是脱敏数据，需要重新加密
      if (importDataObj.metadata.decrypted && !importDataObj.metadata.sanitized) {
        logger.info(`🔐 Re-encrypting sensitive data for Gemini account: ${account.name}`)

        if (accountData.geminiOauth) {
          const oauthStr =
            typeof accountData.geminiOauth === 'object'
              ? JSON.stringify(accountData.geminiOauth)
              : accountData.geminiOauth
          accountData.geminiOauth = encryptGeminiData(oauthStr)
        }
        if (accountData.accessToken) {
          accountData.accessToken = encryptGeminiData(accountData.accessToken)
        }
        if (accountData.refreshToken) {
          accountData.refreshToken = encryptGeminiData(accountData.refreshToken)
        }
      }

      // 使用 Pipeline 原子化存储
      const pipeline = redis.client.pipeline()
      for (const [field, value] of Object.entries(accountData)) {
        pipeline.hset(`gemini_account:${account.id}`, field, value)
      }
      await pipeline.exec()

      logger.success(`✅ Imported Gemini account: ${account.name} (${account.id})`)
      stats.imported++
    } catch (error) {
      logger.error(`❌ Failed to import Gemini account ${account.id}:`, error.message)
      stats.errors++
    }
  }
}

// 原子化导入管理员
async function importAdminsAtomic(importDataObj, forceOverwrite, skipConflicts, stats) {
  if (!importDataObj.data.admins) {
    return
  }

  logger.info('\n📥 Importing admins...')
  for (const admin of importDataObj.data.admins) {
    try {
      const exists = await redis.client.exists(`admin:${admin.id}`)

      if (exists && !forceOverwrite) {
        if (skipConflicts) {
          logger.warn(`⏭️  Skipped existing admin: ${admin.username} (${admin.id})`)
          stats.skipped++
          continue
        } else {
          const overwrite = await askConfirmation(
            `Admin "${admin.username}" (${admin.id}) exists. Overwrite?`
          )
          if (!overwrite) {
            stats.skipped++
            continue
          }
        }
      }

      // 使用 Pipeline 原子化存储
      const pipeline = redis.client.pipeline()
      for (const [field, value] of Object.entries(admin)) {
        pipeline.hset(`admin:${admin.id}`, field, value)
      }
      // 更新用户名映射
      pipeline.set(`admin_username:${admin.username}`, admin.id)
      await pipeline.exec()

      logger.success(`✅ Imported admin: ${admin.username} (${admin.id})`)
      stats.imported++
    } catch (error) {
      logger.error(`❌ Failed to import admin ${admin.id}:`, error.message)
      stats.errors++
    }
  }
}

// 原子化导入全局统计
async function importGlobalStatsAtomic(importDataObj, stats) {
  if (!importDataObj.data.globalModelStats) {
    return
  }

  logger.info('\n📥 Importing global model statistics...')
  try {
    const globalStats = importDataObj.data.globalModelStats
    const pipeline = redis.client.pipeline()
    let globalStatCount = 0

    // 导入每日统计
    if (globalStats.daily) {
      for (const [date, models] of Object.entries(globalStats.daily)) {
        for (const [model, data] of Object.entries(models)) {
          for (const [field, value] of Object.entries(data)) {
            pipeline.hset(`usage:model:daily:${model}:${date}`, field, value)
          }
          globalStatCount++
        }
      }
    }

    // 导入每月统计
    if (globalStats.monthly) {
      for (const [month, models] of Object.entries(globalStats.monthly)) {
        for (const [model, data] of Object.entries(models)) {
          for (const [field, value] of Object.entries(data)) {
            pipeline.hset(`usage:model:monthly:${model}:${month}`, field, value)
          }
          globalStatCount++
        }
      }
    }

    // 导入每小时统计
    if (globalStats.hourly) {
      for (const [hour, models] of Object.entries(globalStats.hourly)) {
        for (const [model, data] of Object.entries(models)) {
          for (const [field, value] of Object.entries(data)) {
            pipeline.hset(`usage:model:hourly:${model}:${hour}`, field, value)
          }
          globalStatCount++
        }
      }
    }

    await pipeline.exec()
    logger.success(`✅ Imported ${globalStatCount} global model stat entries`)
    stats.imported += globalStatCount
  } catch (error) {
    logger.error('❌ Failed to import global model stats:', error.message)
    stats.errors++
  }
}

// 主函数
async function main() {
  if (!command || command === '--help' || command === 'help') {
    showHelp()
    process.exit(0)
  }

  switch (command) {
    case 'export':
      await exportData()
      break

    case 'import':
      await importData()
      break

    default:
      logger.error(`❌ Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }
}

// 运行
main().catch((error) => {
  logger.error('💥 Unexpected error:', error)
  process.exit(1)
})
