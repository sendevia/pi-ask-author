---
id: mod-views
type: module-design
status: draft
title: 作答页与总览页排版
parent: ask-author-architecture
---

# 作答页与总览页排版

`src/view-question.ts`、`src/view-rows.ts`、`src/view-summary.ts`、`src/view-editor.ts` 组成排版层。

## 责任

- `view-rows.ts`：选项菜单行、顶部 Tab 栏、状态通知、分割线、帮助栏、推演占位页等共享行构建器。
- `view-question.ts`：题目页。题头（含可推演标记与批注入口）、选项菜单、双栏与单栏预览、预览分页与左栏缓存。
- `view-summary.ts`：提交总览页。内容行、分页、提示与操作栏。
- `view-editor.ts`：补充说明编辑页。编辑目标标题、上下文、编辑框与页脚提示。

## 边界

- 只读取组件传入的只读状态；滚动位移与预览观察值通过返回值交回组件，由组件在输入路径写回。
- 不导入 `component.ts`；排版数值取自 `layout.ts`，文案取自 `texts.ts`，着色取自 `theme.ts`。
- 内容缓存以 `revision` 与视口尺寸为键，不缓存语义状态。

## 决策

- 双栏与单栏由终端宽度和选项是否含富内容共同判定；窄屏走单栏内联展开，富内容在菜单行内折叠。
- 预览与总览的可视行数随终端行数分配，长内容按行分页而不截断语义。
