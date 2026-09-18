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
`{ models: [...] }`。保留上游明确声明的推理配置，缺失时按下表补充。
上游只有标准模型 ID 时，补充 Codex 基础协议字段、推理选项及已公开确认的输入模态；
不推测上下文窗口或工具能力；
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

## 自动补充推理选项

仅补充模型目录中的 `supported_reasoning_levels` 和 `default_reasoning_level`，
不修改 Responses 请求中的 `reasoning.effort`。客户端选择后仍由后端验证参数。
以下能力范围于 **2026-09-05** 核对 OpenAI 官方公开模型页：

| 模型 ID（完整匹配） | 支持的 effort | 目录默认值 |
| --- | --- | --- |
| `gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` | `medium`（本服务选定） |
| `gpt-5.6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `gpt-5.6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `gpt-5.5` | `none`, `low`, `medium`, `high`, `xhigh` | `medium` |
| `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` | `none` |
| `gpt-5.3-codex` | `low`, `medium`, `high`, `xhigh` | `medium`（采用官方指南建议） |
| `gpt-image-2` | 无公开 reasoning effort 选项（空数组） | `null` |
| 其他模型 | `medium` | `medium`（通用兜底） |

来源：

- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.5
- https://developers.openai.com/api/docs/models/gpt-5.4
- https://developers.openai.com/api/docs/models/gpt-5.3-codex
- https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide

Astra 模型页列出了支持范围，但未明确默认值，因此本服务选择 `medium`；Codex 指南建议
交互编程使用 `medium`，不将其标为已确认的 Azure 默认值。其他五个型号的默认值来自模型页。
未加入公开 API 模型页未声明的 `ultra` 等档位。

上游能力声明优先，包括明确的空选项数组或 `null` 默认值。若上游只给出支持范围，
缺失的默认值会从该范围内选择；不会添加上游未声明的额外档位。
标准 `data` 列表保持原样，补充信息只放在返回的 Codex `models` 条目中。

Azure 自定义部署名称、日期后缀和未列出的型号不会按前缀猜测能力，而是使用通用兜底。
兜底 `medium` 仅是服务提供的客户端选项，不保证任意模型都接受 reasoning 参数。
公开 API 支持范围也不保证每个 Azure 部署版本一致；实际部署须支持客户端选择的档位。

### GPT Image 2

于 2026-09-05 核对官方模型页、Images API 参数说明及图片生成指南，未发现
`gpt-image-2` 公开可配置的 `reasoning.effort` / `reasoning_effort` 档位。
因此显式返回 `supported_reasoning_levels: []`、`default_reasoning_level: null`，
不采用未知模型的 `medium` 兜底。这表示目录不宣称可选推理档位，不代表模型内部没有推理能力。

图片 API 提供的是 `quality: low | medium | high | auto`，默认 `auto`，不能当作 reasoning 档位。
通过 Codex Responses 图片工具生成图片时，外层文本模型的 reasoning 与图片工具的 quality
是独立参数；本次目录配置不修改图片请求。上游明确声明的能力元数据仍然优先。

来源：

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/guides/image-generation

## 自动补充输入模态

于 **2026-09-18** 核对官方模型页、文件/音频指南和 Codex 协议。标准 OpenAI/Azure
模型列表经转换后，不再一律声明 `input_modalities: ["text"]`：

| 已确认的模型 | 补充的 `input_modalities` |
| --- | --- |
| `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、官方别名 `gpt-5.6` | `["text", "image"]` |
| `gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、`gpt-image-2` | `["text", "image"]` |
| `gpt-5`、`gpt-5-mini`、`gpt-5-nano`、`gpt-5.1`、`gpt-5.2` | `["text", "image"]` |
| `gpt-4.1`、`gpt-4.1-mini`、`gpt-4.1-nano`、`gpt-4o`、`gpt-4o-mini` | `["text", "image"]` |
| `gpt-audio`、`gpt-audio-mini` | `["text", "audio"]` |
| `gpt-realtime`、`gpt-realtime-mini` | `["text", "image", "audio"]` |

同时支持上述模型页列出的已核实快照名，例如 `gpt-5.4-2026-03-05`、
`gpt-5.5-2026-04-23`、`gpt-image-2-2026-04-21`；具体映射在
`src/utils/openaiModelModalities.js`。只做完整 ID 匹配，不给任意后缀或 Azure 自定义部署名猜测能力。

处理规则：

- 上游明确的 `input_modalities` 数组优先，包含空数组和仅文本配置。标准 `data` 条目中的
  模态扩展也会保留到 Codex `models` 条目，避免被固定 `text` 覆盖。
- 上游缺失模态且模型已核实：无论原生 `models` 还是标准 `data`，均补充已知能力。
- 未知标准模型缺失模态：保持仅文本；未知原生 Codex 模型缺失模态：保留省略字段的旧行为，
  由客户端应用默认值。自定义多模态部署可以由上游明确返回 `input_modalities`。
- 标准 `data` 列表、模型 ID、展示规则、推理配置及账户调度保持原有行为。本服务不下载附件，
  不因为发现模型支持某种模态而新增相应 API 路由。

### 图片、文档与语音的边界

Codex 的模态枚举为 `text`、`image`、`audio`，没有 `document`、`file`、`pdf` 或 `video`。
不要将这些文件类别加入 `input_modalities`，否则客户端可能无法解析整个目录。
本机 ChatGPT 26.915.31029 的图片控件会检查 `inputModalities.includes("image")`；修正目录
可以解除由错误的仅文本声明导致的图片附件禁用，客户端需要刷新其模型目录缓存。

- **图片**：视觉模型通过 Responses 的 `input_image` 接收。`gpt-image-2` 的图像输入主要用于
  Images 编辑接口；它不是可直接作为外层模型调用 `/responses` 的通用对话模型。本服务现有
  `/images/generations` 不等同于图片编辑接口，目录元数据不表示已新增 `/images/edits`。
- **文档**：使用 Responses 的 `input_file`。官方 API 对 PDF 提取文字和页面图像，非 PDF
  文档主要提取文字；因此视觉模型应声明 `text,image`，不新增 `document` 模态。
  本服务保留内联 `file_data`、`file_url` 和 `file_id`；实际支持的文件类型仍由 Azure 部署决定。
  使用 `file_id` 时须由选中后端可访问；本服务尚未提供 OpenAI Files 上传路由。
  桌面端的本地文件工具、云端文件上传和模型输入是不同处理路径，不能只凭目录保证所有附件可用。
- **语音**：上述 GPT-5/5.6/6 视觉模型公开的是文本和图片输入，不将原始音频能力强行加给它们。
  `gpt-audio` 需要 Chat Completions 音频输入路径，`gpt-realtime` 需要 Realtime 会话路径；
  本服务当前 `/openai` 的对话转发走 Responses，尚未提供原生音频 Chat Completions、
  转写或 Realtime 转发。目录声明只描述模型，不会打通这些链路。
  桌面听写、实时语音还可能调用客户端独立服务，不能仅靠增加模态字段启用。

验证包含标准/原生目录、双路由 HTTP 返回、上游模态优先、展示过滤、旧模型兼容，以及
Responses 中图片和文件内容在开启/关闭直通及 Codex 适配时不丢失。未使用真实 Azure 凭据
验证图片识别、文档解析或音频推理；元数据与本地模拟转发测试不代表这些端到端功能已验证。

公开来源（前八个模型页见上文，此处补充其他型号与协议说明）：

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/models/gpt-5
- https://developers.openai.com/api/docs/models/gpt-5-mini
- https://developers.openai.com/api/docs/models/gpt-5-nano
- https://developers.openai.com/api/docs/models/gpt-5.1
- https://developers.openai.com/api/docs/models/gpt-5.2
- https://developers.openai.com/api/docs/models/gpt-4.1
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/models/gpt-4.1-nano
- https://developers.openai.com/api/docs/models/gpt-4o
- https://developers.openai.com/api/docs/models/gpt-4o-mini
- https://developers.openai.com/api/docs/models/gpt-audio
- https://developers.openai.com/api/docs/models/gpt-audio-mini
- https://developers.openai.com/api/docs/models/gpt-realtime
- https://developers.openai.com/api/docs/models/gpt-realtime-mini
- https://developers.openai.com/api/docs/guides/file-inputs
- https://developers.openai.com/api/docs/guides/audio-chat-completions
- https://developers.openai.com/codex/app-server
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs
