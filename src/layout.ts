/**
 * @file layout.ts
 * @description 终端布局几何、图标字形与载荷上限的常量声明
 *
 * 纯常量叶层，无插件内依赖；语言文件经 `{icon.<键>}` 引用图标
 */

/** 视图几何与滚动行为配置（数值项标注单位） */
export const LAYOUT_CONFIG = {
  // ===== 分隔线字符 =====
  /** 外层框架分割线字符（双横线） */
  dividerThick: "═",
  /** 内部内容分割线字符（单横线） */
  dividerThin: "─",

  // ===== 视口几何 =====
  /** Tab 自定义短标签的最大可见宽度 (cols)，超出由 `truncateToWidth` 截断 */
  tabLabelMaxWidth: 14,

  // ===== 滚动与翻页 =====
  /** 预览区单次滚动行数 (lines) */
  previewScrollStep: 3,
  /** 预览区最小可见行数 (lines)；预览区占满剩余高度，不足此值时整页溢出终端 */
  previewMinHeight: 3,
  /** 总览页单次滚动行数 (lines) */
  summaryScrollStep: 3,
  /** 菜单每页最多可见的选项数 */
  visibleOptionCount: 7,

  // ===== 状态提示时长 =====
  /** 底部状态通知停留时长 (ms) */
  statusDurationMs: 3000,
} as const;

/** Nerd Font 图标字典（语言文件经 `{icon.<键>}` 引用；四个选择指示符自带 1 空格尾随填充） */
export const ICONS = {
  // ===== 状态与确认徽标 =====
  /** 取消与中止 */
  cancel: "󰜺",
  /** 完成与确认 */
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
  /** 向上滚动提示 */
  scrollUp: "󰁝",
  /** 向下滚动提示 */
  scrollDown: "󰁅",

  // ===== 选择指示符（自带 1 空格尾随填充） =====
  /** 多选已勾选 */
  checkedMulti: "[󰄬] ",
  /** 多选未勾选 */
  uncheckedMulti: "[ ] ",
  /** 单选已选中 */
  checkedSingle: "(•) ",
  /** 单选未选中 */
  uncheckedSingle: "( ) ",
} as const;

// ===== 载荷上限 =====

/** 单题选项数上限，同时约束 `schema.ts` 与 `sanitize.ts` 的截断 */
export const MAX_OPTIONS = 30;

/** 问卷题目数上限，同时约束 `schema.ts` 与 `sanitize.ts` 的截断 */
export const MAX_QUESTIONS = 20;
