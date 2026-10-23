/**
 * @file view-question.ts
 * @description 题目作答页的视图构建器：题头、选项菜单、双栏 / 单栏预览与底部按键提示
 *
 * 核心架构特性：
 * - 只读取组件传入的视口状态并返回终端行，滚动位移与光标写入仍由组件在输入路径完成
 * - 预览完整内容按「题号 + 条目 + 列宽 + 批注」缓存，左栏按「题号 + 光标 + 位移 + revision + 列宽」缓存；`clear()` 由组件在状态突变与主题切换时调用
 * - 双栏与单栏的判定、视口高度与帮助行组装集中在此，组件只做模式选择
 *
 * 依赖方向：view-question.ts → format.ts / layout.ts / model.ts / novel-markdown.ts / texts.ts / theme.ts / view-rows.ts；禁止反向导入 component.ts
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { clamp, clampWindowOffset, padToVisibleWidth, pushWrapped, safeLine, windowSlice } from "./format.js";
import { LAYOUT_CONFIG } from "./layout.js";
import {
  hasQuestionNote,
  type AskAuthorFormModel,
  type MenuItem,
  type NormalizedQuestion,
  type QuestionAnswerState,
} from "./model.js";
import { buildFullPreviewContentLines } from "./novel-markdown.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { formatMenuItemRow, optionLabelOf, pushFrameRule, pushHelpFooter, pushStatusMessage } from "./view-rows.js";

/** 预览缓存池容量上限（条目数），防止长会话下缓存无界增长 */
const PREVIEW_CACHE_CAPACITY = 32;

/** 题目作答页的只读视口状态（全部字段来自组件，构建器不写回） */
export interface QuestionViewState {
  /** 当前题目索引（0-based；调用方保证不是总览页） */
  readonly tab: number;
  /** 当前聚焦菜单项索引 */
  readonly optionIndex: number;
  /** 左栏菜单滚动位移（行） */
  readonly listScrollOffset: number;
  /** 预览区滚动位移（行） */
  readonly previewScrollOffset: number;
  /** 底部临时状态通知（可为空） */
  readonly statusMessage: string | null;
  /** 当前题目的菜单项（由模型派生并记忆化） */
  readonly menuItems: readonly MenuItem[];
  /** 本题确认后是否会发起实时推演（题头展示推演标记） */
  readonly expandable: boolean;
}

/** 预览视口观察值：渲染后回传组件，供输入路径归一化滚动位移 */
export interface PreviewViewport {
  /** 未切片的完整内容行数 */
  readonly total: number;
  /** 本帧视口高度（行） */
  readonly viewHeight: number;
}

/** 题目作答页渲染结果 */
export interface QuestionViewResult {
  /** 整页终端行（含底部状态、帮助与框架线） */
  readonly lines: string[];
  /** 本帧预览视口；未渲染预览时为 undefined（沿用上一帧观察值） */
  readonly previewViewport?: PreviewViewport;
}

/**
 * 双栏右侧预览视口高度（随终端高度收缩；区间 `[6, LAYOUT_CONFIG.splitPreviewHeight]`）
 * @param terminalRows - 终端可视行数
 * @returns 视口最大行数
 */
export function splitPreviewHeight(terminalRows: number): number {
  return clamp(terminalRows - 14, 6, LAYOUT_CONFIG.splitPreviewHeight);
}

/**
 * 单栏内联预览视口高度（随终端高度收缩；区间 `[3, LAYOUT_CONFIG.singlePreviewHeight]`）
 * @param terminalRows - 终端可视行数
 * @returns 视口最大行数
 */
export function singlePreviewHeight(terminalRows: number): number {
  return clamp(terminalRows - 18, 3, LAYOUT_CONFIG.singlePreviewHeight);
}

/**
 * 判定题目是否含富内容（存在可见预览、较长推演或选项批注），决定是否启用双栏
 * @param model - 问卷模型（读取选项可见性）
 * @param tab - 题目索引
 * @param q - 归一化题目
 * @param st - 作答状态
 * @returns 任一可见选项满足富内容条件时为 true
 */
function hasRichContent(
  model: AskAuthorFormModel,
  tab: number,
  q: NormalizedQuestion,
  st: QuestionAnswerState,
): boolean {
  return q.options.some(
    (o, idx) =>
      model.isOptionVisible(tab, idx) &&
      (Boolean(o.preview) || visibleWidth(o.description ?? "") > 30 || Boolean(st.optionNotes.get(idx))),
  );
}

/**
 * 题目作答页视图构建器（持有预览与左栏缓存；模型与主题在构造期固定）
 */
export class QuestionView {
  /** 预览框完整渲染行缓存池（键：题号 + 条目身份 + 列宽 + 补充说明；超容量按插入序淘汰） */
  private readonly previewCache = new Map<string, string[]>();

  /** 左栏菜单行缓存（键：题号 + 光标 + 位移 + revision + 左栏宽） */
  private leftColCache?: { key: string; lines: string[] };

  /**
   * @param theme - 当前 TUI 主题
   * @param model - 问卷模型（只读访问）
   */
  constructor(
    private readonly theme: Theme,
    private readonly model: AskAuthorFormModel,
  ) {}

  /** 清空预览池与左栏缓存（状态突变、主题切换与组件回收时调用） */
  clear(): void {
    this.previewCache.clear();
    this.leftColCache = undefined;
  }

  /** 只清空左栏菜单行缓存（焦点变化时调用，保留已解析的预览内容） */
  clearColumnCache(): void {
    this.leftColCache = undefined;
  }

  /**
   * 渲染题目作答页
   * @param state - 只读视口状态（当前题、光标、滚动位移、状态通知与菜单项）
   * @param renderWidth - 终端布局列宽
   * @param terminalRows - 终端可视行数（决定预览视口高度）
   * @returns 整页终端行与本帧预览视口
   */
  render(state: QuestionViewState, renderWidth: number, terminalRows: number): QuestionViewResult {
    const q = this.model.getQuestion(state.tab);
    if (!q) return { lines: [] };

    const st = this.model.getState(state.tab);
    const lines: string[] = [];

    // 1. 题目标签与标题
    const visibleOptionCount = q.options.filter((_, idx) => this.model.isOptionVisible(state.tab, idx)).length;
    const modeTag = q.multiSelect
      ? this.theme.fg("warning", TEXTS.view.modeMulti(q.minSelect, q.maxSelect, visibleOptionCount, q.allowEmpty))
      : this.theme.fg("accent", TEXTS.view.modeSingle);
    const conditionalTag = q.showIf.length > 0 ? ` ${this.theme.fg("muted", TEXTS.view.conditionalBadge)}` : "";
    const expansionTag = state.expandable ? ` ${this.theme.fg("warning", TEXTS.view.expansionBadge)}` : "";
    pushWrapped(lines, ` ${modeTag}${conditionalTag}${expansionTag} ${this.theme.bold(q.title)}`, renderWidth);

    if (q.description) {
      pushWrapped(lines, this.theme.fg("muted", q.description), renderWidth, "  ");
    }

    // 2. 补充说明横幅（题目整体补充 + 当前聚焦选项专属补充）
    if (st.customText?.trim()) {
      pushWrapped(lines, this.theme.fg("success", TEXTS.view.attachedNoteBanner(st.customText)), renderWidth, "  ");
    }
    const currentItem = state.menuItems[state.optionIndex];
    if (currentItem?.type === "option" && currentItem.optionIndex !== undefined) {
      const optNote = st.optionNotes.get(currentItem.optionIndex)?.trim();
      if (optNote) {
        const optLabel = optionLabelOf(q, currentItem.optionIndex);
        pushWrapped(
          lines,
          this.theme.fg("success", TEXTS.view.optionAttachedNoteBanner(optLabel, optNote)),
          renderWidth,
          "  ",
        );
      }
    }
    lines.push("");

    // 3. 智能分屏 / 紧凑单栏（富内容按可视列宽判定）
    const rich = hasRichContent(this.model, state.tab, q, st);
    let previewViewport: PreviewViewport | undefined;
    if (renderWidth >= LAYOUT_CONFIG.splitViewMinWidth && rich) {
      previewViewport = this.renderSplitView(lines, q, st, state, renderWidth, terminalRows);
    } else {
      previewViewport = this.pushListItems(lines, q, st, state, renderWidth - 2, rich, terminalRows);
    }

    // 4. 底部状态通知与按键提示
    pushStatusMessage(lines, this.theme, state.statusMessage);

    lines.push("");
    const helpParts: string[] = [TEXTS.help.switchQuestion];
    if (this.model.getVisibleQuestionIndices().length > 1) {
      helpParts.push(TEXTS.help.jumpQuestion);
    }
    helpParts.push(TEXTS.help.moveCursor);
    if (currentItem?.type === "option") {
      helpParts.push(TEXTS.help.editOptionNote);
      helpParts.push(TEXTS.help.editQuestionNote);
    } else {
      helpParts.push(TEXTS.help.editNote);
    }
    const optHasNote =
      currentItem?.type === "option" &&
      currentItem.optionIndex !== undefined &&
      st.optionNotes.has(currentItem.optionIndex);
    if (optHasNote || hasQuestionNote(st)) {
      helpParts.push(TEXTS.help.clearNote);
    }
    helpParts.push(q.multiSelect ? TEXTS.help.toggleCheckMulti : TEXTS.help.selectOptionSingle);
    if (q.multiSelect) {
      helpParts.push(TEXTS.help.toggleAll);
      helpParts.push(TEXTS.help.confirmQuestion);
    }
    if (rich) helpParts.push(TEXTS.help.scrollDraft);
    helpParts.push(TEXTS.help.cancel);

    pushHelpFooter(lines, helpParts, this.theme, renderWidth);
    pushFrameRule(lines, this.theme, renderWidth);
    return { lines, previewViewport };
  }

  /**
   * 获取聚焦条目的预渲染完整内容行（`previewCache` 透明备忘缓存，跨条目 / 切换题目零重复解析）
   * @param tab - 题目索引
   * @param item - 目标菜单项
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @returns 未切片的完整内容行数组；`item` 缺省时返回空数组
   */
  private previewContentLines(
    tab: number,
    item: MenuItem,
    customText: string | undefined,
    optionNote: string | undefined,
    targetWidth: number,
  ): string[] {
    // 定界拼接杜绝变长字段歧义（字段值均已剥离控制字符）
    const cacheKey = [tab, item.type, item.optionIndex ?? -1, targetWidth, customText ?? "", optionNote ?? ""].join(
      "\x1f",
    );

    const cached = this.previewCache.get(cacheKey);
    if (cached) return cached;

    const fullLines = buildFullPreviewContentLines(item, customText, optionNote, targetWidth, this.theme);
    // 超容量按插入序淘汰最旧条目（`keys().next()` 在 Map 非空时必然产出条目）
    if (this.previewCache.size >= PREVIEW_CACHE_CAPACITY) {
      const oldest = this.previewCache.keys().next();
      if (!oldest.done) this.previewCache.delete(oldest.value);
    }
    this.previewCache.set(cacheKey, fullLines);
    return fullLines;
  }

  /**
   * 计算并切片本帧预览框行（纯计算，不写回滚动位移）
   * @param tab - 题目索引
   * @param item - 目标菜单项
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @param viewHeight - 视口最大行数
   * @param scrollOffset - 当前预览滚动位移
   * @returns 本帧可视内容行与视口观察值
   */
  private buildPreviewBox(
    tab: number,
    item: MenuItem,
    customText: string | undefined,
    optionNote: string | undefined,
    targetWidth: number,
    viewHeight: number,
    scrollOffset: number,
  ): { lines: string[]; viewport: PreviewViewport } {
    const fullLines = this.previewContentLines(tab, item, customText, optionNote, targetWidth);
    const total = fullLines.length;
    const offset = clampWindowOffset(scrollOffset, total, viewHeight);
    const boxLines = windowSlice(fullLines, offset, viewHeight).map((line) => safeLine(line, targetWidth));

    if (total > viewHeight) {
      const scrollInfo = TEXTS.view.previewScrollInfo(offset + 1, Math.min(total, offset + viewHeight), total);
      boxLines.push(safeLine(`  ${this.theme.fg("dim", scrollInfo)}`, targetWidth));
    }

    return { lines: boxLines, viewport: { total, viewHeight } };
  }

  /**
   * 渲染双栏视图（左选项菜单 + 右推演 / 分镜预览框）
   * @param lines - 输出行数组（原地追加）
   * @param q - 当前题目
   * @param st - 作答状态
   * @param state - 只读视口状态
   * @param renderWidth - 终端可用宽度
   * @param terminalRows - 终端可视行数
   * @returns 本帧预览视口观察值
   */
  private renderSplitView(
    lines: string[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    state: QuestionViewState,
    renderWidth: number,
    terminalRows: number,
  ): PreviewViewport {
    const leftWidth = clamp(
      Math.floor(renderWidth * LAYOUT_CONFIG.leftColRatio),
      LAYOUT_CONFIG.leftColMin,
      LAYOUT_CONFIG.leftColMax,
    );
    const rightWidth = Math.max(20, renderWidth - leftWidth - LAYOUT_CONFIG.dividerWidth);

    const leftCacheKey = `${state.tab}_${state.optionIndex}_${state.listScrollOffset}_${this.model.revision}_${leftWidth}`;
    let leftLines: string[];
    if (this.leftColCache && this.leftColCache.key === leftCacheKey) {
      leftLines = this.leftColCache.lines;
    } else {
      leftLines = [];
      this.pushListItems(leftLines, q, st, state, leftWidth, false, terminalRows);
      this.leftColCache = { key: leftCacheKey, lines: leftLines };
    }

    const currentItem = state.menuItems[state.optionIndex];
    const currentOptNote =
      currentItem?.type === "option" && currentItem.optionIndex !== undefined
        ? st.optionNotes.get(currentItem.optionIndex)
        : undefined;

    const preview =
      currentItem === undefined
        ? { lines: [] as string[], viewport: { total: 0, viewHeight: splitPreviewHeight(terminalRows) } }
        : this.buildPreviewBox(
            state.tab,
            currentItem,
            st.customText,
            currentOptNote,
            rightWidth,
            splitPreviewHeight(terminalRows),
            state.previewScrollOffset,
          );

    const maxRows = Math.max(leftLines.length, preview.lines.length);
    for (let r = 0; r < maxRows; r++) {
      const lText = leftLines[r] ?? "";
      const rText = preview.lines[r] ?? "";
      const divider = this.theme.fg("dim", LAYOUT_CONFIG.dividerChar);
      lines.push(`${padToVisibleWidth(lText, leftWidth)}${divider}${safeLine(rText, rightWidth)}`);
    }
    return preview.viewport;
  }

  /**
   * 遍历输出菜单项行，单栏模式下在聚焦项下方内联展开预览
   * @param lines - 输出行数组（原地追加）
   * @param q - 当前题目
   * @param st - 作答状态
   * @param state - 只读视口状态
   * @param rowWidth - 选项行可用列宽
   * @param expandFocused - 是否展开聚焦项预览（窗口外条目不访问）
   * @param terminalRows - 终端可视行数
   * @returns 本帧聚焦项预览视口；未展开预览时 undefined
   */
  private pushListItems(
    lines: string[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    state: QuestionViewState,
    rowWidth: number,
    expandFocused: boolean,
    terminalRows: number,
  ): PreviewViewport | undefined {
    if (state.listScrollOffset > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listTopMore(state.listScrollOffset)));
    }

    const visibleSlice = state.menuItems.slice(
      state.listScrollOffset,
      state.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount,
    );
    let viewport: PreviewViewport | undefined;
    for (const [offset, item] of visibleSlice.entries()) {
      if (!item) continue;
      const globalIndex = state.listScrollOffset + offset;
      const isFocused = globalIndex === state.optionIndex;

      // 预设选项与操作区（补充说明/确认按钮）之间间隔一行
      const prevItem = state.menuItems[globalIndex - 1];
      if (prevItem && prevItem.type === "option" && item.type !== "option") {
        lines.push("");
      }

      lines.push(...formatMenuItemRow(this.theme, item, isFocused, q, st, rowWidth));

      // 单栏模式且具备富文本内容时，在聚焦项下方展开预览
      if (
        isFocused &&
        expandFocused &&
        (item.type !== "option" || item.description || item.preview || st.optionNotes.has(item.optionIndex ?? -1))
      ) {
        lines.push("");
        const itemOptNote =
          item.type === "option" && item.optionIndex !== undefined ? st.optionNotes.get(item.optionIndex) : undefined;
        const preview = this.buildPreviewBox(
          state.tab,
          item,
          st.customText,
          itemOptNote,
          Math.max(10, rowWidth - 2),
          singlePreviewHeight(terminalRows),
          state.previewScrollOffset,
        );
        viewport = preview.viewport;
        for (const pl of preview.lines) lines.push(pl);
        lines.push("");
      }
    }

    const remainingBelow = state.menuItems.length - (state.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount);
    if (remainingBelow > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listBottomMore(remainingBelow)));
    }
    return viewport;
  }
}
