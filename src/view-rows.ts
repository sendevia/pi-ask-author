/**
 * @file view-rows.ts
 * @description 视图排版纯函数：题目菜单行、Tab 导航栏、内容区与底部框架
 *
 * 全部导出函数无状态；文案取自 `texts.ts`，宽度经 `visibleWidth` / `wrapTextWithAnsi` / `safeLine` 计算
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { divider, padToVisibleWidth, pushWrapped, safeLine, windowSlice, clampWindowOffset } from "./format.js";
import {
  type AskAuthorFormModel,
  type MenuItem,
  type NormalizedQuestion,
  type QuestionAnswerState,
} from "./model.js";
import { ICONS, LAYOUT_CONFIG } from "./layout.js";
import { TEXTS } from "./texts.js";
import type { Theme, ThemeColor } from "./theme.js";

/** 按钮每行除内容之外的固定列数（左右边框各 1 列、内容左右各 1 列空格） */
const BUTTON_CHROME_WIDTH = 4;

/** 屏幕行范围（0-based 半开区间）：鼠标命中测试与滚轮分区共用 */
export interface RowRange {
  /** 首行（含） */
  readonly start: number;
  /** 结束行（不含） */
  readonly end: number;
}

/** Tab 栏上一段可点击标签的位置（行号为栏内相对行，列为行内可见列区间） */
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
 * 解析菜单选项的展示标签
 * @param q - 归一化题目对象
 * @param optionIndex - 0-based 索引（兜底文案按 1-based 展示）
 * @returns 选项自带标签；取不到条目时回退 `TEXTS.fallbacks.autoOptionLabel`
 */
export function optionLabelOf(q: NormalizedQuestion, optionIndex: number): string {
  return q.options[optionIndex]?.label ?? TEXTS.fallbacks.autoOptionLabel(optionIndex + 1);
}

/**
 * 判定菜单项是否处于已选中状态
 * @param item - 目标菜单项
 * @param q - 当前题目
 * @param st - 作答状态
 * @returns 多选查 `selectedIndices`，单选比对 `selectedIndex`
 */
function isItemSelected(item: MenuItem, q: NormalizedQuestion, st: QuestionAnswerState): boolean {
  return q.multiSelect ? st.selectedIndices.has(item.optionIndex) : st.selectedIndex === item.optionIndex;
}

/**
 * 生成选项前面的勾选指示符
 * @param theme - 主题样式提供者
 * @param q - 当前题目
 * @param st - 作答状态
 * @param item - 菜单项
 * @returns 多选已勾选 `success` / 未勾选 `dim`，单选已选中 `accent` / 未选中 `dim`
 */
function optionCheckMark(theme: Theme, q: NormalizedQuestion, st: QuestionAnswerState, item: MenuItem): string {
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
 * - 首行携带「光标 + 勾选」前缀，后续折行悬挂缩进；聚焦项全部折行套用 `selectedBg` 与 `bold` 至 `targetWidth`
 * - 非聚焦的未选选项淡化 `dim`；带专属批注的选项追加 `ICONS.note`
 * - 标签未超宽时直接复用单行，跳过 `wrapTextWithAnsi`
 *
 * @param theme - 主题样式提供者
 * @param item - 目标菜单项
 * @param isFocused - 是否为当前光标聚焦项
 * @param q - 当前题目
 * @param st - 作答状态
 * @param targetWidth - 单行可用列宽
 * @returns 终端行数组（至少一行）
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

  const labelText = st.optionNotes.has(item.optionIndex) ? `${item.label} ${ICONS.note}` : item.label;

  const contentLines = visibleWidth(labelText) <= textWidth ? [labelText] : wrapTextWithAnsi(labelText, textWidth);

  return contentLines.map((line, idx) => {
    if (isFocused) {
      const row = idx === 0 ? `${prefix}${line}` : `${indent}${line}`;
      return theme.bg("selectedBg", theme.fg("text", theme.bold(padToVisibleWidth(row, targetWidth))));
    }

    const styledLine = isSelected ? theme.fg("text", line) : theme.fg("dim", line);
    const row = idx === 0 ? `${prefix}${styledLine}` : `${indent}${styledLine}`;
    return safeLine(row, targetWidth);
  });
}

/**
 * 解析题目的 Tab 标签文本
 * @param model - 问卷模型
 * @param questionIndex - 题目顺序索引（0-based）
 * @param displayIndex - 可见题目的展示序号（1-based）
 * @returns 题目短标签（超宽时截断至 `LAYOUT_CONFIG.tabLabelMaxWidth`）；未声明时为题号文案
 */
function tabLabelText(model: AskAuthorFormModel, questionIndex: number, displayIndex: number): string {
  const tabLabel = model.getQuestion(questionIndex)?.tabLabel;
  return tabLabel ? truncateToWidth(tabLabel, LAYOUT_CONFIG.tabLabelMaxWidth) : TEXTS.tabs.questionTab(displayIndex);
}

/**
 * 渲染完整 Tab 导航栏区块（各题标签 + 提交页标签 + 末尾单横分隔线）
 *
 * - 只为可见题目产出标签，序号为可见题目的展示序号；标签优先取 `tabLabel`，未声明时用题号文案
 * - 完成度由 `ICONS.checked` / `ICONS.unchecked` 与 `success` / `muted` 表达；激活页为 `selectedBg` + `accent` 的 `bold` 反白
 * - 提交页标签在全部作答完成时用 `success`，否则 `dim`；激活判定为 `currentTab === model.questionCount`
 * - 按 `renderWidth` 贪心折行（段间单空格），超宽分段独占一行；末尾恒追加一条 `dim` 单横分隔线
 * - 推演在途时把激活页标题换成占位文案
 *
 * @param theme - 主题样式提供者
 * @param model - 问卷模型（提供可见题目与作答完成度）
 * @param currentTab - 激活页索引（题目索引；`questionCount` 为总览页）
 * @param renderWidth - 终端可视宽度
 * @param expansionPending - 是否有推演请求在途（为 true 时激活页标签改为占位文案）
 * @returns Tab 栏行与各标签的可点击位置（至少含末尾分隔线一行）
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
 * 构建推演在途占位页（整页：顶部分割线 / Tab 栏 / 运行提示 / 取消提示 / 底部分割线）
 * 推演在途期间只接受取消键
 * @param theme - 主题样式提供者
 * @param tabLines - 题目导航 Tab 栏行（组件缓存）
 * @param renderWidth - 终端可视宽度（说明文案超宽时悬挂缩进折行）
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

/** 固定高度内容区的渲染产物 */
export interface ScrollBand {
  /** 恰好 `height` 行的内容区 */
  readonly lines: string[];
  /** 本帧可视内容行数（内容超出时已扣除滚动信息行） */
  readonly viewHeight: number;
  /** 本帧首行对应的内容行索引（调用方据此换算内容行在整页中的位置） */
  readonly offset: number;
}

/**
 * 把完整内容切成固定高度：超出时末行换成滚动信息行，不足时补空行
 * 作答页预览区与总览页内容区共用本函数，保证两处分页与滚动提示一致
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
  return { lines, viewHeight, offset };
}

/**
 * 原地追加底部状态通知行（无文案时不追加）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param statusMessage - 当前状态通知
 */
export function pushStatusMessage(lines: string[], theme: Theme, statusMessage: string | null): void {
  if (!statusMessage) return;
  lines.push("");
  lines.push(` ${theme.fg("warning", statusMessage)}`);
}

/**
 * 以 `TEXTS.common.helpSeparator` 连接底部按键提示片段
 * @param parts - 提示片段数组
 * @returns 连接后的单行文本；空数组为空串
 */
function joinHelpParts(parts: readonly string[]): string {
  return parts.join(TEXTS.common.helpSeparator);
}

/**
 * 原地追加底部按键提示行（`dim` 配色 + 单空格悬挂缩进，超宽时折行）
 * @param lines - 输出行数组（原地追加）
 * @param parts - 按键提示片段（空数组时仍追加一行以保持布局稳定）
 * @param theme - 主题样式提供者
 * @param renderWidth - 终端可视宽度
 */
export function pushHelpFooter(lines: string[], parts: readonly string[], theme: Theme, renderWidth: number): void {
  pushWrapped(lines, theme.fg("dim", joinHelpParts(parts)), renderWidth, " ");
}

/** 按钮文字与框线配色 */
export interface ButtonSpec {
  /** 按钮文字（可含换行，已含的着色保留） */
  readonly text: string;
  /** 框线前景色令牌 */
  readonly tone: ThemeColor;
}

/** 按钮在输出行中的矩形范围（列区间按可见列计，0-based 半开） */
export interface ButtonRect {
  /** 行范围（含上下缘） */
  readonly rows: RowRange;
  /** 列区间 */
  readonly cols: RowRange;
}

/** 按钮组渲染产物 */
export interface ButtonGroup {
  /** 整组行：组内同行的按钮高度对齐，短按钮补空内容行 */
  readonly lines: string[];
  /** 各按钮的矩形范围（与 `buttons` 同序） */
  readonly rects: readonly ButtonRect[];
}

/** 按钮组的单个按钮测量结果（内容行已按行宽折行） */
interface ButtonCell {
  /** 框线前景色令牌 */
  readonly tone: ThemeColor;
  /** 折行后的内容行 */
  readonly contentLines: string[];
  /** 内容区可见列宽（取最长内容行） */
  readonly inner: number;
}

/**
 * 渲染横排字符框架按钮组：上缘 `┌ ─ ┐`、两侧 `│`、下缘 `┕ ━ ┙`
 *
 * - 按钮宽度贴着文字，超过行宽时按列折行；一行放不下时后续按钮另起一行
 * - 同一行内按钮高度取该行最大值，短按钮的内容区补空行保持上下缘对齐
 * - `align` 决定整组靠向：左对齐首列留 `inset` 列，右对齐末列距右缘 `inset` 列
 *
 * @param theme - 主题样式提供者
 * @param buttons - 按钮序列（空数组时无输出行）
 * @param maxWidth - 可用总宽度（含缩进）
 * @param align - 各行靠左或靠右
 * @param inset - 靠向一侧的空白列数
 * @returns 整组行与各按钮矩形范围
 */
export function renderButtonGroup(
  theme: Theme,
  buttons: readonly ButtonSpec[],
  maxWidth: number,
  align: "left" | "right" = "left",
  inset = 0,
): ButtonGroup {
  const frame = LAYOUT_CONFIG.buttonFrame;
  const available = Math.max(BUTTON_CHROME_WIDTH + 1, maxWidth - inset);

  const cells: ButtonCell[] = buttons.map((button) => {
    const contentLines = wrapTextWithAnsi(button.text, Math.max(1, available - BUTTON_CHROME_WIDTH));
    const inner = contentLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    return { tone: button.tone, contentLines, inner };
  });

  // 贪心折行：与上一个按钮之间留 1 列间隙，超出可用宽度就另起一行
  const rows: { cells: ButtonCell[]; width: number }[] = [];
  for (const cell of cells) {
    const width = cell.inner + BUTTON_CHROME_WIDTH;
    const current = rows[rows.length - 1];
    if (current && current.width + 1 + width <= available) {
      current.width += 1 + width;
      current.cells.push(cell);
    } else {
      rows.push({ cells: [cell], width });
    }
  }

  const lines: string[] = [];
  const rects: ButtonRect[] = [];
  for (const row of rows) {
    const leftPad = " ".repeat(Math.max(0, align === "right" ? maxWidth - inset - row.width : inset));
    const height = Math.max(...row.cells.map((cell) => cell.contentLines.length));
    const tops: string[] = [];
    const bottoms: string[] = [];
    const columns: string[][] = [];
    const spans: RowRange[] = [];
    let column = leftPad.length;

    for (const cell of row.cells) {
      const width = cell.inner + BUTTON_CHROME_WIDTH;
      const side = theme.fg(cell.tone, frame.side);
      tops.push(theme.fg(cell.tone, frame.topLeft + frame.top.repeat(cell.inner + 2) + frame.topRight));
      bottoms.push(theme.fg(cell.tone, frame.bottomLeft + frame.bottom.repeat(cell.inner + 2) + frame.bottomRight));
      columns.push(
        Array.from(
          { length: height },
          (_, lineIndex) => `${side} ${padToVisibleWidth(cell.contentLines[lineIndex] ?? "", cell.inner)} ${side}`,
        ),
      );
      spans.push({ start: column, end: column + width });
      column += width + 1;
    }

    const top = lines.length;
    lines.push(leftPad + tops.join(" "));
    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      lines.push(leftPad + columns.map((columnLines) => columnLines[lineIndex]).join(" "));
    }
    lines.push(leftPad + bottoms.join(" "));
    for (const span of spans) rects.push({ rows: { start: top, end: lines.length }, cols: span });
  }

  return { lines, rects };
}

/**
 * 原地追加一条外层框架分隔线（`accent` 配色）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param width - 分隔线可视宽度（`<= 0` 时追加空串）
 */
export function pushFrameRule(lines: string[], theme: Theme, width: number): void {
  lines.push(theme.fg("accent", divider(width, LAYOUT_CONFIG.dividerThick)));
}
