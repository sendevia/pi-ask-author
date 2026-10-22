/**
 * @file layout.ts
 * @description 终端布局几何、图标字形与载荷上限的单一源头
 *
 * 核心架构特性：
 * - 纯常量模块，零插件内依赖；任何模块可在不装载语言资源的前提下引用布局数值与图标
 * - `LAYOUT_CONFIG` / `ICONS` / `MAX_*` 集中声明可调参数与强制上限，语言文件通过 `{icon.<键>}` 占位符引用图标
 *
 * 依赖方向：layout.ts → 无插件内依赖；被 format / schema / texts / view-rows / view-question / component 消费
 */

// ===== 终端呈现常量 =====

/** TUI 视图几何、分栏与滚动行为配置（数值项均标注单位 ms / cols / lines；分隔线条目为字符文本，不带单位） */
export const LAYOUT_CONFIG = {
  // ===== 分隔线字符 =====
  /** 双栏中间分隔符文本 */
  dividerChar: " │ ",
  /** 外层框架分割线字符（双横线） */
  dividerThick: "═",
  /** 内部内容分割线字符（单横线） */
  dividerThin: "─",

  // ===== 分栏几何 =====
  /** 中间分隔符可见宽度 (cols) */
  dividerWidth: 3,
  /** 左栏最大可见宽度 (cols) */
  leftColMax: 46,
  /** 左栏最小可见宽度 (cols) */
  leftColMin: 30,
  /** 宽屏双栏下左栏占视口比例 */
  leftColRatio: 0.42,
  /** 触发宽屏双栏的终端最小列宽 (cols) */
  splitViewMinWidth: 72,

  // ===== 滚动与翻页 =====
  /** 预览区单次翻页滚动行数 (lines) */
  previewScrollStep: 3,
  /** 窄屏单栏折叠预览区最大可见行数 (lines) */
  singlePreviewHeight: 7,
  /** 宽屏双栏右侧预览区最大可见行数 (lines) */
  splitPreviewHeight: 14,
  /** 总览页单页最大内容行数 (lines) */
  summaryPageSize: 16,
  /** 总览页单次滚动步长 (lines) */
  summaryScrollStep: 3,
  /** 菜单每页最大可见选项数 (项) */
  visibleOptionCount: 7,

  // ===== 状态提示时长 =====
  /** 底部状态通知停留时长 (ms) */
  statusDurationMs: 3000,
} as const;

/** Nerd Font 状态与操作语义图标字典（按语义分区排列；四个选择指示符自带 1 空格尾随填充以拉开与标签的间距；语言文件通过 `{icon.<键>}` 占位符引用） */
export const ICONS = {
  // ===== 状态与确认徽标 =====
  /** 取消 / 中止 */
  cancel: "󰜺",
  /** 完成与确认（结果卡片与总览页完成态） */
  check: "󰄬",
  /** 题目已完成 */
  checked: "󰐾",
  /** 题目未完成 */
  unchecked: "󰄰",
  /** 失败 */
  error: "󰅚",
  /** 补充说明 */
  note: "󰷬",

  // ===== 光标与滚动 =====
  /** 菜单行首聚焦指示 */
  cursor: "\u{e49c}",
  /** 列表与总览页向上方向提示 */
  scrollUp: "",
  /** 列表与总览页向下方向提示 */
  scrollDown: "",

  // ===== 选择指示符（自带 1 空格尾随填充） =====
  /** 多选已勾选（方括号复选框样式） */
  checkedMulti: "[󰄬] ",
  /** 多选未勾选（方括号复选框样式） */
  uncheckedMulti: "[ ] ",
  /** 单选已选中（圆括号圆钮样式） */
  checkedSingle: "(•) ",
  /** 单选未选中（圆括号圆钮样式） */
  uncheckedSingle: "( ) ",
} as const;

// ===== 载荷上限 =====

/** 单题最大选项数上限（项；同时约束 `schema.ts` 的 `options.maxItems` 与 `sanitize.ts` 的选项截断） */
export const MAX_OPTIONS = 30;

/** 单份问卷最大题目数上限（题；同时约束 `schema.ts` 的 `questions.maxItems` 与 `sanitize.ts` 的题目截断） */
export const MAX_QUESTIONS = 20;
