---
id: mod-extension-entry
type: module-design
status: draft
title: 扩展入口与执行编排
parent: ask-author-architecture
---

# 扩展入口与执行编排

`src/index.ts` 是扩展的唯一入口，也是模块依赖图的根。

## 责任

- 注册 `ask_author` 工具（含 `renderCall` 与 `renderResult`）与 `/ask-author` 命令；命令只向作者回显用法提示。
- 编排一次执行的守卫序列：宿主信号已中止返回取消结果；`ctx.mode` 非 `tui` 返回结构化错误；表单构建失败时区分 `AdaptiveConditionError`（条件错误）与其他异常（运行期错误）；题目数量为零返回错误；声明 `expansion` 但当前会话没有可用模型返回结构化错误。
- 装配推演执行器 `createExpansionRunner`：每次调用从宿主取会话上下文与生效系统提示词——`ctx.sessionManager.buildSessionProjection()` 给出压缩感知的分支消息，`convertToLlm` 收敛为 provider 消息，`ctx.getSystemPrompt()` 与推演协议拼接为系统提示词；推演用户消息（表单进度载荷）排在历史末尾。调用走 `ctx.modelRegistry.complete`，请求选项携带当前会话标识（`ctx.sessionManager.getSessionId()`）与级联取消信号，解析回复，累计推演用量并挂到工具结果的 `usage` 字段。会话标识是 provider 侧路由的前提：`opencode` / `opencode-go` 系 provider 缺它会被服务端以 `missing_session_id` 拒绝。
- 补齐在途工具调用：推演发生在 `ask_author` 的执行期内，会话尾部带着本次调用（可能还有并行调用）而尚无结果；组装请求时为这类调用追加 `isError: false` 的占位 `toolResult`，正文说明作者正在界面作答、结果会在提交后返回，保持调用与结果相邻，`pi-ai` 的 `transformMessages` 见到同 ID 的真实结果后不再插入自己的占位。
- 推演不写回会话记录：新增题目与选项经工具结果回到主对话，请求与回复本身不入会话文件。
- 通过 `ctx.ui.custom` 把 `AskAuthorComponent` 挂载为铺满终端的覆盖层（`overlay: true` + `overlayOptions`）并获得返回值；`finally` 调用 `dispose`，兜住「组件工厂执行后、宿主接管前」的抛出路径。覆盖层不走 `blocked` 选项，作答期间不上报 OSC 7501 程序状态。

## 边界

- 依赖 `component` / `expansion` / `format` / `model` / `schema` / `sanitize` / `texts` / `tool-card` / `tool-result`，不导入任何视图模块。
- 不持有问卷语义状态，不参与排版，不注册监听器与定时器。
- 工具声明 `executionMode: "sequential"`、`exposure: "model-only"`、`annotations: { readOnlyHint: true, openWorldHint: false }`。
- `dist/index.js` 的具名导出是二次开发接口：模型类与相关类型、Schema、清洗函数、推演协议、`TEXTS`、布局常量、locale 探测与文本工具。

## 已知局限

- 仅终端可用：`ctx.mode` 非 `tui` 时直接返回结构化错误，没有面向非交互宿主的降级通道。
