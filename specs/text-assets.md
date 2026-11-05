---
id: mod-text-assets
type: module-design
status: draft
title: 几何、文本工具与语言资源
parent: ask-author-architecture
---

# 几何、文本工具与语言资源

## 责任

- `layout.ts`：布局几何（`LAYOUT_CONFIG`）、图标字形（`ICONS`）、题目与选项上限（`MAX_QUESTIONS` / `MAX_OPTIONS`）。
- `format.ts`：视口与窗口截取范围的限制、可见列宽填充、ANSI 折行、终端控制序列与 C0 字符清洗、输入法按键归一化、单行化。
- `i18n.ts`：按 `LANGUAGE` → `LC_ALL` → `LC_MESSAGES` → `LANG` → `Intl` 系统语言探测 locale，先精确匹配再匹配同族主语言；以 `en_US` 为规范结构编译全部语言模板，占位符未声明或取值种类不一致时在装载期抛出。
- `texts.ts`：把英文协议文案与当前语言界面文案合并成 `TEXTS`，派生多选标签与确认按钮文案。
- `theme.ts`：`Theme` 类型别名。
- `lang/*.json`：作者界面文案。字符串是文案，数组是文案列表，`{ "template": …, "params": […] }` 声明插值模板；`{icon.<KEY>}` 引用 `ICONS` 中的图标。

## 边界

- `layout.ts` 与 `theme.ts` 是叶层，不导入插件内任何模块。
- 宽度计算一律走 `pi-tui` 的 `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`，不用字符串长度。
- 业务层不写用户可见字符串、图标字形与几何数值，全部从这里读取。

## 决策

- 语言探测不读组件层环境变量，也不提供切换入口；缺失键回退 `en_US`。
- 语言文件里不重复声明图标字形，经 `{icon.<KEY>}` 引用同一处定义。
