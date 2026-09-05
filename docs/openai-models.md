# OpenAI / Codex 模型发现

`GET /openai/models` 和 `GET /openai/v1/models` 使用与 Responses 相同的 API Key
鉴权、OpenAI 权限检查及账户调度逻辑。支持专属账户、分组和共享池；返回本次选中账户的
上游模型目录，不聚合整个池，也不使用静态模型表兜底。

```bash
curl 'http://localhost:3000/openai/models?api-version=2025-04-01-preview&client_version=0.153.4' \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

- ChatGPT OAuth 账户：访问 `https://chatgpt.com/backend-api/codex/models`，使用账户的
  access token 和 ChatGPT account ID，并复用 token 刷新及代理配置。
- OpenAI-Responses 账户：在 `baseApi` 上拼接 `/models` 或 `/v1/models`，与请求路径一致，
  避免重复 `/v1`。例如 `baseApi=https://host/openai` 对应 `/openai/models`，
  `baseApi=https://host/v1` 对应 `/v1/models`。公共 `api.openai.com` 始终使用 `/v1/models`。
- `client_version` 会传给上游。兼容提供商的 `api-version` 使用账户配置；公共 OpenAI 和
  ChatGPT OAuth 不附加该参数。客户端的 API Key 和 Cookie 不会转发给上游。

响应同时包含标准 OpenAI 的 `{ object: "list", data: [...] }` 和 Codex 的
`{ models: [...] }`。原生 Codex 条目的上下文窗口、推理级别及其他元数据原样保留。
上游只有标准模型 ID 时，补充 Codex 基础协议字段，不推测上下文窗口、推理级别或工具能力；
模型 ID 可发现不代表上游保证该模型支持 Responses 或所有 Codex 工具。

列表会排除 API Key 的 `restrictedModels` 黑名单（启用模型限制时），并遵循 OAuth
账户的 `supportedModels` 限制。响应不缓存，避免不同 Key 或账户共享目录。

无可调度账户时返回调度器错误；上游拒绝访问或不提供 models 接口时返回对应 HTTP 错误。
超时返回 504，网络错误、重定向或非法目录返回 502。这些发现错误不会自动禁用推理账户。
无需新增配置；部署后仍需使用实际 Key 验证上游是否支持模型发现。

## 账户模型展示规则

新增或编辑 OpenAI OAuth / OpenAI-Responses 账户时，可填写「模型列表展示规则」。
每行一条，也支持逗号分隔，例如：

```text
gpt-5
gpt-5.6-*
```

- 完整匹配：`gpt-5` 不包含 `gpt-5.1`，区分大小写。
- 通配匹配：只有 `*` 是通配符，表示零个或多个字符；其他字符按字面匹配。
- 多条规则命中任意一条即可保留；全部不命中时返回空列表。
- 留空或清空规则时返回全部上游模型（仍受 API Key 黑名单、账户 supportedModels 限制）。
- 仅过滤 `/openai/models` 和 `/openai/v1/models`，不改写模型 ID，也不改变推理权限或调度。

管理 API 字段为 `modelDiscoveryPatterns`（字符串数组），例如
`["gpt-5", "gpt-5.6-*"]`。更新时省略字段会保留原值，传 `[]` 清空。
最多 100 条规则，每条最多 200 个字符。已有账户无需迁移，默认不限制展示。
