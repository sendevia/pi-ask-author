---
id: mod-parameter-contract
type: module-design
status: draft
title: 参数声明与不可信入参边界
parent: ask-author-architecture
---

# 参数声明与不可信入参边界

`src/schema.ts`、`src/sanitize.ts`、`src/llm-texts.ts` 共同构成模型看到、并能被工具接受的那一面。

## 责任

- `schema.ts` 是入参的唯一声明：题目、选项、`showIf` 条件、题目级与表单级 `expansion`、插入位置的 TypeBox 结构；运行期类型全部由 `Static` 派生。
- `sanitize.ts` 在宿主 Schema 校验之前把入参收敛为白名单结构：兼容未按当前 Schema 书写的别名与包裹键，纠正常见字段错误，执行题目与选项数量上限。`sanitizeExpansionPayload` 处理推演回复：丢弃引用未知题目的选项追加、与既有标签重复的选项、与既有题目 ID 冲突的新题目、没有选项的生成题目。
- `llm-texts.ts` 提供面向模型的英文协议文案：工具名称、描述、参数片段、字段描述、推演系统提示词与回复封套模板。

## 边界

- 不构建表单模型：流式渲染路径可能拿到引用尚未到达题目的 `showIf`，构建会抛错。
- 只依赖 `layout.ts` 的上限与 `format.ts` 的文本工具、`texts.ts` 的文案；不导入 `model.ts` 与任何 TUI 模块。
- 字段描述里的题目与选项上限从 `layout.ts` 读取，不在文案里写数字。

## 决策

- 容错范围限定在结构形态：JSON 字符串包裹、`raw` 包装键、字段别名、纯字符串选项、空选项兜底；完全无法辨识的输入收敛为兜底标题，其余字段按缺失处理，可选性交由 Schema 裁决。
- 面向模型的文案恒为英文并在 `llm-texts.ts` 集中声明，作者界面文案另行装载，两边不共享字符串。
