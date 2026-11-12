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
  type EditTarget,
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
  renderButtonGroup,
  type ButtonRect,
  type ButtonSpec,
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

/** 补充说明按钮在整页中的可点击矩形范围 */
export interface NoteButtonHit {
  /** 点击后打开的批注编辑器目标 */
  readonly target: EditTarget;
  /** 按钮矩形 */
  readonly rect: ButtonRect;
}

/** 题目底部操作按钮的种类：补充说明入口 / 确认推进 */
export type QuestionActionKind = "note" | "confirm";

/** 题目底部操作按钮在整页中的可点击矩形范围 */
export interface QuestionActionHit {
  /** 按钮种类 */
  readonly action: QuestionActionKind;
  /** 按钮矩形 */
  readonly rect: ButtonRect;
}

/**
 * 把按钮组的相对矩形平移为整页矩形
 * @param rect - 相对行号的矩形
 * @param rowOffset - 该行数组在整页中的起始行
 * @returns 行号平移后的矩形，列区间不变
 */
function offsetRect(rect: ButtonRect, rowOffset: number): ButtonRect {
  return { rows: { start: rect.rows.start + rowOffset, end: rect.rows.end + rowOffset }, cols: rect.cols };
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
  /** 补充说明按钮的整页矩形范围（鼠标点击路由依据） */
  readonly noteButtonHits?: readonly NoteButtonHit[];
  /** 题目底部操作按钮的整页矩形范围（鼠标点击路由依据） */
  readonly actionButtonHits?: readonly QuestionActionHit[];
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

    // 补充说明按钮组（题目整体补充 + 当前聚焦选项专属补充），整框可点击
    const noteButtonHits = this.pushNoteButtons(body, q, st, currentItem, renderWidth);
    body.push("");

    const menuItemHits = this.pushListItems(body, q, st, state, renderWidth - 2);

    // 选项列表之后的操作按钮组（补充说明入口 + 确认推进），贴右缘
    body.push("");
    const actionButtonHits = this.pushActionButtons(body, state.tab, renderWidth);

    pushStatusMessage(body, this.theme, state.statusMessage);

    body.push("");
    const helpParts: string[] = [TEXTS.help.switchQuestion];
    if (this.model.getVisibleQuestionIndices().length > 1) {
      helpParts.push(TEXTS.help.jumpQuestion);
    }
    helpParts.push(TEXTS.help.moveCursor);
    if (currentItem) {
      helpParts.push(TEXTS.help.editOptionNote);
      helpParts.push(TEXTS.help.editQuestionNote);
    } else {
      helpParts.push(TEXTS.help.editNote);
    }
    const optHasNote = currentItem ? st.optionNotes.has(currentItem.optionIndex) : false;
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
    const currentOptNote = currentItem ? st.optionNotes.get(currentItem.optionIndex) : undefined;
    const preview = this.renderPreviewBand(
      state.tab,
      currentItem,
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
      noteButtonHits: noteButtonHits.map((hit) => ({ target: hit.target, rect: offsetRect(hit.rect, bodyStart) })),
      actionButtonHits: actionButtonHits.map((hit) => ({ action: hit.action, rect: offsetRect(hit.rect, bodyStart) })),
    };
  }

  /**
   * 追加题目底部的操作按钮组（补充说明入口 + 确认推进）
   * 整组贴右缘，确认按钮框线随作答达标与否换色
   * @param lines - 输出行数组（原地追加）
   * @param tab - 题目索引
   * @param renderWidth - 终端布局列宽
   * @returns 各按钮在 `lines` 中的相对矩形
   */
  private pushActionButtons(lines: string[], tab: number, renderWidth: number): QuestionActionHit[] {
    const actions = this.model.getQuestionActions(tab);
    if (!actions) return [];

    const buttons: { action: QuestionActionKind; spec: ButtonSpec }[] = [];
    if (actions.note) {
      const filled = hasQuestionNote(this.model.getState(tab));
      buttons.push({ action: "note", spec: { text: actions.note, tone: filled ? "success" : "muted" } });
    }
    buttons.push({
      action: "confirm",
      spec: {
        text: actions.confirm,
        tone: this.model.isQuestionAnswered(tab) ? "success" : "accent",
      },
    });

    const group = renderButtonGroup(
      this.theme,
      buttons.map((button) => button.spec),
      renderWidth,
      "right",
    );
    const start = lines.length;
    lines.push(...group.lines);

    const hits: QuestionActionHit[] = [];
    for (const [index, rect] of group.rects.entries()) {
      const button = buttons[index];
      if (!button) continue;
      hits.push({ action: button.action, rect: offsetRect(rect, start) });
    }
    return hits;
  }

  /**
   * 追加补充说明按钮组（题目整体补充 + 当前聚焦选项的专属补充）
   * 按钮框整体可点击，点击后打开对应批注的编辑器
   * @param lines - 输出行数组（原地追加）
   * @param q - 当前题目
   * @param st - 作答状态
   * @param currentItem - 聚焦菜单项（选项专属补充按钮的索引来源）
   * @param renderWidth - 终端布局列宽
   * @returns 各按钮在 `lines` 中的相对矩形
   */
  private pushNoteButtons(
    lines: string[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    currentItem: MenuItem | undefined,
    renderWidth: number,
  ): NoteButtonHit[] {
    const hits: NoteButtonHit[] = [];
    const pushButton = (target: EditTarget, text: string): void => {
      const group = renderButtonGroup(
        this.theme,
        [{ text: this.theme.fg("success", text), tone: "success" }],
        renderWidth,
        "left",
        LAYOUT_CONFIG.noteButtonIndent,
      );
      const rect = group.rects[0];
      if (!rect) return;
      hits.push({ target, rect: offsetRect(rect, lines.length) });
      lines.push(...group.lines);
    };

    const questionNote = st.customText?.trim();
    if (questionNote) pushButton({ type: "question" }, TEXTS.view.attachedNoteBanner(questionNote));

    if (currentItem) {
      const optionNote = st.optionNotes.get(currentItem.optionIndex)?.trim();
      if (optionNote) {
        pushButton(
          { type: "option", optionIndex: currentItem.optionIndex },
          TEXTS.view.optionAttachedNoteBanner(optionLabelOf(q, currentItem.optionIndex), optionNote),
        );
      }
    }
    return hits;
  }

  /**
   * 获取聚焦选项的完整内容行（经 `previewCache` 缓存，跨选项切换零重复解析）
   * @param tab - 题目索引
   * @param item - 目标菜单项
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @returns 未切片的完整内容行数组
   */
  private previewContentLines(
    tab: number,
    item: MenuItem,
    optionNote: string | undefined,
    targetWidth: number,
  ): string[] {
    // 定界拼接杜绝变长字段歧义（字段值均已剥离控制字符）
    const cacheKey = [tab, item.optionIndex, targetWidth, optionNote ?? ""].join("\x1f");

    const cached = this.previewCache.get(cacheKey);
    if (cached) return cached;

    const fullLines = buildFullPreviewContentLines(item, optionNote, targetWidth, this.theme);
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
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @param height - 预览区占用的终端行数（不足时补空行）
   * @param scrollOffset - 当前预览滚动位移
   * @returns 恰好 `height` 行的预览区与本帧视口观察值
   */
  private renderPreviewBand(
    tab: number,
    item: MenuItem | undefined,
    optionNote: string | undefined,
    targetWidth: number,
    height: number,
    scrollOffset: number,
  ): RenderedPreviewBand {
    const fullLines = item ? this.previewContentLines(tab, item, optionNote, targetWidth) : [];
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
