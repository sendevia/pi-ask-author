---
id: mod-tool-results
type: module-design
status: draft
title: 工具结果与回放卡片
parent: ask-author-architecture
---

# 工具结果与回放卡片

`src/tool-result.ts` 与 `src/tool-card.ts` 是工具与宿主之间的两个出口：结果回给模型，卡片回给作者。

## 责任

- `tool-result.ts`：完成、取消、结构化错误、运行期异常四类结果工厂，向模型输出固定封套（`[Author Decision Finalized]`、`[Author Decision Cancelled]`、`[Author Consultation Error]`）；完成封套在作答行之后附上整卷补充行，并同步写入结果详情的 `supplement`；失败类别同时设置 `isError: true`，`content` 保留原因行与纠正指引。`narrowResultDetails` 是 `renderResult` 收到的不可信 `details` 的唯一收窄点。
- `tool-card.ts`：会话回放的调用卡片与结果卡片渲染。调用摘要与执行路径共用 `sanitizeAskAuthorArgs`，按 args 对象身份记忆化派生数据；展开态明细在逐题答案之后追加整卷补充行。

## 边界

- 不导入 `index.ts`；渲染路径不构建表单模型，只做入参清洗与计数。
- 依赖 `model` 的类型与封套文本、`sanitize`、`schema`、`texts`、`theme`。

## 决策

- 封套前缀保持字节稳定，提升模型前缀缓存命中率；整卷补充作为末行令牌追加，无补充时封套与既有格式逐字节一致。
- 失败结果保留面向模型的纠正指引，让模型能改参重试，无需阅读界面报错。
