---
id: mod-interaction
type: module-design
status: draft
title: 交互组件与键盘状态机
parent: ask-author-architecture
---

# 交互组件与键盘状态机

`src/component.ts` 的 `AskAuthorComponent` 是 `ctx.ui.custom` 挂载的那个组件。

## 责任

- 键盘事件路由与状态机：页面循环切换、数字跳转、菜单光标、预览与总览滚动、多选全选、补充说明编辑模式、`Esc` 二次确认。
- 内置 `Editor` 集成：透传 `Focusable` 以定位输入法候选框；无输入框的页面把全角输入法字符收敛为半角，使 `【` / `】` 与全角字母同样命中快捷键。
- 自适应导航：Tab 循环、数字跳转与确认推进沿可见题目序列行走，被条件隐藏的题目直接跳过。
- 推演编排：`confirmAndAdvance` 前发起请求；答案签名未变则复用既有记录，签名变化先 `retractFrom` 再请求；在途期间当前页 Tab 标题与整页内容换成占位，除取消键外忽略输入；只采纳最新请求，中止与卸载一并作废在途请求。
- 缓存：整屏帧按尺寸键与状态突变失效，Tab 栏与菜单项按 `revision` 失效，视图层内容缓存由 `touchDerived` 统一清空。
- 取消与回收：`Esc` / `Ctrl+C` 与宿主 `AbortSignal` 双通道取消；`dispose` 幂等，释放计时器、`AbortSignal` 监听器与缓存池。

## 边界

- 只经模型的读接口判断显隐与选中（`getVisibleQuestionIndices` / `isQuestionVisible` / `isOptionVisible` / `getSelectedIndex` / `getSelectedIndices`），不重算条件。
- 排版全部委托 `view-*`；不直接书写界面文案与几何数值。
- `render` 及其可达函数不写语义状态；滚动位移的归一化只发生在输入路径，透明备忘缓存不在禁止之列。

## 决策

- `dispose` 只设置卸载标记，不用它阻断 `done`：资源已回收但完成回调尚未投递时仍须结算；`finish` 以完成标记保证回调至多投递一次。
- 焦点在题目与选项之间切换时只清空左栏缓存，已解析的预览内容保留复用。
