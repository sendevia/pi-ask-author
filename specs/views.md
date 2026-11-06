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
- `view-question.ts`：题目页。按带序输出整页：预览区、Tab 栏、题目标题块（含可推演标记与批注入口）、选项菜单、状态与帮助栏；负责预览区高度与预览内容缓存。
- `view-summary.ts`：提交总览页。内容行、分页、提示与操作栏。
- `view-editor.ts`：补充说明编辑页。编辑目标标题、上下文、编辑框与页脚提示。

## 边界

- 只读取组件传入的只读状态；滚动位移与预览观察值通过返回值交回组件，由组件在输入路径写回。
- 不导入 `component.ts`；排版数值取自 `layout.ts`，文案取自 `texts.ts`，着色取自 `theme.ts`。
- 内容缓存以 `revision` 与视口尺寸为键，不缓存语义状态。

## 决策

- 作答页自顶向下固定带序：顶部分割线、内容预览区、Tab 栏、题目标题块、选项区、状态通知与快捷键、底部分割线。
- 预览区高度等于终端行数减去除它以外各带的实测行数（标题折行、多行选项标签、状态与帮助折行均计入），下限 `previewMinHeight`；聚焦项无可预览内容时预览区留空行，选项区不位移。
- 预览区始终横跨整行；内容超出时末行让给滚动信息行，可视行数随之减一。
- 提交总览页、补充说明编辑页与推演在途占位页没有预览内容，Tab 栏位于顶部。
- 作答页可用高度扣除 `LAYOUT_CONFIG.terminalChromeRows`（工具调用卡片占用的终端行数），否则底部快捷键与框架线会被挤出屏幕。
- 预览与总览的可视行数随终端行数分配，长内容按行分页而不截断语义。
