/**
 * @file layout.ts
 * @description 终端布局几何、图标字形与载荷上限的单一源头
 *
 * 核心架构特性：
 * - 纯常量模块，零插件内依赖；任何模块可在不装载语言资源的前提下引用布局数值与图标
 * - `LAYOUT_CONFIG` / `ICONS` / `MAX_*` 集中声明可调参数与强制上限，语言文件通过 `{icon.<键>}` 占位符引用图标
 * - 作答页纵向分带（预览区占满剩余高度）的几何全部由此处取值，视图层只负责按带序输出
 *
 * 依赖方向：layout.ts → 无插件内依赖；被 format / schema / texts / view-rows / view-question / component 消费
 */

// ===== 终端呈现常量 =====

/** TUI 视图几何与滚动行为配置（数值项均标注单位 ms / cols / lines；分隔线条目为字符文本，不带单位） */
export const LAYOUT_CONFIG = {
  // ===== 分隔线字符 =====
  /** 外层框架分割线字符（双横线） */
  dividerThick: "═",
  /** 内部内容分割线字符（单横线） */
  dividerThin: "─",

  // ===== 视口几何 =====
  /** Tab 栏自定义短标签的最大可见宽度 (cols)；超出部分由 `truncateToWidth` 截断 */
  tabLabelMaxWidth: 14,

  // ===== 滚动与翻页 =====
  /** 预览区单次翻页滚动行数 (lines) */
  previewScrollStep: 3,
  /** 内容预览区最小可见行数 (lines)；预览区占满终端剩余高度，不足此值时页面整体溢出终端 */
  previewMinHeight: 3,
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
  cursor: "󰁔",
  /** 列表与总览页向上方向提示 */
  scrollUp: "󰁝",
  /** 列表与总览页向下方向提示 */
  scrollDown: "󰁅",

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
