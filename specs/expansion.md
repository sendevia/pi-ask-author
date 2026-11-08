---
id: mod-expansion
type: module-design
status: draft
title: 实时推演协议
parent: ask-author-architecture
---

# 实时推演协议

`src/expansion.ts` 定义扩展与推演模型之间的请求与回复形态。

## 责任

- 声明 `ExpansionRequest` 与 `ExpansionRunner`：执行器接收请求与 `AbortSignal`，返回清洗后的载荷。
- `buildExpansionUserMessage` 把表单当前进度组装成用户消息：问卷标题与描述、生效的 `guidance` 与 `insert`、剩余题数、`trigger`（刚确认的题目），以及每题的序号、属性、`showIf`、推演配置与已追加计数、显隐、`status`、可见选中项标签、题目批注与选项批注。模型据此接着现有进度续写，不重复既有决策。
- 推演请求的上下文由宿主会话提供：历史消息是作者真实的写作现场，表单载荷是此刻的真实进度，两者合起来才是模型看到的全部信息。
- `parseExpansionReply` 从回复文本提取 JSON，再交给 `sanitizeExpansionPayload` 过滤非法追加项。
- `expansionContext` 从当前题目快照派生清洗所需的上下文（已知题目 ID 与既有标签）。

## 边界

- 不调用模型：模型调用在入口层装配，会话历史与系统提示词同样在入口层取得，本模块只处理请求与回复的数据形态。
- 不修改表单状态：写入走 `AskAuthorFormModel.pushExpansion`。
- 依赖 `sanitize` / `schema` / `model` / `texts`，不依赖 `component` 与视图模块。

## 决策

- 推演只在作者确认一道题目时触发，切页前发起，新增题目紧接被确认的题目。
- 回复一律按不可信内容处理：解析失败与过滤后为空都按失败处理，整批丢弃。
