/**
 * @file view-rows.ts
 * @description 视图排版纯函数：题目菜单行、Tab 导航栏、内容区与底部框架
 *
 * 全部导出函数无状态；文案取自 `texts.ts`，宽度经 `visibleWidth` / `wrapTextWithAnsi` / `safeLine` 计算
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { divider, padToVisibleWidth, pushWrapped, safeLine, windowSlice, clampWindowOffset } from "./format.js";
import { type AskAuthorFormModel, type MenuItem, type NormalizedQuestion, type QuestionAnswerState } from "./model.js";
import { ICONS, LAYOUT_CONFIG } from "./layout.js";
import { TEXTS } from "./texts.js";
import type { Theme, ThemeColor } from "./theme.js";

/** 按钮每行除内容之外的固定列数（左右边框各 1 列、内容左右各 1 列空格） */
const BUTTON_CHROME_WIDTH = 4;

/** 同行按钮之间的基础间隙列数（行内有剩余宽度时再按对齐方式加宽） */
const BUTTON_GAP = 1;

/** Tab 标签之间的间隙列数（标签自身不留边距，整行从首列起排） */
const TAB_GAP = 2;

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
  /** Tab 栏行（只有标签，不带分隔线） */
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
 * 拼接题目的类型短标记（单选/多选、条件、参与推演）
 * @param model - 问卷模型
 * @param questionIndex - 题目索引
 * @param expansionAvailable - 本次会话是否提供推演服务
 * @returns 紧贴题号前的徽标串（如 `[多选][条件]`）；题目缺失时为空串
 */
function tabTypeTags(model: AskAuthorFormModel, questionIndex: number, expansionAvailable: boolean): string {
  const q = model.getQuestion(questionIndex);
  if (!q) return "";
  const tags = [q.multiSelect ? TEXTS.tabs.typeMulti : TEXTS.tabs.typeSingle];
  if (q.showIf.length > 0) tags.push(TEXTS.tabs.conditionalBadge);
  if (expansionAvailable && model.expansionConfigFor(questionIndex)) tags.push(TEXTS.tabs.expansionBadge);
  return tags.join("");
}

/**
 * 渲染完整 Tab 导航栏（各题标签 + 提交页标签）
 *
 * - 只为可见题目产出标签，标签由完成度图标、类型短标记与题号/短标签组成（形如 `[单选] 第1题`）
 * - 标签优先取 `tabLabel`，未声明时用题号文案；参与推演的题目带 `[推演]`，带显示条件的带 `[条件]`
 * - 完成度由 `ICONS.checked` / `ICONS.unchecked` 与 `success` / `muted` 表达；激活页为 `selectedBg` + `accent` 的 `bold` 反白
 * - 提交页标签在全部作答完成时用 `success`，否则 `dim`；激活判定为 `currentTab === model.questionCount`
 * - 按 `renderWidth` 贪心折行（段间固定两列），超宽分段独占一行
 * - 推演在途时把激活页标题换成占位文案
 *
 * @param theme - 主题样式提供者
 * @param model - 问卷模型（提供可见题目与作答完成度）
 * @param currentTab - 激活页索引（题目索引；`questionCount` 为总览页）
 * @param renderWidth - 终端可视宽度
 * @param expansionPending - 是否有推演请求在途（为 true 时激活页标签改为占位文案）
 * @param expansionAvailable - 本次会话是否提供推演服务（决定是否显示 `[推演]` 标记）
 * @returns Tab 栏行与各标签的可点击位置（至少一行）
 */
export function buildTabLines(
  theme: Theme,
  model: AskAuthorFormModel,
  currentTab: number,
  renderWidth: number,
  expansionPending = false,
  expansionAvailable = false,
): TabBar {
  const isSubmitTab = currentTab === model.questionCount;
  const tabLines: string[] = [];
  const segments: TabSegment[] = [];
  const tabSegments: { tab: number; text: string }[] = [];
  const placeholderText = TEXTS.tabs.expansionPlaceholder;
  for (const [displayIndex, questionIndex] of model.getVisibleQuestionIndices().entries()) {
    const isActive = questionIndex === currentTab;
    const answered = model.isQuestionAnswered(questionIndex);
    const icon = answered ? ICONS.checked : ICONS.unchecked;
    const typeTags = tabTypeTags(model, questionIndex, expansionAvailable);
    const activeLabel =
      isActive && expansionPending
        ? placeholderText
        : `${icon} ${typeTags} ${tabLabelText(model, questionIndex, displayIndex + 1)}`;
    const color = isActive ? (expansionPending ? "warning" : "accent") : answered ? "success" : "muted";
    tabSegments.push({
      tab: questionIndex,
      text: isActive ? theme.bg("selectedBg", theme.fg(color, theme.bold(activeLabel))) : theme.fg(color, activeLabel),
    });
  }

  const submitText = isSubmitTab && expansionPending ? placeholderText : TEXTS.tabs.submitTab;
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
    if (rowWidth > 0 && rowWidth + TAB_GAP + segWidth > renderWidth) {
      tabLines.push(safeLine(row, renderWidth));
      row = "";
      rowWidth = 0;
    } else if (rowWidth > 0) {
      row += " ".repeat(TAB_GAP);
      rowWidth += TAB_GAP;
    }
    segments.push({ tab: seg.tab, row: tabLines.length, start: rowWidth, end: rowWidth + segWidth });
    row += seg.text;
    rowWidth += segWidth;
  }
  tabLines.push(safeLine(row, renderWidth));

  return { lines: tabLines, segments };
}

/**
 * 构建推演在途占位页（四个区域：Tab 栏 / 运行提示 / 无作答区 / 取消提示）
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
  return composePage(
    theme,
    renderWidth,
    terminalRows,
    { tabLines, titleLines: [], answerLines: [], statusMessage: null, helpParts: [TEXTS.help.cancel] },
    (height) => {
      const content: string[] = [` ${theme.fg("warning", theme.bold(TEXTS.status.expansionRunning))}`, ""];
      pushWrapped(content, theme.fg("dim", ` ${TEXTS.view.expansionPendingHint}`), renderWidth, " ");
      while (content.length < height) content.push("");
      return content;
    },
  ).lines;
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

/** 内容区的渲染产物 */
export interface ContentSections {
  /** 恰好 `height` 行的内容区行 */
  readonly lines: string[];
  /** 正文子区本帧可视行数（不含滚动信息行） */
  readonly viewHeight: number;
}

/**
 * 渲染内容区：正文子区 + 补充子区（无补充时整个子区连分隔线一起省略）
 *
 * - 补充子区在正文子区下方，两者之间一条单横分隔线
 * - 补充子区至多占内容区一半高度，超出时末行换成指向编辑器查看全文的提示行
 * - 正文子区吃剩下的行数，超出时末行让给滚动信息行
 *
 * @param theme - 主题样式提供者
 * @param renderWidth - 终端布局列宽
 * @param height - 内容区占用的终端行数
 * @param mainLines - 正文子区的未切片完整内容行
 * @param noteLines - 补充子区的未切片完整内容行（空数组表示无补充）
 * @param scrollOffset - 正文子区当前滚动位移（在本地收敛，不写回）
 * @returns 恰好 `height` 行的内容区与正文子区可视行数
 */
export function renderContentSections(
  theme: Theme,
  renderWidth: number,
  height: number,
  mainLines: readonly string[],
  noteLines: readonly string[],
  scrollOffset: number,
): ContentSections {
  if (noteLines.length === 0) {
    const band = buildScrollBand(mainLines, height, scrollOffset, theme, renderWidth);
    return { lines: band.lines, viewHeight: band.viewHeight };
  }

  const noteHeight = Math.min(noteLines.length, Math.max(1, Math.floor(height / 2)));
  const clippedNotes =
    noteLines.length > noteHeight
      ? [...noteLines.slice(0, noteHeight - 1), theme.fg("dim", TEXTS.view.notePreviewClipped)]
      : noteLines;

  const band = buildScrollBand(mainLines, Math.max(1, height - noteHeight - 1), scrollOffset, theme, renderWidth);
  const lines = [...band.lines];
  lines.push(theme.fg("dim", divider(renderWidth)));
  lines.push(...clippedNotes);
  while (lines.length < height) lines.push("");
  return { lines, viewHeight: band.viewHeight };
}

/**
 * 原地追加提示区的临时状态通知行（无文案时不追加，超宽时悬挂缩进折行）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param statusMessage - 当前状态通知
 * @param renderWidth - 终端可视宽度
 */
function pushStatusMessage(lines: string[], theme: Theme, statusMessage: string | null, renderWidth: number): void {
  if (!statusMessage) return;
  pushWrapped(lines, theme.fg("warning", statusMessage), renderWidth, " ");
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
function pushHelpFooter(lines: string[], parts: readonly string[], theme: Theme, renderWidth: number): void {
  pushWrapped(lines, theme.fg("dim", joinHelpParts(parts)), renderWidth, " ");
}

/**
 * 原地追加一条区域之间的单横分隔线（`dim` 配色）
 * @param lines - 输出行数组（原地追加）
 * @param theme - 主题样式提供者
 * @param width - 分隔线可视宽度
 */
function pushBandRule(lines: string[], theme: Theme, width: number): void {
  lines.push(theme.fg("dim", divider(width, LAYOUT_CONFIG.dividerThin)));
}

/** 四个区域自上而下的内容（内容区由回调按剩余高度现算） */
export interface PageBands {
  /** 题目标题区：Tab 栏行（组件缓存） */
  readonly tabLines: readonly string[];
  /** 题目标题区：标题行（作答页为模式徽标与题名，总览页为总览标题与作答进度，编辑页为面包屑） */
  readonly titleLines: readonly string[];
  /** 作答区行（选项、补充与切换）；为空时不占行也不画分隔线 */
  readonly answerLines: readonly string[];
  /** 提示区：临时状态通知 */
  readonly statusMessage: string | null;
  /** 提示区：快捷键提示片段 */
  readonly helpParts: readonly string[];
}

/** 整页组装结果 */
export interface PageFrame {
  /** 整页终端行 */
  readonly lines: string[];
  /** 内容区占用的整页行范围（滚轮路由依据） */
  readonly contentBand: RowRange;
  /** 作答区首行；作答区为空时为 -1 */
  readonly answerStart: number;
}

/**
 * 按四个区域自上而下组装整页：题目标题区（Tab 栏 + 标题行）、内容区、作答区、提示区
 *
 * - 内容区吸收剩余高度，下限 `contentMinHeight`（标题、选项、状态与提示的折行均计入固定部分）
 * - 作答区为空时不输出其行，内容区直接衔接提示区
 * - 整页不画外框双横线：标题区与内容区之间、作答区（无作答时为内容区）与提示区之间各一条单横分隔线，内容区与作答区之间不画
 *
 * @param theme - 主题样式提供者
 * @param renderWidth - 终端布局列宽
 * @param terminalRows - 终端可视行数
 * @param bands - 四个区域中除内容区以外的行
 * @param buildContent - 按给定的内容区高度产出内容行
 * @returns 整页行、内容区行范围与作答区首行
 */
export function composePage(
  theme: Theme,
  renderWidth: number,
  terminalRows: number,
  bands: PageBands,
  buildContent: (height: number) => string[],
): PageFrame {
  const hintLines: string[] = [];
  pushStatusMessage(hintLines, theme, bands.statusMessage, renderWidth);
  pushHelpFooter(hintLines, bands.helpParts, theme, renderWidth);

  const hasAnswer = bands.answerLines.length > 0;
  const fixed =
    bands.tabLines.length +
    bands.titleLines.length +
    1 + // 标题区与内容区之间
    bands.answerLines.length +
    1 + // 作答区（无作答时为内容区）与提示区之间
    hintLines.length;
  const contentHeight = Math.max(LAYOUT_CONFIG.contentMinHeight, terminalRows - fixed);

  const lines: string[] = [];
  lines.push(...bands.tabLines, ...bands.titleLines);
  pushBandRule(lines, theme, renderWidth);
  const contentBand = { start: lines.length, end: lines.length + contentHeight };
  lines.push(...buildContent(contentHeight));

  // 内容区与作答区之间不画分隔线，作答区直接接在内容之后
  let answerStart = -1;
  if (hasAnswer) {
    answerStart = lines.length;
    lines.push(...bands.answerLines);
  }

  pushBandRule(lines, theme, renderWidth);
  lines.push(...hintLines);
  return { lines, contentBand, answerStart };
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

/** 按钮组的单个按钮测量结果 */
interface ButtonCell {
  /** 框线前景色令牌 */
  readonly tone: ThemeColor;
  /** 按钮文字（可含换行与着色） */
  readonly text: string;
  /** 不折行时的自然可见列宽（按最宽一行计） */
  readonly natural: number;
}

/** 按钮的内容行已按分配到的列宽折行 */
interface ButtonBox extends ButtonCell {
  /** 折行后的内容行 */
  readonly contentLines: string[];
  /** 内容区可见列宽（取最长内容行，即框体宽度依据） */
  readonly inner: number;
}

/** 按钮组在可用宽度内的对齐方式：靠左、靠右或两端分开 */
export type ButtonAlign = "left" | "right" | "spread";

/**
 * 测量按钮文字的自然可见列宽（含宽字符与 ANSI 着色，多行取最宽一行）
 * @param text - 按钮文字
 * @returns 不折行所需的可见列宽；空文字为 0
 */
function naturalWidth(text: string): number {
  return text.split("\n").reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

/**
 * 在一行内分配各按钮的内容列宽
 *
 * 按自然宽度从小到大分配：窄按钮只拿自己需要的列数，剩下的一直向上浮到宽按钮，
 * 后者再按分配到的列宽折行。逐级均分而不一次性平分，是为了让短标签不被白白拉宽。
 *
 * @param naturals - 各按钮的自然列宽（与行内按钮同序）
 * @param available - 该行可用总宽度（已扣除缩进）
 * @returns 与 `naturals` 同序的内容列宽数组（每项至少 1 列）
 */
function innerWidths(naturals: readonly number[], available: number): number[] {
  const count = naturals.length;
  const budget = Math.max(count, available - (count - 1) * BUTTON_GAP - count * BUTTON_CHROME_WIDTH);
  const order = naturals.map((natural, index) => ({ natural, index })).sort((a, b) => a.natural - b.natural);
  const widths = new Array<number>(count).fill(1);

  let remaining = budget;
  for (const [position, entry] of order.entries()) {
    const share = Math.max(1, Math.floor(remaining / (count - position)));
    const width = Math.min(entry.natural, share);
    widths[entry.index] = width;
    remaining = Math.max(0, remaining - width);
  }
  return widths;
}

/**
 * 该行压到最小可接受宽度时占用的总列数
 *
 * 每个按钮最多压缩到自然宽度的 `buttonShareShrinkRatio`（文字换行但不会被切成碎条），
 * 总和装得下才允许共享同一行。
 *
 * @param cells - 待同行的按钮
 * @returns 含框线与间隙的总列数
 */
function rowNeed(cells: readonly ButtonCell[]): number {
  const inner = cells.reduce(
    (sum, cell) => sum + Math.max(1, Math.ceil(cell.natural * LAYOUT_CONFIG.buttonShareShrinkRatio)),
    0,
  );
  return inner + (cells.length - 1) * BUTTON_GAP + cells.length * BUTTON_CHROME_WIDTH;
}

/**
 * 渲染横排字符框架按钮组：上缘 `┌ ─ ┐`、两侧 `│`、下缘 `┕ ━ ┙`
 *
 * - 分行按“压缩后仍能审读”判定：一行里的每个按钮最多占自然宽度的 `buttonShareShrinkRatio` 就能装下时才同行，否则另起一行
 * - 行内列宽递进均分：窄按钮先拿足自然宽度，剩下的全部给宽按钮，超过分配宽度的文字按列折行
 * - 同一行内按钮高度取该行最大值，短按钮的内容区补空行保持上下缘对齐
 * - `align` 决定整组靠向：靠左首列留 `inset` 列，靠右末列距右缘 `inset` 列，两端分开时首按钮靠左、末按钮靠右、余下列宽均分给列间隙
 *
 * @param theme - 主题样式提供者
 * @param buttons - 按钮序列（空数组时无输出行）
 * @param maxWidth - 可用总宽度（含缩进）
 * @param align - 对齐方式
 * @param inset - 靠向一侧的空白列数
 * @returns 整组行与各按钮矩形范围
 */
export function renderButtonGroup(
  theme: Theme,
  buttons: readonly ButtonSpec[],
  maxWidth: number,
  align: ButtonAlign = "left",
  inset = 0,
): ButtonGroup {
  const frame = LAYOUT_CONFIG.buttonFrame;
  const available = Math.max(BUTTON_CHROME_WIDTH + 1, maxWidth - inset);

  const cells: ButtonCell[] = buttons.map((button) => ({
    tone: button.tone,
    text: button.text,
    natural: Math.max(1, naturalWidth(button.text)),
  }));

  // 分行：与同行的下一个按钮一起压缩到最小可接受宽度仍装得下时同行，否则另起一行
  const rows: ButtonCell[][] = [];
  for (const cell of cells) {
    const current = rows[rows.length - 1];
    if (current && rowNeed([...current, cell]) <= available) {
      current.push(cell);
    } else {
      rows.push([cell]);
    }
  }

  const lines: string[] = [];
  const rects: ButtonRect[] = [];
  for (const row of rows) {
    const widths = innerWidths(
      row.map((cell) => cell.natural),
      available,
    );
    const boxes: ButtonBox[] = row.map((cell, index) => {
      const contentLines = wrapTextWithAnsi(cell.text, widths[index] ?? 1);
      const inner = contentLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
      return { ...cell, contentLines, inner };
    });

    const rowWidth =
      boxes.reduce((sum, box) => sum + box.inner + BUTTON_CHROME_WIDTH, 0) + (boxes.length - 1) * BUTTON_GAP;
    const leftPad = align === "right" ? Math.max(0, maxWidth - inset - rowWidth) : inset;
    const gaps = rowGaps(align, boxes.length, rowWidth, available);
    const padStr = " ".repeat(leftPad);
    const join = (parts: readonly string[]): string =>
      parts.map((part, index) => (index === 0 ? part : " ".repeat(gaps[index - 1] ?? BUTTON_GAP) + part)).join("");

    const height = Math.max(...boxes.map((box) => box.contentLines.length));
    const tops: string[] = [];
    const bottoms: string[] = [];
    const columns: string[][] = [];
    const spans: RowRange[] = [];
    let column = leftPad;

    for (const [index, box] of boxes.entries()) {
      const width = box.inner + BUTTON_CHROME_WIDTH;
      const side = theme.fg(box.tone, frame.side);
      tops.push(theme.fg(box.tone, frame.topLeft + frame.top.repeat(box.inner + 2) + frame.topRight));
      bottoms.push(theme.fg(box.tone, frame.bottomLeft + frame.bottom.repeat(box.inner + 2) + frame.bottomRight));
      columns.push(
        Array.from(
          { length: height },
          (_, lineIndex) => `${side} ${padToVisibleWidth(box.contentLines[lineIndex] ?? "", box.inner)} ${side}`,
        ),
      );
      spans.push({ start: column, end: column + width });
      column += width + (gaps[index] ?? BUTTON_GAP);
    }

    const top = lines.length;
    lines.push(padStr + join(tops));
    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      lines.push(padStr + join(columns.map((columnLines) => columnLines[lineIndex] ?? "")));
    }
    lines.push(padStr + join(bottoms));
    for (const span of spans) rects.push({ rows: { start: top, end: lines.length }, cols: span });
  }

  return { lines, rects };
}

/** 左侧按钮与右侧可折行文字的排版产物 */
export interface LeadingButtonBlock {
  /** 整块行（行号为块内相对行） */
  readonly lines: string[];
  /** 按钮矩形（行号为块内相对行） */
  readonly rect: ButtonRect;
}

/**
 * 排版「按钮在左、文字在右」的一整块：文字首行与按钮内容行同行，超宽部分向下折行并对齐文字起始列
 *
 * - 文字可用列宽取总宽减去按钮与间隙，低于 `leadingTextMinWidth` 时改为按钮在上、文字在下堆叠
 * - 按钮下缘以下的折行直接排在文字起始列，不额外缩进
 *
 * @param theme - 主题样式提供者
 * @param button - 左侧按钮
 * @param text - 右侧文字（可含着色，按列折行）
 * @param maxWidth - 可用总宽度（含缩进）
 * @param inset - 按钮左侧空白列数
 * @returns 整块行与按钮矩形
 */
export function renderLeadingButton(
  theme: Theme,
  button: ButtonSpec,
  text: string,
  maxWidth: number,
  inset = 0,
): LeadingButtonBlock {
  const group = renderButtonGroup(theme, [button], maxWidth, "left", inset);
  const rect = group.rects[0] ?? { rows: { start: 0, end: 0 }, cols: { start: inset, end: inset } };
  const textLeft = rect.cols.end + 1;

  if (maxWidth - textLeft < LAYOUT_CONFIG.leadingTextMinWidth) {
    const wrapped = wrapTextWithAnsi(text, Math.max(1, maxWidth - inset));
    return { lines: [...group.lines, ...wrapped.map((line) => " ".repeat(inset) + line)], rect };
  }

  const wrapped = wrapTextWithAnsi(text, maxWidth - textLeft);
  const height = Math.max(group.lines.length, 1 + wrapped.length);
  const lines = Array.from({ length: height }, (_, row) => {
    const frameLine = group.lines[row];
    const textLine = wrapped[row - 1];
    if (textLine === undefined) return frameLine ?? "";
    return `${padToVisibleWidth(frameLine ?? "", textLeft)}${textLine}`;
  });
  return { lines, rect };
}

/**
 * 计算一行内相邻按钮之间的列间隙数
 * @param align - 对齐方式
 * @param count - 该行按钮数
 * @param rowWidth - 该行按钮与基础列间隙的总宽
 * @param available - 可用总宽度（已扣除缩进）
 * @returns 长度恒为 `count - 1` 的间隙数组
 */
function rowGaps(align: ButtonAlign, count: number, rowWidth: number, available: number): number[] {
  const gaps = count - 1;
  if (gaps <= 0) return [];
  if (align !== "spread") return new Array(gaps).fill(1);
  const free = Math.max(0, available - rowWidth);
  const share = Math.floor(free / gaps);
  let remainder = free % gaps;
  return Array.from({ length: gaps }, () => 1 + share + (remainder-- > 0 ? 1 : 0));
}
