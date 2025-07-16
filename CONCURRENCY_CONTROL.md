# API Key 并发控制功能

## 功能概述

Claude Relay Service 现在支持为每个 API Key 设置并发请求限制。这个功能可以帮助：

- 防止单个 API Key 占用过多资源
- 控制对 Claude API 的并发访问
- 为不同用户/应用分配不同的并发配额
- 保护服务稳定性

## 使用方法

### 1. 创建带并发限制的 API Key

在管理后台创建 API Key 时，可以设置"并发限制"字段：

- **0 或留空**：无并发限制（默认）
- **正整数**：限制同时处理的最大请求数

例如：设置为 5，则该 API Key 最多同时处理 5 个请求。

### 2. 并发控制行为

当请求超过并发限制时：

- HTTP 状态码：`429 Too Many Requests`
- 响应内容：
```json
{
  "error": "Concurrency limit exceeded",
  "message": "Too many concurrent requests. Limit: 5 concurrent requests",
  "currentConcurrency": 5,
  "concurrencyLimit": 5
}
```

### 3. 查看并发限制

在管理后台的 API Keys 列表中，每个 Key 都会显示其并发限制设置：

- 显示为具体数字（如 "5"）表示有限制
- 显示为 "无限制" 表示没有并发限制

## 技术实现

### Redis 键结构

并发计数器存储在 Redis 中：
- 键名：`concurrency:{apiKeyId}`
- 过期时间：5分钟（防止异常情况下计数器不归零）

### 并发控制流程

1. 请求到达时，增加并发计数
2. 如果超过限制，立即拒绝并减少计数
3. 请求处理完成后，自动减少计数
4. 支持正常完成和异常中断的清理

## 测试并发控制

使用提供的测试脚本：

```bash
# 测试 10 个并发请求
node test-concurrency.js cr_your_api_key_here 10

# 使用自定义服务器地址
SERVER_URL=http://your-server:3000 node test-concurrency.js cr_your_api_key_here 20
```

测试脚本会：
- 同时发送指定数量的请求
- 显示每个请求的结果
- 统计成功、被限流和错误的请求数
- 验证并发控制是否正常工作

## 注意事项

1. **兼容性**：新功能完全向后兼容，现有 API Key 默认无并发限制
2. **性能**：并发控制使用 Redis 原子操作，性能影响极小
3. **清理机制**：请求结束时自动清理计数，异常情况有过期时间保护
4. **监控**：所有并发限制触发都会记录在日志中

## 常见问题

**Q: 并发限制会影响流式响应吗？**
A: 不会。并发限制只在请求开始时检查，一旦请求被接受，流式响应会正常进行。

**Q: 如何修改现有 API Key 的并发限制？**
A: 目前需要在管理后台编辑 API Key，后续会支持此功能。

**Q: 并发计数不准确怎么办？**
A: 并发计数器有 5 分钟过期时间，会自动重置。如需立即重置，可以在 Redis 中删除对应的键。