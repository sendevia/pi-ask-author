/**
 * @file view-question.ts
 * @description 题目作答页的视图构建：内容预览区、Tab 栏、题目标题块、选项菜单与底部按键提示
 *
 * 只读取组件传入的视口状态并返回终端行，滚动位移与光标写入由组件在输入路径完成
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { pushWrapped } from "./format.js";
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
import {
  buildScrollBand,
  formatMenuItemRow,
  optionLabelOf,
  pushFrameRule,
  pushHelpFooter,
  pushStatusMessage,
  type RowRange,
} from "./view-rows.js";

/** 预览缓存池容量上限（条目数），防止长会话下无界增长 */
const PREVIEW_CACHE_CAPACITY = 32;

/** 题目作答页的只读视口状态（全部字段来自组件，构建器不写回） */
export interface QuestionViewState {
  /** 当前题目索引（0-based；调用方保证不是总览页） */
  readonly tab: number;
  /** 当前聚焦菜单项索引 */
  readonly optionIndex: number;
  /** 选项菜单滚动位移（行） */
  readonly listScrollOffset: number;
  /** 预览区滚动位移（行） */
  readonly previewScrollOffset: number;
  /** 底部临时状态通知 */
  readonly statusMessage: string | null;
  /** 当前题目的菜单项（由模型派生并记忆化） */
  readonly menuItems: readonly MenuItem[];
  /** 本题确认后是否会发起实时推演（题头展示推演标记） */
  readonly expandable: boolean;
  /** 题目导航 Tab 栏行（组件缓存，作答页插在预览区之后） */
  readonly tabLines: readonly string[];
}

/** 预览视口观察值：渲染后回传组件，供输入路径归一化滚动位移 */
export interface PreviewViewport {
  /** 未切片的完整内容行数 */
  readonly total: number;
  /** 本帧视口高度（行） */
  readonly viewHeight: number;
}

/** 菜单项在整页中的可点击行范围 */
export interface MenuItemHit {
  /** 菜单项索引（`state.menuItems` 的下标） */
  readonly index: number;
  /** 该条目占用的整页行范围 */
  readonly range: RowRange;
}

/** 题目作答页渲染结果 */
export interface QuestionViewResult {
  /** 整页终端行（含底部状态、帮助与框架线） */
  readonly lines: string[];
  /** 本帧预览视口；未渲染预览时为 undefined（沿用上一帧观察值） */
  readonly previewViewport?: PreviewViewport;
  /** 本帧内容预览区行范围（滚轮路由依据） */
  readonly previewBand?: RowRange;
  /** Tab 栏占用的整页行范围（鼠标点击路由依据） */
  readonly tabRange?: RowRange;
  /** 各菜单项的整页行范围（鼠标点击路由依据） */
  readonly menuItemHits?: readonly MenuItemHit[];
}

/**
 * 判定题目是否含富内容（存在可见预览、较长推演或选项批注），决定帮助栏是否展示滚动草稿提示
 * @param model - 问卷模型（读取选项可见性）
 * @param tab - 题目索引
 * @param q - 归一化题目
 * @param st - 作答状态
 * @returns 任一可见选项描述超过 30 列、带预览或带批注时为 true
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

/** 内容预览区的本帧渲染结果 */
interface RenderedPreviewBand {
  /** 恰好 `height` 行的预览区行 */
  readonly lines: string[];
  /** 本帧预览视口观察值（可视行数已扣除滚动信息行） */
  readonly viewport: PreviewViewport;
}

/** 题目作答页视图构建器（持有预览缓存；模型与主题在构造期固定） */
export class QuestionView {
  /** 预览完整渲染行缓存池（键：题号 + 条目身份 + 列宽 + 批注；超容量按插入序淘汰） */
  private readonly previewCache = new Map<string, string[]>();

  /**
   * @param theme - 当前 TUI 主题
   * @param model - 问卷模型
   */
  constructor(
    private readonly theme: Theme,
    private readonly model: AskAuthorFormModel,
  ) {}

  /** 清空预览缓存池（状态突变、主题切换与组件回收时调用） */
  clear(): void {
    this.previewCache.clear();
  }

  /**
   * 渲染题目作答页：顶部分割线 → 内容预览区 → Tab 栏 → 标题块 → 选项区 → 状态与快捷键 → 底部分割线
   * @param state - 只读视口状态（当前题、光标、滚动位移、状态通知、菜单项与 Tab 栏）
   * @param renderWidth - 终端布局列宽
   * @param terminalRows - 终端可视行数（除预览区外的各带占完后，剩余行全部给预览区）
   * @returns 整页终端行与本帧预览视口
   */
  render(state: QuestionViewState, renderWidth: number, terminalRows: number): QuestionViewResult {
    const q = this.model.getQuestion(state.tab);
    if (!q) return { lines: [] };

    const st = this.model.getState(state.tab);
    const currentItem = state.menuItems[state.optionIndex];
    const rich = hasRichContent(this.model, state.tab, q, st);

    // 1. 预览区以下的各带：题目标题块、选项区、状态通知、快捷键与底部分割线
    const body: string[] = [];
    const visibleOptionCount = q.options.filter((_, idx) => this.model.isOptionVisible(state.tab, idx)).length;
    const modeTag = q.multiSelect
      ? this.theme.fg("warning", TEXTS.view.modeMulti(q.minSelect, q.maxSelect, visibleOptionCount, q.allowEmpty))
      : this.theme.fg("accent", TEXTS.view.modeSingle);
    const conditionalTag = q.showIf.length > 0 ? ` ${this.theme.fg("muted", TEXTS.view.conditionalBadge)}` : "";
    const expansionTag = state.expandable ? ` ${this.theme.fg("warning", TEXTS.view.expansionBadge)}` : "";
    pushWrapped(body, ` ${modeTag}${conditionalTag}${expansionTag} ${this.theme.bold(q.title)}`, renderWidth);

    if (q.description) {
      pushWrapped(body, this.theme.fg("muted", q.description), renderWidth, "  ");
    }

    // 补充说明横幅（题目整体补充 + 当前聚焦选项专属补充）
    if (st.customText?.trim()) {
      pushWrapped(body, this.theme.fg("success", TEXTS.view.attachedNoteBanner(st.customText)), renderWidth, "  ");
    }
    if (currentItem?.type === "option" && currentItem.optionIndex !== undefined) {
      const optNote = st.optionNotes.get(currentItem.optionIndex)?.trim();
      if (optNote) {
        const optLabel = optionLabelOf(q, currentItem.optionIndex);
        pushWrapped(
          body,
          this.theme.fg("success", TEXTS.view.optionAttachedNoteBanner(optLabel, optNote)),
          renderWidth,
          "  ",
        );
      }
    }
    body.push("");

    const menuItemHits = this.pushListItems(body, q, st, state, renderWidth - 2);

    pushStatusMessage(body, this.theme, state.statusMessage);

    body.push("");
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

    pushHelpFooter(body, helpParts, this.theme, renderWidth);
    pushFrameRule(body, this.theme, renderWidth);

    // 2. 预览区占满终端剩余高度（不设上限）
    const previewHeight = Math.max(
      LAYOUT_CONFIG.previewMinHeight,
      terminalRows - 1 - state.tabLines.length - body.length,
    );
    const currentOptNote =
      currentItem?.type === "option" && currentItem.optionIndex !== undefined
        ? st.optionNotes.get(currentItem.optionIndex)
        : undefined;
    const preview = this.renderPreviewBand(
      state.tab,
      currentItem,
      st.customText,
      currentOptNote,
      renderWidth,
      previewHeight,
      state.previewScrollOffset,
    );

    // 3. 按带序输出整页（顶部分割线占首行，预览区紧接其后）
    const lines: string[] = [];
    pushFrameRule(lines, this.theme, renderWidth);
    lines.push(...preview.lines, ...state.tabLines, ...body);
    const bodyStart = 1 + previewHeight + state.tabLines.length;
    return {
      lines,
      previewViewport: preview.viewport,
      previewBand: { start: 1, end: 1 + previewHeight },
      tabRange: { start: 1 + previewHeight, end: 1 + previewHeight + state.tabLines.length },
      menuItemHits: menuItemHits.map((hit) => ({
        index: hit.index,
        range: { start: bodyStart + hit.range.start, end: bodyStart + hit.range.end },
      })),
    };
  }

  /**
   * 获取聚焦条目的完整内容行（经 `previewCache` 缓存，跨条目切换零重复解析）
   * @param tab - 题目索引
   * @param item - 目标菜单项
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @returns 未切片的完整内容行数组
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
   * 计算并切片本帧内容预览区（纯计算，不写回滚动位移）
   * @param tab - 题目索引
   * @param item - 聚焦菜单项（缺省时预览区留空）
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @param height - 预览区占用的终端行数（不足时补空行）
   * @param scrollOffset - 当前预览滚动位移
   * @returns 恰好 `height` 行的预览区与本帧视口观察值
   */
  private renderPreviewBand(
    tab: number,
    item: MenuItem | undefined,
    customText: string | undefined,
    optionNote: string | undefined,
    targetWidth: number,
    height: number,
    scrollOffset: number,
  ): RenderedPreviewBand {
    const fullLines = item ? this.previewContentLines(tab, item, customText, optionNote, targetWidth) : [];
    const band = buildScrollBand(fullLines, height, scrollOffset, this.theme, targetWidth);
    return { lines: band.lines, viewport: { total: fullLines.length, viewHeight: band.viewHeight } };
  }

  /**
   * 遍历输出菜单项行（聚焦项以反白行标出）
   * @param lines - 输出行数组（原地追加）
   * @param q - 当前题目
   * @param st - 作答状态
   * @param state - 只读视口状态
   * @param rowWidth - 选项行可用列宽
   * @returns 各菜单项在 `lines` 中的相对行范围（供调用方换算为整页行号）
   */
  private pushListItems(
    lines: string[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    state: QuestionViewState,
    rowWidth: number,
  ): MenuItemHit[] {
    const hits: MenuItemHit[] = [];
    if (state.listScrollOffset > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listTopMore(state.listScrollOffset)));
    }

    const visibleSlice = state.menuItems.slice(
      state.listScrollOffset,
      state.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount,
    );
    for (const [offset, item] of visibleSlice.entries()) {
      if (!item) continue;
      const globalIndex = state.listScrollOffset + offset;
      const isFocused = globalIndex === state.optionIndex;

      // 预设选项与操作区（补充说明/确认按钮）之间间隔一行
      const prevItem = state.menuItems[globalIndex - 1];
      if (prevItem && prevItem.type === "option" && item.type !== "option") {
        lines.push("");
      }

      const rowLines = formatMenuItemRow(this.theme, item, isFocused, q, st, rowWidth);
      hits.push({ index: globalIndex, range: { start: lines.length, end: lines.length + rowLines.length } });
      lines.push(...rowLines);
    }

    const remainingBelow = state.menuItems.length - (state.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount);
    if (remainingBelow > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listBottomMore(remainingBelow)));
    }
    return hits;
  }
}
