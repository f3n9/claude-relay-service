# Vertex 费用统计准确性改动设计稿

> 状态：Implemented（2026-03-06）
> 范围：设计 + 按设计完成实现与验证

## 0. 实施结果（2026-03-06）

1. 已完成 Vertex 流式 partial usage 兜底采集（`end/error/close/finally`，emit-once）。
2. 已完成 usage 记录的 `usageCaptureState` 持久化，用于审计完整/部分采集。
3. 已完成管理端 usage records API 双口径输出（`real/rated/display`）并保留兼容字段。
4. 已完成管理端两处 usage records 页面和详情弹窗口径治理，默认展示真实费用并显示额度费用。
5. 已通过关键后端测试与前端构建验证；当前残留仅为仓库既有 `no-console` 告警，不影响构建。

## 1. 背景与问题

在 `claude-vertex` 账户场景下，服务侧统计费用显著低于 GCP 控制台（约 1/3）。

已定位到两类问题：

1. 流式请求在中断/异常场景存在 usage 漏记，导致 Token 与费用真实缺失。
2. 多处页面与接口默认展示 `ratedCost`（倍率后费用），而不是 `realCost`（真实上游费用），会与云厂商账单天然不一致。

## 2. 目标与非目标

### 2.1 目标

1. 让“对账视图”默认可直接对齐 GCP 真实账单（`realCost` 口径）。
2. 降低 `claude-vertex` 流式 usage 漏记概率（尤其是客户端提前断开时）。
3. 保持“限额/配额”逻辑仍可基于 `ratedCost` 运行，不破坏现有业务规则。

### 2.2 非目标

1. 不在本次改动中调整模型单价源和定价策略本身。
2. 不引入复杂离线补账系统（仅预留补账接口与脚本位）。
3. 不改变现有 API Key 鉴权、调度、路由选择逻辑。

## 3. 现状数据流（简化）

1. Vertex 流式：`gcpVertexRelayService` 解析 SSE，`message_start` 收集 input/cache，`message_delta` 收集 output，结束时回调 usage。
2. 记账：`apiKeyService.recordUsageWithDetails` 同时计算并写入：
   - `realCost`（真实成本）
   - `ratedCost`（真实成本 × 全局倍率 × key倍率）
3. 展示：部分管理接口/页面读取 `usage:cost:*`（rated）作为“总费用”。

结论：既有“漏记”，也有“口径差异”。

## 4. 方案对比

### 方案 A：只改展示口径（默认显示 real）

改动点：
- 管理端与对账相关接口默认返回 `realCost`，同时保留 `ratedCost`。
- 前端显式双列展示“真实费用 / 额度费用”。

优点：
- 风险低，改动小，能立即解释“1/3 差异”。

缺点：
- 流式漏记仍在，真实成本仍可能偏低。

### 方案 B：只修流式漏记

改动点：
- Vertex 流式在 `close/error/finally` 做 partial usage 上报兜底。

优点：
- 直接改善漏记。

缺点：
- 若界面仍默认看 rated，用户仍会感觉与 GCP 不一致。

### 方案 C（推荐）：双修（漏记 + 口径）

改动点：
- 同时做 A + B。
- 对“默认展示口径”做明确切换策略。

优点：
- 同时解决“数据真的少记”和“看起来不一致”两类问题。

缺点：
- 变更面更大，需要补全测试和灰度开关。

## 5. 推荐设计（方案 C）

## 5.1 流式 usage 采集可靠性改造（Vertex）

### 设计要点

1. 维持现有 SSE 聚合逻辑，但引入“终态兜底上报”：
   - 在 `end` 保持现状上报；
   - 在 `error/close/finally` 若已收集到 `input_tokens`，也触发一次上报；
   - `output_tokens` 缺失时以 `0` 或最后一次已知值上报。
2. 防重：增加 `usageEmitted` 标记，保证每请求最多落库一次。
3. 标记来源：在 usage 对象增加 `usage_capture_state`：
   - `complete`（含 output）
   - `partial`（仅 input/cache）
4. 日志结构化：追加 requestId、accountId、captureState、tokens 快照，便于追查。

### 兼容约束

1. 仍坚持“只用官方返回 usage，不做估算 token”原则。
2. partial 仅用于减少漏记，不做推断 output。

## 5.2 成本口径治理（real vs rated）

### 设计要点

1. 明确语义：
   - `realCost`: 对账成本（默认给管理端看）
   - `ratedCost`: 额度成本（限额/计费策略内部使用）
2. 后端接口统一返回双字段，避免前端自行猜测：
   - `costReal`
   - `costRated`
   - `costDisplay`（默认取 real，用于旧前端兼容）
3. 管理端页面统一：
   - 卡片“总费用”默认显示 `real`
   - 辅助展示“额度费用(rated)”
   - Tooltip 标注“额度费用受服务倍率影响，可能与云厂商账单不一致”

### 默认策略

1. 对账相关页面与导出：默认 real。
2. 限额配置/消耗进度条：继续 rated（现有逻辑不动）。

## 5.3 配置与开关

新增系统配置（建议）：

1. `billing.displayCostMode`：`real | rated`（默认 `real`）
2. `billing.vertexPartialUsageEnabled`：`true|false`（默认 `true`）

目的：支持灰度切换与回滚。

## 5.4 数据模型与迁移

现有存储已具备 `realCost` 与 `ratedCost`，无需强制迁移。

可选增强：

1. usage record 增加 `usageCaptureState` 字段（仅新增，不影响旧数据读取）。
2. 提供一次性“对账修复脚本（可选）”：
   - 仅针对指定时间窗导出 `partial` 请求列表供人工核对；
   - 不自动补写 output，避免伪精确。

## 6. 接口影响（向后兼容）

## 6.1 管理 API

涉及接口（示例）：

1. API Key usage records
2. Account usage records
3. Dashboard/API Stats 总览

变更策略：

1. 保留旧字段 `cost`（兼容），但语义文档改为“展示口径（默认 real）”。
2. 增加明确字段：
   - `realCost`
   - `ratedCost`
   - `displayCostMode`

## 6.2 前端

1. 页面文案从“总费用”细化为：
   - “真实费用（对账）”
   - “额度费用（倍率后）”
2. 详情弹窗总计与分项统一同一口径（避免分项 real、总计 rated 混用）。

## 7. 测试策略

## 7.1 单元测试

1. Vertex 流式：
   - `end` 正常路径只落库一次
   - `close` 早于 `end` 时仍落一次 partial
   - `error` 后仍可 partial 落库
   - 重复事件不重复落库
2. 成本口径：
   - same usage 下 `real != rated` 场景断言返回字段正确。

## 7.2 路由/集成测试

1. `/v1/messages` + `claude-vertex` 流式断开场景，校验 usage callback 与记录行为。
2. 管理端 usage 接口返回 real/rated/display 三字段一致性。

## 7.3 回归测试

1. `claude-official/claude-console/bedrock/ccr` 统计不回退。
2. rate limit 与 weekly cost limit 行为保持不变。

## 8. 观测与验收

## 8.1 新增观测指标

1. `vertex_stream_usage_capture_total{state=complete|partial|none}`
2. `vertex_stream_client_abort_total`
3. `billing_display_mode_usage_total{mode=real|rated}`

## 8.2 验收标准

1. 上线后 3-7 天，Vertex 渠道“服务 realCost 与 GCP 控制台”的偏差显著收敛。
2. `partial` 占比可解释且稳定，`none` 占比下降。
3. 管理端用户不再把 rated 当作对账成本。

## 9. 风险与回滚

## 9.1 风险

1. partial 上报可能引入“低估 output”的新统计形态（但优于完全漏记）。
2. 页面口径切换可能影响历史运营认知。

## 9.2 回滚策略

1. 关闭 `billing.vertexPartialUsageEnabled`，恢复仅 complete 上报。
2. 切换 `billing.displayCostMode=rated`，恢复旧展示行为。
3. 存量数据不迁移，回滚无数据破坏风险。

## 10. 实施顺序建议

1. 第一步：先改“展示口径治理”（低风险、快速消除认知偏差）。
2. 第二步：再改“Vertex 流式兜底上报”（补测试后灰度）。
3. 第三步：上线后对账复盘，决定是否补做导出型修复脚本。

---

如果你认可这个设计稿，我下一步可以基于它输出一份“逐步实施计划”（含精确文件、测试用例和分批提交策略），再开始改代码。
