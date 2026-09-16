/**
 * @file view-rows.ts
 * @description 纯函数视图排版层：题目菜单行、Tab 导航栏与底部框架 chrome 的统一生成器
 *
 * 核心架构特性：
 * - 全部导出函数为无状态纯函数（无 `this` / 缓存 / IO），输出仅由入参决定，可独立单测与跨视图复用
 * - 文案与几何常量一律取自 `texts.ts`，本层不直接书写任何可见字符
 * - 折行与补齐一律经 `visibleWidth` / `wrapTextWithAnsi` / `safeLine`，禁止 `string.length` 直算
 *
 * 依赖方向：view-rows.ts → format.ts / model.ts / texts.ts / theme.ts；禁止反向导入 `component.ts`
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { divider, padToVisibleWidth, pushWrapped, safeLine } from "./format.js";
import {
  hasQuestionNote,
  type AskAuthorFormModel,
  type MenuItem,
  type NormalizedQuestion,
  type QuestionAnswerState,
} from "./model.js";
import { ICONS, LAYOUT_CONFIG, TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";

/**
 * 解析菜单选项的展示标签（作者可见文案兜底入口）
 * @param q - 归一化题目对象
 * @param optionIndex - 0-based 索引（兜底文案按 1-based 展示）
 * @returns 选项自带标签；索引越界取不到条目时回退 `TEXTS.fallbacks.autoOptionLabel`（形如「选项 3」）
 */
export function optionLabelOf(q: NormalizedQuestion, optionIndex: number): string {
  return q.options[optionIndex]?.label ?? TEXTS.fallbacks.autoOptionLabel(optionIndex + 1);
}

/**
 * 判定菜单项是否处于已选中/已生效状态
 * @param item - 目标菜单项
 * @param q - 当前题目
 * @param st - 作答状态
 * @returns 多选查 `selectedIndices` 成员资格，单选比对 `selectedIndex`；`custom_note` 条目在题目补充说明非空时生效；其余条目（含缺失 `optionIndex` 的选项）恒为 false
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
 * 生成选项前置勾选/选中指示符
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
 * - 非聚焦未选中预设选项淡化 `dim`（其余 `text`）且不超限；带专属补充说明的选项追加 `ICONS.note`
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

    const isUnselectedOption = item.type === "option" && !isSelected;
    const styledLine = isUnselectedOption ? theme.fg("dim", line) : theme.fg("text", line);
    const row = idx === 0 ? `${prefix}${styledLine}` : `${indent}${styledLine}`;
    return safeLine(row, targetWidth);
  });
}

/**
 * 渲染完整 Tab 导航栏区块（各题标签 + 提交页标签 + 末尾单横分隔线）
 *
 * 算法不变量：
 * - 题目标签以 `ICONS.checked` / `ICONS.unchecked` 与 `success` / `muted` 配色表达完成度，激活题页恒为
 *   `selectedBg` + `accent` 的 `bold` 反白（激活提交页为 `selectedBg` + `success`）
 * - 提交页标签在全部作答完成时用 `success`，否则 `dim`；激活判定为 `currentTab === model.questionCount`
 * - 分段按 `renderWidth` 贪心折行（段间单空格连接），超宽分段独占一行而不被丢弃；末尾恒追加一条
 *   `dim` 配色的单横分隔线（`LAYOUT_CONFIG.dividerThin`）
 *
 * @param theme - 主题样式提供者
 * @param model - 问卷表单数据模型（提供题目数、作答完成度）
 * @param currentTab - 激活页索引（`0 ~ questionCount - 1` 为题页，`questionCount` 为总览页）
 * @param renderWidth - 终端可视宽度限制
 * @returns Tab 导航栏终端行数组（至少含末尾分隔线一行；超宽时标签折为多行）
 */
export function buildTabLines(
  theme: Theme,
  model: AskAuthorFormModel,
  currentTab: number,
  renderWidth: number,
): string[] {
  const isSubmitTab = currentTab === model.questionCount;
  const tabLines: string[] = [];
  const tabSegments: string[] = [];
  for (let i = 0; i < model.questionCount; i++) {
    const isActive = i === currentTab;
    const answered = model.isQuestionAnswered(i);
    const icon = answered ? ICONS.checked : ICONS.unchecked;
    const color = answered ? "success" : "muted";
    const text = ` ${icon} ${TEXTS.tabs.questionTab(i + 1)} `;
    tabSegments.push(isActive ? theme.bg("selectedBg", theme.fg("accent", theme.bold(text))) : theme.fg(color, text));
  }

  const submitText = ` ${TEXTS.tabs.submitTab} `;
  tabSegments.push(
    isSubmitTab
      ? theme.bg("selectedBg", theme.fg("success", theme.bold(submitText)))
      : theme.fg(model.areAllQuestionsAnswered() ? "success" : "dim", submitText),
  );

  let row = "";
  let rowWidth = 0;
  for (const seg of tabSegments) {
    const segWidth = visibleWidth(seg);
    if (rowWidth > 0 && rowWidth + 1 + segWidth > renderWidth) {
      tabLines.push(safeLine(row, renderWidth));
      row = "";
      rowWidth = 0;
    } else if (rowWidth > 0) {
      row += " ";
      rowWidth += 1;
    }
    row += seg;
    rowWidth += segWidth;
  }
  tabLines.push(safeLine(row, renderWidth));
  tabLines.push(theme.fg("dim", divider(renderWidth)));

  return tabLines;
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
