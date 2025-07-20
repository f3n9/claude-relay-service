# Changelog

所有重要的更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且该项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- API Key 时间窗口限流功能
  - 支持设置时间窗口（分钟）和请求次数限制
  - 时间窗口内达到 Token 限制或请求次数限制任一条件即触发限流
  - 限流时显示友好的错误提示，包含重置时间
  - 时间窗口从首次请求开始计时，到期后自动重置

### 变更
- 移除 API Key 累计总量限制，保留仅基于时间窗口的限制机制
- 优化前端 UI，明确 Token 限制为时间窗口内的限制

### 修复
- 修复自动发布工作流的 YAML 语法错误
- 修复 git-cliff 安装路径错误

### 其他
- 移除原始 SSE chunk 日志记录，减少日志噪音

## [1.1.2] - 2025-07-19

### 新增
- Telegram 自动通知功能
- 自动版本发布功能
- API Key 模型限制功能
  - 支持为每个 API Key 设置可访问的模型列表
  - 在请求转发时自动检查模型权限

### 修复
- 修复 API Key 模型限制功能不生效的问题
- 修复自动发布工作流配置

### 其他
- 优化 changelog 显示，移除 [unreleased] 标记

## [1.1.0] - 2025-07-19

### 新增
- Docker Hub 自动构建功能
- 改进部署体验，自动处理配置文件复制和密钥生成
- 改进管理界面弹窗体验和滚动条美化

### 修复
- 修复长上下文请求超时问题
- 彻底解决 Docker 权限问题
  - 简化为 root 用户运行
  - 预先创建配置文件
  - 确保 data 目录可写
- 修复管理界面用户菜单 z-index 层级问题
- 统一管理员密码管理机制，以 init.json 为唯一数据源

### 文档
- 更新 README.md 文档

## [1.0.1] - 2025-07-17

### 新增
- Claude 账户专属绑定功能
  - 支持将 API Key 绑定到特定的 Claude 账户
  - 实现共享账户和专属账户的分离管理
- 管理员账户信息修改功能
  - 支持修改用户名和密码
  - 改进用户菜单显示和真实用户名显示

### 修复
- 修复非流式响应 JSON 解析错误和 max_tokens 参数校验
- 修复管理界面用户菜单 z-index 层级问题
- 改进 socket hang up 和网络错误处理机制
- 修复用户界面显示问题
- 统一仪表盘 Token 消耗费用计算逻辑

### 变更
- 简化 CLI 工具管理命令
- 优化 SSL 证书获取推荐和 token 刷新机制

## [1.0.0] - 2025-07-16

### 新增
- 完整的 Claude API 中转服务
- 多账户管理系统
  - OAuth 2.0 授权流程
  - 自动 token 刷新机制
  - 智能账户选择和负载均衡
- API Key 管理
  - 生成和管理 API Keys
  - Token 使用量限制和统计
  - 并发控制功能
- 代理支持
  - SOCKS5 代理
  - HTTP/HTTPS 代理
  - 每个账户独立代理配置
- Web 管理界面
  - 实时仪表板
  - API Key 管理
  - Claude 账户管理
  - 系统日志查看
- CLI 管理工具
  - 管理员操作
  - API Key 管理
  - 账户管理
  - 系统状态查看
- 安全特性
  - JWT 认证
  - 数据加密存储
  - API Key 哈希存储
  - User-Agent 安全转发
- 监控和日志
  - 结构化日志系统
  - 使用统计追踪
  - 实时性能监控
- Redis 集成
  - TLS 支持
  - 数据持久化
  - 高性能缓存
- Docker 支持
  - 完整的 docker-compose 配置
  - 健康检查
  - 自动重启

### 特性
- 流式和非流式响应支持
- 智能 sticky 会话保持
- 自动限流检测和恢复
- 完整的 Token 使用统计（输入、输出、缓存创建、缓存读取）
- 模型定价配置
- 并发请求控制
- 请求超时处理
- 客户端断开检测

### 文档
- 完整的 README 文档
- 详细的部署指南
- API 使用说明
- 配置说明

## [0.1.0] - 2025-07-14

### 初始版本
- 项目初始化
- 基础架构搭建

---

[Unreleased]: https://github.com/Wei-Shaw/claude-relay-service/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/Wei-Shaw/claude-relay-service/compare/v1.1.0...v1.1.2
[1.1.0]: https://github.com/Wei-Shaw/claude-relay-service/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Wei-Shaw/claude-relay-service/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Wei-Shaw/claude-relay-service/compare/a96a372...v1.0.0
[0.1.0]: https://github.com/Wei-Shaw/claude-relay-service/releases/tag/a96a372