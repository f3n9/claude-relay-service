# API Key 编辑功能

## 功能说明

现在支持在管理后台编辑已创建的 API Key，可以修改以下参数：

- **Token 限制**：设置该 API Key 的最大 token 使用量
- **并发限制**：设置该 API Key 可同时处理的最大请求数

## 使用方法

1. **进入管理后台**
   - 登录管理后台
   - 进入 "API Keys" 标签页

2. **编辑 API Key**
   - 在 API Key 列表中找到要编辑的项
   - 点击 "编辑" 按钮（蓝色铅笔图标）
   - 在弹出的编辑框中修改参数：
     - Token 限制：输入数字，0 或留空表示无限制
     - 并发限制：输入数字，0 或留空表示无限制
   - 点击 "保存修改" 完成编辑

## 注意事项

1. **不可修改的字段**
   - API Key 名称不可修改（显示为灰色禁用状态）
   - API Key 的密钥值不可修改
   - 描述信息不可修改

2. **参数验证**
   - Token 限制和并发限制必须为非负整数
   - 0 表示无限制
   - 留空也表示无限制

3. **即时生效**
   - 修改保存后立即生效
   - 正在进行的请求不受影响
   - 新的请求将使用更新后的限制

## 技术实现

### 前端部分
- 在 API Key 列表添加编辑按钮
- ���建编辑模态框，仅显示可编辑字段
- 使用 PUT 请求更新 API Key

### 后端部分
- 更新路由只接受 tokenLimit 和 concurrencyLimit 参数
- 严格验证参数类型和范围
- 使用现有的 apiKeyService.updateApiKey 方法

### 安全性
- 需要管理员认证才能编辑
- 只允许修改限制相关参数
- 不会暴露敏感信息（如 API Key 值）

## API 接口

```
PUT /admin/api-keys/:keyId
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "tokenLimit": 1000000,
  "concurrencyLimit": 5
}
```

响应：
```json
{
  "success": true,
  "message": "API key updated successfully"
}
```

## 常见问题

**Q: 为什么不能修改 API Key 的名称？**
A: 为了保持数据一致性和避免混淆，API Key 创建后名称不可修改。

**Q: 修改限制后，已经超过限制的请求会怎样？**
A: 已经在处理中的请求不受影响，新的请求将受到新限制的约束。

**Q: 可以通过 CLI 或 API 修改吗？**
A: 目前仅支持通过管理后台修改，后续可能会添加 CLI 支持。