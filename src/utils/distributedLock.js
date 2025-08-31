const redis = require('../models/redis')
const logger = require('./logger')
const crypto = require('crypto')

/**
 * 分布式锁工具类（增强版 - 防止死锁）
 * 防止并发操作导致的数据竞争和不一致性
 *
 * 安全特性：
 * - 基于Redis的原子操作
 * - 锁过期时间防止死锁
 * - 唯一锁标识防止误解锁
 * - 自动锁延期机制
 * - 重试机制和超时控制
 * - 死锁检测和防止
 * - 锁排序防止循环等待
 * - 优先级队列支持
 */
class DistributedLock {
  constructor(redisClient = null) {
    this.redis = redisClient || redis.client
    this.lockPrefix = 'lock:'
    this.waitPrefix = 'lock_wait:'
    this.defaultTtl = 30 // 默认锁存活时间（秒）
    this.defaultRetryDelay = 100 // 默认重试延迟（毫秒）
    this.defaultMaxRetries = 50 // 默认最大重试次数
    this.deadlockDetectionInterval = 5000 // 死锁检测间隔（毫秒）

    // 死锁检测相关
    this.lockWaitGraph = new Map() // 锁等待关系图
    this.processLocks = new Map() // 进程持有的锁

    // 启动死锁检测器
    this.startDeadlockDetector()
  }

  /**
   * 生成唯一的锁标识
   */
  generateLockValue() {
    return `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`
  }

  /**
   * 获取锁的Redis键名
   */
  getLockKey(resource) {
    return `${this.lockPrefix}${resource}`
  }

  /**
   * 获取锁等待队列的Redis键名
   */
  getWaitQueueKey(resource) {
    return `${this.waitPrefix}${resource}`
  }

  /**
   * 🔒 对资源名进行排序，防止死锁（强制锁排序）
   */
  sortResources(resources) {
    if (!Array.isArray(resources)) {
      return [resources]
    }
    return [...resources].sort()
  }

  /**
   * 🔍 死锁检测 - 检测等待图中的循环
   */
  detectDeadlock() {
    const visited = new Set()
    const recursionStack = new Set()

    // 深度优先搜索检测循环
    const hasCycle = (node) => {
      if (recursionStack.has(node)) {
        return true // 发现循环
      }

      if (visited.has(node)) {
        return false
      }

      visited.add(node)
      recursionStack.add(node)

      const neighbors = this.lockWaitGraph.get(node) || []
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) {
          return true
        }
      }

      recursionStack.delete(node)
      return false
    }

    // 检查所有节点
    for (const node of this.lockWaitGraph.keys()) {
      if (!visited.has(node) && hasCycle(node)) {
        return node // 返回参与死锁的节点
      }
    }

    return null // 无死锁
  }

  /**
   * 📊 记录锁等待关系
   */
  recordLockWait(waitingProcess, holdingProcess, resource) {
    const waitKey = `${waitingProcess}:${resource}`
    const holdKey = `${holdingProcess}:${resource}`

    if (!this.lockWaitGraph.has(waitKey)) {
      this.lockWaitGraph.set(waitKey, [])
    }

    const waitList = this.lockWaitGraph.get(waitKey)
    if (!waitList.includes(holdKey)) {
      waitList.push(holdKey)
    }

    logger.debug(
      `🔍 Recorded lock wait: ${waitingProcess} waiting for ${holdingProcess} on resource ${resource}`
    )
  }

  /**
   * 🧹 清理锁等待关系
   */
  clearLockWait(process, resource) {
    const processKey = `${process}:${resource}`
    this.lockWaitGraph.delete(processKey)

    // 清理其他进程对此进程的等待关系
    for (const [_key, waitList] of this.lockWaitGraph.entries()) {
      const index = waitList.indexOf(processKey)
      if (index > -1) {
        waitList.splice(index, 1)
      }
    }
  }

  /**
   * ⏰ 启动死锁检测器
   */
  startDeadlockDetector() {
    setInterval(() => {
      try {
        const deadlockNode = this.detectDeadlock()
        if (deadlockNode) {
          logger.error(`💀 Deadlock detected involving: ${deadlockNode}`)
          // 强制释放最老的锁来解决死锁
          this.resolveDeadlock(deadlockNode)
        }
      } catch (error) {
        logger.error('❌ Error in deadlock detection:', error)
      }
    }, this.deadlockDetectionInterval)
  }

  /**
   * ⚡ 解决死锁 - 强制释放锁
   */
  async resolveDeadlock(deadlockNode) {
    try {
      const [process, resource] = deadlockNode.split(':')
      const lockKey = this.getLockKey(resource)

      // 强制释放锁（不检查所有权）
      await this.redis.del(lockKey)

      // 清理等待关系
      this.clearLockWait(process, resource)

      logger.warn(
        `⚡ Resolved deadlock by forcibly releasing lock: ${resource} from process ${process}`
      )

      // 通知等待的进程重试
      const waitQueueKey = this.getWaitQueueKey(resource)
      await this.redis.publish(waitQueueKey, 'deadlock_resolved')
    } catch (error) {
      logger.error(`❌ Error resolving deadlock for ${deadlockNode}:`, error)
    }
  }

  /**
   * 尝试获取分布式锁（增强版 - 支持死锁防止和优先级）
   * @param {string|Array} resources - 锁定的资源名称或资源数组
   * @param {number} ttl - 锁存活时间（秒）
   * @param {number} maxRetries - 最大重试次数
   * @param {number} retryDelay - 重试延迟（毫秒）
   * @param {number} priority - 优先级（数字越小优先级越高）
   * @returns {Promise<string|null>} 锁标识或null（获取失败）
   */
  async acquire(
    resources,
    ttl = this.defaultTtl,
    maxRetries = this.defaultMaxRetries,
    retryDelay = this.defaultRetryDelay,
    priority = 100
  ) {
    // 🔒 强制资源排序，防止死锁
    const sortedResources = this.sortResources(resources)
    const lockValue = this.generateLockValue()
    const processId = `${process.pid}:${Date.now()}`

    let retries = 0
    const acquiredLocks = []

    try {
      while (retries < maxRetries) {
        let allLocksAcquired = true
        const lockResults = []

        // 🔄 按排序顺序尝试获取所有锁
        for (let i = 0; i < sortedResources.length; i++) {
          const resource = sortedResources[i]
          const lockKey = this.getLockKey(resource)

          try {
            // 🚀 优先级支持 - 检查是否有更高优先级的等待者
            const waitQueueKey = this.getWaitQueueKey(resource)
            const queueLength = await this.redis.llen(waitQueueKey)

            if (queueLength > 0) {
              // 检查队列中是否有更高优先级的请求
              const topRequest = await this.redis.lindex(waitQueueKey, 0)
              if (topRequest) {
                const topPriority = JSON.parse(topRequest).priority || 100
                if (priority > topPriority) {
                  // 当前请求优先级较低，加入队列等待
                  const queueEntry = {
                    processId,
                    priority,
                    timestamp: Date.now(),
                    resources: sortedResources
                  }
                  await this.redis.rpush(waitQueueKey, JSON.stringify(queueEntry))
                  allLocksAcquired = false
                  break
                }
              }
            }

            // 尝试获取锁
            const result = await this.redis.set(lockKey, lockValue, 'EX', ttl, 'NX')

            if (result === 'OK') {
              acquiredLocks.push({ resource, lockKey, lockValue })
              lockResults.push({ resource, acquired: true })

              // 记录进程持有的锁
              if (!this.processLocks.has(processId)) {
                this.processLocks.set(processId, [])
              }
              this.processLocks.get(processId).push(resource)
            } else {
              // 获取锁失败，记录等待关系用于死锁检测
              const currentHolder = await this.redis.get(lockKey)
              if (currentHolder) {
                this.recordLockWait(processId, currentHolder, resource)
              }

              allLocksAcquired = false
              lockResults.push({ resource, acquired: false })
              break // 立即停止尝试后续锁
            }
          } catch (error) {
            logger.error(`❌ Error acquiring lock for ${resource}:`, error)
            allLocksAcquired = false
            break
          }
        }

        if (allLocksAcquired) {
          // 🎉 成功获取所有锁
          logger.debug(`🔒 Acquired distributed locks: ${sortedResources.join(', ')}`, {
            lockValue,
            ttl,
            retries,
            pid: process.pid,
            priority
          })

          // 清理等待关系
          for (const resource of sortedResources) {
            this.clearLockWait(processId, resource)
          }

          return lockValue
        } else {
          // 🔄 释放已获取的部分锁
          for (const lock of acquiredLocks) {
            try {
              await this.release(lock.resource, lock.lockValue)
            } catch (releaseError) {
              logger.error(
                `❌ Error releasing partially acquired lock ${lock.resource}:`,
                releaseError
              )
            }
          }
          acquiredLocks.length = 0
        }

        // 💤 等待后重试（添加抖动减少竞争）
        if (retries < maxRetries - 1) {
          const jitteredDelay = retryDelay + Math.random() * retryDelay * 0.1
          await this.delay(jitteredDelay)
          retries++
        } else {
          break
        }
      }

      logger.warn(
        `⚠️ Failed to acquire locks after ${retries + 1} attempts: ${sortedResources.join(', ')}`,
        {
          maxRetries,
          retryDelay,
          pid: process.pid,
          priority
        }
      )

      return null
    } catch (error) {
      // 🧹 错误时清理部分获取的锁
      for (const lock of acquiredLocks) {
        try {
          await this.release(lock.resource, lock.lockValue)
        } catch (releaseError) {
          logger.error(
            `❌ Error releasing lock during error cleanup ${lock.resource}:`,
            releaseError
          )
        }
      }
      throw error
    }
  }

  /**
   * 释放分布式锁
   * @param {string} resource - 锁定的资源名称
   * @param {string} lockValue - 锁标识
   * @returns {Promise<boolean>} 是否成功释放
   */
  async release(resource, lockValue) {
    const lockKey = this.getLockKey(resource)

    try {
      // 使用Lua脚本确保原子性：只有持有正确锁值的进程才能释放锁
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `

      const result = await this.redis.eval(luaScript, 1, lockKey, lockValue)

      if (result === 1) {
        logger.debug(`🔓 Released distributed lock: ${resource}`, {
          lockValue,
          pid: process.pid
        })
        return true
      } else {
        logger.warn(`⚠️ Failed to release lock (not owner or expired): ${resource}`, {
          lockValue,
          pid: process.pid
        })
        return false
      }
    } catch (error) {
      logger.error(`❌ Error releasing lock for ${resource}:`, {
        error: error.message,
        lockValue,
        pid: process.pid
      })
      throw error
    }
  }

  /**
   * 延长锁的存活时间
   * @param {string} resource - 锁定的资源名称
   * @param {string} lockValue - 锁标识
   * @param {number} ttl - 新的存活时间（秒）
   * @returns {Promise<boolean>} 是否成功延期
   */
  async extend(resource, lockValue, ttl = this.defaultTtl) {
    const lockKey = this.getLockKey(resource)

    try {
      // 使用Lua脚本确保原子性：只有持有正确锁值的进程才能延期
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `

      const result = await this.redis.eval(luaScript, 1, lockKey, lockValue, ttl)

      if (result === 1) {
        logger.debug(`⏰ Extended lock TTL: ${resource}`, {
          lockValue,
          ttl,
          pid: process.pid
        })
        return true
      } else {
        logger.warn(`⚠️ Failed to extend lock (not owner or expired): ${resource}`, {
          lockValue,
          ttl,
          pid: process.pid
        })
        return false
      }
    } catch (error) {
      logger.error(`❌ Error extending lock for ${resource}:`, {
        error: error.message,
        lockValue,
        ttl,
        pid: process.pid
      })
      throw error
    }
  }

  /**
   * 检查锁是否存在
   * @param {string} resource - 锁定的资源名称
   * @returns {Promise<boolean>} 锁是否存在
   */
  async exists(resource) {
    const lockKey = this.getLockKey(resource)
    try {
      const exists = await this.redis.exists(lockKey)
      return exists === 1
    } catch (error) {
      logger.error(`❌ Error checking lock existence for ${resource}:`, error)
      throw error
    }
  }

  /**
   * 获取锁的剩余存活时间
   * @param {string} resource - 锁定的资源名称
   * @returns {Promise<number>} 剩余时间（秒），-1表示永不过期，-2表示锁不存在
   */
  async getTtl(resource) {
    const lockKey = this.getLockKey(resource)
    try {
      return await this.redis.ttl(lockKey)
    } catch (error) {
      logger.error(`❌ Error getting lock TTL for ${resource}:`, error)
      throw error
    }
  }

  /**
   * 异步延迟函数
   * @param {number} ms - 延迟毫秒数
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 使用分布式锁执行操作
   * @param {string} resource - 锁定的资源名称
   * @param {Function} operation - 要执行的操作
   * @param {Object} options - 锁选项
   * @returns {Promise<any>} 操作结果
   */
  async withLock(resource, operation, options = {}) {
    const {
      ttl = this.defaultTtl,
      maxRetries = this.defaultMaxRetries,
      retryDelay = this.defaultRetryDelay,
      autoExtend = false,
      extendInterval = ttl / 2
    } = options

    const lockValue = await this.acquire(resource, ttl, maxRetries, retryDelay)

    if (!lockValue) {
      throw new Error(`Unable to acquire lock for resource: ${resource}`)
    }

    let extendTimer = null

    try {
      // 如果启用自动延期，设置定期延期
      if (autoExtend && extendInterval > 0) {
        extendTimer = setInterval(async () => {
          try {
            const extended = await this.extend(resource, lockValue, ttl)
            if (!extended) {
              logger.warn(`⚠️ Failed to auto-extend lock: ${resource}`)
              clearInterval(extendTimer)
            }
          } catch (error) {
            logger.error(`❌ Error auto-extending lock: ${resource}`, error)
            clearInterval(extendTimer)
          }
        }, extendInterval * 1000)
      }

      // 执行受保护的操作
      const result = await operation()

      return result
    } finally {
      // 清理自动延期计时器
      if (extendTimer) {
        clearInterval(extendTimer)
      }

      // 释放锁
      try {
        await this.release(resource, lockValue)
      } catch (error) {
        logger.error(`❌ Error releasing lock in finally block: ${resource}`, error)
      }
    }
  }

  /**
   * 清理所有过期锁（管理维护用）
   * 注意：这个方法应该谨慎使用，通常由管理员手动调用
   */
  async cleanupExpiredLocks() {
    try {
      const lockPattern = `${this.lockPrefix}*`
      const lockKeys = await this.redis.keys(lockPattern)

      let cleanedCount = 0

      for (const key of lockKeys) {
        const ttl = await this.redis.ttl(key)

        // TTL为-2表示键不存在（已过期），TTL为-1表示永不过期
        if (ttl === -2) {
          await this.redis.del(key)
          cleanedCount++
        }
      }

      logger.info(`🧹 Cleaned up ${cleanedCount} expired locks`, {
        totalChecked: lockKeys.length,
        cleaned: cleanedCount
      })

      return cleanedCount
    } catch (error) {
      logger.error('❌ Error cleaning up expired locks:', error)
      throw error
    }
  }
}

// 创建默认实例
const distributedLock = new DistributedLock()

// 导出类和默认实例
module.exports = {
  DistributedLock,
  distributedLock
}
