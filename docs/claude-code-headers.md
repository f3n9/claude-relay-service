# Claude Code Headers 动态管理功能

## 概述

该功能自动捕获和管理不同 Claude 账号使用的 Claude Code 客户端 headers，实现版本动态跟踪和避免风控。

## 功能特点

1. **自动捕获**: 从 `/api` 网关的成功请求中自动捕获 Claude Code headers
2. **版本管理**: 根据 user-agent 中的版本号智能更新，只保留最新版本
3. **账号隔离**: 每个 Claude 账号独立存储 headers，避免版本混用
4. **智能降级**: OpenAI 转发时优先使用捕获的 headers，无数据时使用默认值

## 工作原理

### 1. Headers 捕获（claudeRelayService.js）
- 在请求成功（200/201）后自动捕获客户端 headers
- 提取 Claude Code 特定的 headers（x-stainless-*, x-app, user-agent 等）
- 根据版本号决定是否更新存储

### 2. Headers 存储（Redis）
- Key: `claude_code_headers:{accountId}`
- 数据结构:
```json
{
  "headers": {
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "60",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.55.1",
    "x-stainless-os": "Windows",
    "x-stainless-arch": "x64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v20.19.2",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/1.0.57 (external, cli)",
    "accept-language": "*",
    "sec-fetch-mode": "cors"
  },
  "version": "1.0.57",
  "updatedAt": "2025-01-22T10:00:00.000Z"
}
```
- TTL: 7天自动过期

### 3. Headers 使用（openaiClaudeRoutes.js）
- OpenAI 格式转发时，根据选定的 Claude 账号获取对应的 headers
- 自动添加完整的 beta headers 以支持 Claude Code 功能

## API 端点

### 查看所有账号的 headers
```
GET /admin/claude-code-headers
```

响应示例:
```json
{
  "success": true,
  "data": [
    {
      "accountId": "account_123",
      "accountName": "Claude Account 1",
      "version": "1.0.57",
      "userAgent": "claude-cli/1.0.57 (external, cli)",
      "updatedAt": "2025-01-22T10:00:00.000Z",
      "headers": { ... }
    }
  ]
}
```

### 清除账号的 headers
```
DELETE /admin/claude-code-headers/:accountId
```

## 默认 Headers

当账号没有捕获到 headers 时，使用以下默认值:
- claude-cli/1.0.57 (external, cli)
- x-stainless-package-version: 0.55.1
- 其他必要的 Claude Code headers

## 注意事项

1. **版本一致性**: 确保同一账号使用相同版本的 headers，避免触发风控
2. **自动更新**: 系统会自动使用更高版本的 headers 更新存储
3. **Beta Headers**: OpenAI 转发时自动添加必要的 beta headers:
   - oauth-2025-04-20
   - claude-code-20250219
   - interleaved-thinking-2025-05-14
   - fine-grained-tool-streaming-2025-05-14

## 故障排除

### Headers 未被捕获
- 检查请求是否成功（200/201 状态码）
- 确认请求包含有效的 user-agent（含 claude-cli）

### 版本未更新
- 系统只接受更高版本的 headers
- 检查新版本号是否确实高于当前存储版本

### OpenAI 转发仍报错
- 检查 beta headers 是否正确配置
- 确认账号已有存储的 headers 或默认值可用