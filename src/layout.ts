/**
 * @file layout.ts
 * @description 终端布局几何、图标字形与载荷上限的常量声明
 *
 * 纯常量叶层，无插件内依赖；语言文件经 `{icon.<键>}` 引用图标
 */

/** 视图几何与滚动行为配置（数值项标注单位） */
export const LAYOUT_CONFIG = {
  // ===== 分隔线字符 =====
  /** 内部内容分割线字符（单横线） */
  dividerThin: "─",

  // ===== 按钮框架字符 =====
  /** 按钮框架字符（上缘单横线、下缘粗横线、两侧竖线） */
  buttonFrame: { topLeft: "┌", top: "─", topRight: "┐", side: "│", bottomLeft: "┕", bottom: "━", bottomRight: "┙" },

  // ===== 视口几何 =====
  /** Tab 自定义短标签的最大可见宽度 (cols)，超出由 `truncateToWidth` 截断 */
  tabLabelMaxWidth: 14,

  // ===== 滚动与翻页 =====
  /** 预览区单次滚动行数 (lines) */
  previewScrollStep: 3,
  /** 内容区最小可见行数 (lines)；内容区吸收剩余高度，不足此值时整页溢出终端 */
  contentMinHeight: 3,
  /** 总览页单次滚动行数 (lines) */
  summaryScrollStep: 3,
  /** 菜单每页最多可见的选项数 */
  visibleOptionCount: 7,
  /** 补充说明按钮的左侧缩进 (cols) */
  noteButtonIndent: 2,
  /** 左侧按钮旁边留给文字的最小列数 (cols)；不足时按钮与文字上下堆叠 */
  leadingTextMinWidth: 8,
  /** 按钮共享同一行时允许被压缩到自然宽度的比例；低于此比例就另起一行 */
  buttonShareShrinkRatio: 0.5,

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
  /** 返回上一页 */
  back: "󰁍",
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
