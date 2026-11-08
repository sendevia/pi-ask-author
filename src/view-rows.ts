/**
 * @file view-rows.ts
 * @description 纯函数视图排版层：题目菜单行、Tab 导航栏与底部框架 chrome 的统一生成器
 *
 * 核心架构特性：
 * - 全部导出函数为无状态纯函数（无 `this` / 缓存 / IO），输出仅由入参决定，可独立单元测试与跨视图复用
 * - 文案与几何常量一律取自 `texts.ts`，本层不直接书写任何可见字符
 * - 折行与补齐一律经 `visibleWidth` / `wrapTextWithAnsi` / `safeLine` 处理，禁止使用 `string.length` 直接计算
 *
 * 依赖方向：view-rows.ts → format.ts / model.ts / texts.ts / theme.ts；禁止反向导入 `component.ts`
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { divider, padToVisibleWidth, pushWrapped, safeLine, windowSlice, clampWindowOffset } from "./format.js";
import {
  hasQuestionNote,
  type AskAuthorFormModel,
  type MenuItem,
  type NormalizedQuestion,
  type QuestionAnswerState,
} from "./model.js";
import { ICONS, LAYOUT_CONFIG } from "./layout.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";

/**
 * 屏幕行范围（0-based，半开区间）：鼠标命中测试与滚轮分区共用
 */
export interface RowRange {
  /** 首行（含） */
  readonly start: number;
  /** 结束行（不含） */
  readonly end: number;
}

/**
 * Tab 栏上一段可点击标签的位置（行号为 Tab 栏内的相对行，列为该行内的可见列区间）
 */
export interface TabSegment {
  /** 该标签对应的页索引（题目索引，`questionCount` 为总览页） */
  readonly tab: number;
  /** Tab 栏内的相对行号（0-based） */
  readonly row: number;
  /** 起始列（含） */
  readonly start: number;
  /** 结束列（不含） */
  readonly end: number;
}

/**
 * Tab 导航栏的渲染产物
 */
export interface TabBar {
  /** Tab 栏行（末尾带单横分隔线） */
  readonly lines: string[];
  /** 各标签的可点击位置（供组件做鼠标命中） */
  readonly segments: readonly TabSegment[];
}

/**
 * 解析菜单选项的展示标签（作者可见文案兜底入口）
 * @param q - 归一化题目对象
 * @param optionIndex - 0-based 索引（兜底文案按 1-based 展示）
 * @returns 选项自带标签；索引越界获取不到条目时回退 `TEXTS.fallbacks.autoOptionLabel`（形如「选项 3」）
 */
export function optionLabelOf(q: NormalizedQuestion, optionIndex: number): string {
  return q.options[optionIndex]?.label ?? TEXTS.fallbacks.autoOptionLabel(optionIndex + 1);
}

/**
 * 判定菜单项是否处于已选中/已生效状态
 * @param item - 目标菜单项
 * @param q - 当前题目
 * @param st - 作答状态
 * @returns 多选查询 `selectedIndices` 成员资格，单选比对 `selectedIndex`；`custom_note` 条目在题目补充说明非空时生效；其余条目（含缺失 `optionIndex` 的选项）恒为 false
 */
function isItemSelected(item: MenuItem, q: NormalizedQuestion, st: QuestionAnswerState): boolean {
  if (item.type === "option" && item.optionIndex !== undefined) {
    return q.multiSelect ? st.selectedIndices.has(item.optionIndex) : st.selectedIndex === item.optionIndex;
  }
  if (item.type === "custom_note") {
    return hasQuestionNote(st);
  }
  return false;
}

/**
 * 生成选项前面的勾选/选中指示符
 * @param theme - 主题样式提供者
 * @param q - 当前题目
 * @param st - 作答状态
 * @param item - 菜单项
 * @returns 带主题样式的指示符：多选已勾选 `success` / 未勾选 `dim`，单选已选中 `accent` / 未选中 `dim`；非选项条目或缺失 `optionIndex` 时返回空串
 */
function optionCheckMark(theme: Theme, q: NormalizedQuestion, st: QuestionAnswerState, item: MenuItem): string {
  if (item.type !== "option" || item.optionIndex === undefined) return "";
  if (q.multiSelect) {
    return st.selectedIndices.has(item.optionIndex)
      ? theme.fg("success", ICONS.checkedMulti)
      : theme.fg("dim", ICONS.uncheckedMulti);
  }
  return st.selectedIndex === item.optionIndex
    ? theme.fg("accent", ICONS.checkedSingle)
    : theme.fg("dim", ICONS.uncheckedSingle);
}

/**
 * 格式化单个菜单条目行
 *
 * 排版不变量：
 * - 首行携带「光标 + 勾选」前缀，后续折行等宽悬挂缩进、左缘与前缀一致；聚焦项全部折行套用 `selectedBg` 与 `bold` 样式至 `targetWidth`
 * - 非聚焦未选中选项与题目补充说明淡化 `dim`（其余 `text`）且不超限；带专属补充说明的选项追加 `ICONS.note`
 * - 快路径：标签可见宽度未超限时直接复用单行，跳过 `wrapTextWithAnsi` 正则解析
 *
 * @param theme - 主题样式提供者
 * @param item - 目标菜单项
 * @param isFocused - 是否为当前光标聚焦项
 * @param q - 当前题目
 * @param st - 作答状态
 * @param targetWidth - 单行可用列宽（内容区宽度）
 * @returns 终端行数组；标签超长时按悬挂缩进折为多行（至少一行）
 */
export function formatMenuItemRow(
  theme: Theme,
  item: MenuItem,
  isFocused: boolean,
  q: NormalizedQuestion,
  st: QuestionAnswerState,
  targetWidth: number,
): string[] {
  const isSelected = isItemSelected(item, q, st);
  const cursor = isFocused ? theme.fg("accent", theme.bold(`${ICONS.cursor} `)) : "  ";
  const checkMark = optionCheckMark(theme, q, st, item);
  const prefix = `${cursor}${checkMark}`;
  const prefixW = visibleWidth(prefix);
  const indent = " ".repeat(prefixW);
  const textWidth = Math.max(8, targetWidth - prefixW);

  let labelText = item.label;
  if (item.type === "option" && item.optionIndex !== undefined) {
    const optNote = st.optionNotes.get(item.optionIndex);
    if (optNote) {
      labelText = `${item.label} ${ICONS.note}`;
    }
  }

  const contentLines = visibleWidth(labelText) <= textWidth ? [labelText] : wrapTextWithAnsi(labelText, textWidth);

  return contentLines.map((line, idx) => {
    if (isFocused) {
      const row = idx === 0 ? `${prefix}${line}` : `${indent}${line}`;
      return theme.bg("selectedBg", theme.fg("text", theme.bold(padToVisibleWidth(row, targetWidth))));
    }

    const isUnselected = (item.type === "option" || item.type === "custom_note") && !isSelected;
    const styledLine = isUnselected ? theme.fg("dim", line) : theme.fg("text", line);
    const row = idx === 0 ? `${prefix}${styledLine}` : `${indent}${styledLine}`;
    return safeLine(row, targetWidth);
  });
}

/**
 * 解析题目的 Tab 标签文本
 * @param model - 问卷模型（读取题目短标签）
 * @param questionIndex - 题目顺序索引（0-based）
 * @param displayIndex - 可见题目的展示序号（1-based）
 * @returns 题目声明的短标签（超宽时截断至 `LAYOUT_CONFIG.tabLabelMaxWidth`）；未声明时回退题号文案
 */
function tabLabelText(model: AskAuthorFormModel, questionIndex: number, displayIndex: number): string {
  const tabLabel = model.getQuestion(questionIndex)?.tabLabel;
  return tabLabel ? truncateToWidth(tabLabel, LAYOUT_CONFIG.tabLabelMaxWidth) : TEXTS.tabs.questionTab(displayIndex);
}

/**
 * 渲染完整 Tab 导航栏区块（各题标签 + 提交页标签 + 末尾单横分隔线）
 *
 * 算法不变量：
 * - 只为当前可见题目产出标签（序条件隐藏的题目不出现在导航栏），标签序号为可见题目的展示序号
 * - 题目标签文本优先取题目的 `tabLabel`（超过 `LAYOUT_CONFIG.tabLabelMaxWidth` 时截断），未声明时回退题号文案；
 * - 题目标签以 `ICONS.checked` / `ICONS.unchecked` 与 `success` / `muted` 配色表达完成度，激活题页恒为
 *   `selectedBg` + `accent` 的 `bold` 反白（激活提交页为 `selectedBg` + `success`）
 * - 提交页标签在全部作答完成时用 `success`，否则 `dim`；激活判定为 `currentTab === model.questionCount`
 * - 分段按 `renderWidth` 贪心折行（段间单空格连接），超宽分段独占一行而不被丢弃；末尾恒追加一条
 *   `dim` 配色的单横分隔线（`LAYOUT_CONFIG.dividerThin`）
 * - 推演在途时把激活页的 Tab 标题换成占位文案，向作者说明该页正在等待新题目落位
 *
 * @param theme - 主题样式提供者
 * @param model - 问卷表单数据模型（提供可见题目、作答完成度）
 * @param currentTab - 激活页索引（题目顺序索引；`questionCount` 为总览页）
 * @param renderWidth - 终端可视宽度限制
 * @param expansionPending - 是否有推演请求在途（为 true 时激活页标签改为占位文案）
 * @returns Tab 栏行与各标签的可点击位置（行数组至少含末尾分隔线一行；超宽时标签折为多行）
 */
export function buildTabLines(
  theme: Theme,
  model: AskAuthorFormModel,
  currentTab: number,
  renderWidth: number,
  expansionPending = false,
): TabBar {
  const isSubmitTab = currentTab === model.questionCount;
  const tabLines: string[] = [];
  const segments: TabSegment[] = [];
  const tabSegments: { tab: number; text: string }[] = [];
  const placeholderText = ` ${TEXTS.tabs.expansionPlaceholder} `;
  for (const [displayIndex, questionIndex] of model.getVisibleQuestionIndices().entries()) {
    const isActive = questionIndex === currentTab;
    const answered = model.isQuestionAnswered(questionIndex);
    const icon = answered ? ICONS.checked : ICONS.unchecked;
    const activeLabel =
      isActive && expansionPending
        ? placeholderText
        : ` ${icon} ${tabLabelText(model, questionIndex, displayIndex + 1)} `;
    const color = isActive ? (expansionPending ? "warning" : "accent") : answered ? "success" : "muted";
    tabSegments.push({
      tab: questionIndex,
      text: isActive ? theme.bg("selectedBg", theme.fg(color, theme.bold(activeLabel))) : theme.fg(color, activeLabel),
    });
  }

  const submitText = isSubmitTab && expansionPending ? placeholderText : ` ${TEXTS.tabs.submitTab} `;
  const submitColor = isSubmitTab
    ? expansionPending
      ? "warning"
      : "success"
    : model.areAllQuestionsAnswered()
      ? "success"
      : "dim";
  tabSegments.push({
    tab: model.questionCount,
    text: isSubmitTab
      ? theme.bg("selectedBg", theme.fg(submitColor, theme.bold(submitText)))
      : theme.fg(submitColor, submitText),
  });

  let row = "";
  let rowWidth = 0;
  for (const seg of tabSegments) {
    const segWidth = visibleWidth(seg.text);
    if (rowWidth > 0 && rowWidth + 1 + segWidth > renderWidth) {
      tabLines.push(safeLine(row, renderWidth));
      row = "";
      rowWidth = 0;
    } else if (rowWidth > 0) {
      row += " ";
      rowWidth += 1;
    }
    segments.push({ tab: seg.tab, row: tabLines.length, start: rowWidth, end: rowWidth + segWidth });
    row += seg.text;
    rowWidth += segWidth;
  }
  tabLines.push(safeLine(row, renderWidth));
  tabLines.push(theme.fg("dim", divider(renderWidth)));

  return { lines: tabLines, segments };
}

/**
 * 构建推演在途占位页（整页：顶部分割线 / Tab 栏 / 运行提示 / 补充空行 / 取消提示 / 底部分割线）
 * 整页占满终端高度，推演在途期间不接受除取消外的任何输入
 * @param theme - 主题样式提供者
 * @param tabLines - 题目导航 Tab 栏行（组件缓存）
 * @param renderWidth - 终端可视宽度限制（说明文案超宽时按单空格悬挂缩进折行）
 * @param terminalRows - 终端可视行数
 * @returns 恰好占满终端高度的整页行数组
 */
export function renderExpansionPlaceholderPage(
  theme: Theme,
  tabLines: readonly string[],
  renderWidth: number,
  terminalRows: number,
): string[] {
  const lines: string[] = [];
  pushFrameRule(lines, theme, renderWidth);
  lines.push(...tabLines);

  const tail: string[] = [];
  pushHelpFooter(tail, [TEXTS.help.cancel], theme, renderWidth);
  pushFrameRule(tail, theme, renderWidth);

  lines.push("");
  lines.push(` ${theme.fg("warning", theme.bold(TEXTS.status.expansionRunning))}`);
  lines.push("");
  pushWrapped(lines, theme.fg("dim", ` ${TEXTS.view.expansionPendingHint}`), renderWidth, " ");

  const used = lines.length;
  for (let i = used + tail.length; i < terminalRows; i++) lines.push("");
  lines.push(...tail);
  return lines;
}

/**
 * 固定高度内容区的渲染产物
 */
export interface ScrollBand {
  /** 恰好 `height` 行的内容区 */
  readonly lines: string[];
  /** 本帧可视内容行数（内容超出时已扣除滚动信息行） */
  readonly viewHeight: number;
}

/**
 * 把完整内容切成固定高度的内容区：超出时末行换成滚动信息行，不足时补空行
 * 作答页的内容预览区与提交页的答卷内容区共用本函数，保证两处的分页与滚动提示完全一致
 * @param fullLines - 未切片的完整内容行（不修改入参）
 * @param height - 内容区占用行数
 * @param scrollOffset - 当前滚动位移（在本地收敛，不写回）
 * @param theme - 主题样式提供者
 * @param width - 单行可见宽度上限
 * @returns 恰好 `height` 行的内容区与本帧可视行数
 */
export function buildScrollBand(
  fullLines: readonly string[],
  height: number,
  scrollOffset: number,
  theme: Theme,
  width: number,
): ScrollBand {
  const total = fullLines.length;
  const scrollable = total > height;
  const viewHeight = scrollable ? Math.max(1, height - 1) : height;
  const offset = clampWindowOffset(scrollOffset, total, viewHeight);
  const lines = windowSlice(fullLines, offset, viewHeight).map((line) => safeLine(line, width));
  if (scrollable) {
    const scrollInfo = TEXTS.view.previewScrollInfo(offset + 1, Math.min(total, offset + viewHeight), total);
    lines.push(safeLine(`  ${theme.fg("dim", scrollInfo)}`, width));
  }
  while (lines.length < height) lines.push("");
  return { lines, viewHeight };
}

/**
 * 原地追加底部状态通知行（无文案时不追加）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param statusMessage - 当前状态通知（可为空）
 */
export function pushStatusMessage(lines: string[], theme: Theme, statusMessage: string | null): void {
  if (!statusMessage) return;
  lines.push("");
  lines.push(` ${theme.fg("warning", statusMessage)}`);
}

/**
 * 以 `TEXTS.common.helpSeparator` 连接底部按键提示片段
 * @param parts - 提示片段数组（只读）
 * @returns 连接后的单行文本；空数组返回空串
 */
function joinHelpParts(parts: readonly string[]): string {
  return parts.join(TEXTS.common.helpSeparator);
}

/**
 * 原地追加底部按键提示行（统一 `dim` 配色 + 单空格悬挂缩进，超宽时折行）
 * @param lines - 输出行数组（原地追加）
 * @param parts - 按键提示片段（只读；空数组时仍追加一行以保持布局稳定）
 * @param theme - 主题样式提供者
 * @param renderWidth - 终端可视宽度限制（超宽时按单空格悬挂缩进折行）
 */
export function pushHelpFooter(lines: string[], parts: readonly string[], theme: Theme, renderWidth: number): void {
  pushWrapped(lines, theme.fg("dim", joinHelpParts(parts)), renderWidth, " ");
}

/**
 * 原地追加一条外层框架水平分隔线（`accent` 配色）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param width - 分隔线可视宽度（`<= 0` 时追加空串，不产出超宽行）
 */
export function pushFrameRule(lines: string[], theme: Theme, width: number): void {
  lines.push(theme.fg("accent", divider(width, LAYOUT_CONFIG.dividerThick)));
}
