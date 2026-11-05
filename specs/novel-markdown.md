---
id: mod-novel-markdown
type: module-design
status: draft
title: 小说语法高亮
parent: ask-author-architecture
---

# 小说语法高亮

`src/novel-syntax.ts` 与 `src/novel-markdown.ts` 负责让作者在终端里直接审视正文草稿的行文节奏与语感。

## 责任

- `novel-syntax.ts`：以声明式模板表定义台词与心理旁白的定界符、语义哨兵、最大跨距与主题绘制函数，并派生「开定界符 → 模板」与「哨兵 → 模板」两个索引。
- `novel-markdown.ts`：把预览文本里的台词与心理旁白转换为携带语义哨兵的行内代码，配定制 Markdown 主题渲染；`buildFullPreviewContentLines` 产出题目页预览所需的内容行。

## 边界

- 不持写作答状态，不参与键盘路由。
- 依赖 `format` 的文本清洗、`novel-syntax` 的模板表、`texts` 的文案与 `theme` 类型；不导入 `component.ts`。

## 决策

- 解析与渲染复用宿主的 `Markdown`，语法着色通过主题钩子完成，自带一套 Markdown 解析器属于禁止事项。
- 哨兵由不可见 NUL 前缀加单字符标记组成（`d` 台词、`m` 心理旁白），只在字符串变换与主题分类之间短暂存在；输入侧的控制字符已在 `format.ts` 边界剥离，哨兵不进入终端输出。
- 模板表当前覆盖两对定界符：`「」` 台词以强调色着色，`（）` 心理旁白以柔和色叠加斜体；单个跨距超过 400 字符视为残缺定界符并放弃高亮。
