/**
 * @file view-question.ts
 * @description 题目作答页的视图构建：题目标题区、内容预览区、作答区（选项、补充与切换）与提示区
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
  composePage,
  formatMenuItemRow,
  renderButtonGroup,
  renderContentSections,
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
  /** 底部临时状态通知（提示区首行） */
  readonly statusMessage: string | null;
  /** 当前题目的菜单项（由模型派生并记忆化） */
  readonly menuItems: readonly MenuItem[];
  /** 题目导航 Tab 栏行（组件缓存，位于题目标题区首行） */
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

/** 选项下方动作区的按钮种类：选项补充 / 题目补充 / 确认推进 */
export type QuestionActionKind = "optionNote" | "questionNote" | "confirm";

/** 动作区按钮在整页中的可点击矩形范围 */
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
  /** 整页终端行（四个区域与顶底框架线） */
  readonly lines: string[];
  /** 本帧预览视口；未渲染预览时为 undefined（沿用上一帧观察值） */
  readonly previewViewport?: PreviewViewport;
  /** 本帧内容预览区行范围（滚轮路由依据） */
  readonly previewBand?: RowRange;
  /** Tab 栏占用的整页行范围（鼠标点击路由依据） */
  readonly tabRange?: RowRange;
  /** 各菜单项的整页行范围（鼠标点击路由依据） */
  readonly menuItemHits?: readonly MenuItemHit[];
  /** 作答区动作按钮的整页矩形范围（鼠标点击路由依据） */
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
   * 渲染题目作答页：题目标题区（Tab 栏 + 模式徽标与题名）→ 内容预览区 → 作答区（选项菜单与动作按钮组）→ 提示区
   * @param state - 只读视口状态（当前题、光标、滚动位移、状态通知、菜单项与 Tab 栏）
   * @param renderWidth - 终端布局列宽
   * @param terminalRows - 终端可视行数（内容区吸收剩余高度）
   * @returns 整页终端行、本帧预览视口与各可点击区域
   */
  render(state: QuestionViewState, renderWidth: number, terminalRows: number): QuestionViewResult {
    const q = this.model.getQuestion(state.tab);
    if (!q) return { lines: [] };

    const st = this.model.getState(state.tab);
    const currentItem = state.menuItems[state.optionIndex];
    const rich = hasRichContent(this.model, state.tab, q, st);

    // 1. 题目标题区：题名与题干说明（题目类型标记已在 Tab 标签上）
    const titleLines: string[] = [];
    pushWrapped(titleLines, this.theme.bold(q.title), renderWidth);
    if (q.description) pushWrapped(titleLines, this.theme.fg("muted", q.description), renderWidth);

    // 2. 作答区：选项菜单与下方的动作按钮组（选项补充 / 题目补充 / 确认）
    const answer: string[] = [];
    const menuItemHits = this.pushListItems(answer, q, st, state, renderWidth - 2);
    answer.push("");
    const actionButtonHits = this.pushActionButtons(answer, state, renderWidth);

    // 3. 提示区：快捷键提示
    const helpParts: string[] = [TEXTS.help.switchQuestion];
    if (this.model.getVisibleQuestionIndices().length > 1) helpParts.push(TEXTS.help.jumpQuestion);
    helpParts.push(TEXTS.help.moveCursor);
    if (currentItem) {
      helpParts.push(TEXTS.help.editOptionNote);
      helpParts.push(TEXTS.help.editQuestionNote);
    } else {
      helpParts.push(TEXTS.help.editNote);
    }
    const optHasNote = currentItem ? st.optionNotes.has(currentItem.optionIndex) : false;
    if (optHasNote || hasQuestionNote(st)) helpParts.push(TEXTS.help.clearNote);
    helpParts.push(q.multiSelect ? TEXTS.help.toggleCheckMulti : TEXTS.help.selectOptionSingle);
    if (q.multiSelect) {
      helpParts.push(TEXTS.help.toggleAll);
      helpParts.push(TEXTS.help.confirmQuestion);
    }
    if (rich) helpParts.push(TEXTS.help.scrollDraft);
    helpParts.push(TEXTS.help.cancel);

    // 4. 内容区：题目内容区与补充预览区，共占四个区域之外的全部高度
    let viewport: PreviewViewport | undefined;
    const page = composePage(
      this.theme,
      renderWidth,
      terminalRows,
      { tabLines: state.tabLines, titleLines, answerLines: answer, statusMessage: state.statusMessage, helpParts },
      (height) => {
        const content = this.renderContentBand(q, st, state, currentItem, renderWidth, height);
        viewport = content.viewport;
        return content.lines;
      },
    );

    const shift = (range: RowRange): RowRange => ({
      start: range.start + page.answerStart,
      end: range.end + page.answerStart,
    });
    const shiftRect = (rect: ButtonRect): ButtonRect => ({ rows: shift(rect.rows), cols: rect.cols });
    return {
      lines: page.lines,
      previewViewport: viewport,
      previewBand: page.contentBand,
      tabRange: { start: 0, end: state.tabLines.length },
      menuItemHits: menuItemHits.map((hit) => ({ index: hit.index, range: shift(hit.range) })),
      actionButtonHits: actionButtonHits.map((hit) => ({ action: hit.action, rect: shiftRect(hit.rect) })),
    };
  }

  /**
   * 追加作答区的动作按钮组（选项补充、题目补充与确认推进成组靠右）
   * 一行放不下时按全局按钮规则自动换行；确认按钮框线随作答达标与否换色
   * @param lines - 输出行数组（原地追加）
   * @param state - 只读视口状态（题号与聚焦菜单项）
   * @param renderWidth - 终端布局列宽
   * @returns 各按钮在 `lines` 中的相对矩形
   */
  private pushActionButtons(lines: string[], state: QuestionViewState, renderWidth: number): QuestionActionHit[] {
    const focused = state.menuItems[state.optionIndex];
    const actions = this.model.getQuestionActions(state.tab, focused?.optionIndex);
    if (!actions) return [];

    const st = this.model.getState(state.tab);
    const buttons: { action: QuestionActionKind; spec: ButtonSpec }[] = [];
    if (actions.optionNote && focused) {
      const filled = (st.optionNotes.get(focused.optionIndex)?.trim() ?? "") !== "";
      buttons.push({ action: "optionNote", spec: { text: actions.optionNote, tone: filled ? "success" : "muted" } });
    }
    if (actions.questionNote) {
      buttons.push({
        action: "questionNote",
        spec: { text: actions.questionNote, tone: hasQuestionNote(st) ? "success" : "muted" },
      });
    }
    buttons.push({
      action: "confirm",
      spec: { text: actions.confirm, tone: this.model.isQuestionAnswered(state.tab) ? "success" : "accent" },
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
   * 获取聚焦选项的题目内容行（经 `previewCache` 缓存，跨选项切换零重复解析）
   * @param tab - 题目索引
   * @param item - 目标菜单项
   * @param targetWidth - 预览可用列宽
   * @returns 未切片的完整内容行数组
   */
  private previewContentLines(tab: number, item: MenuItem, targetWidth: number): string[] {
    // 定界拼接杜绝变长字段歧义（字段值均已剥离控制字符）
    const cacheKey = [tab, item.optionIndex, targetWidth].join("\x1f");

    const cached = this.previewCache.get(cacheKey);
    if (cached) return cached;

    const fullLines = buildFullPreviewContentLines(item, targetWidth, this.theme);
    // 超容量按插入序淘汰最旧条目（`keys().next()` 在 Map 非空时必然产出条目）
    if (this.previewCache.size >= PREVIEW_CACHE_CAPACITY) {
      const oldest = this.previewCache.keys().next();
      if (!oldest.done) this.previewCache.delete(oldest.value);
    }
    this.previewCache.set(cacheKey, fullLines);
    return fullLines;
  }

  /**
   * 构建补充预览区的未切片内容行（题目补充在前、聚焦选项的补充在后）
   * 两项都未填写时为空数组，整个补充预览区连分隔线一起省略
   * @param q - 当前题目
   * @param st - 作答状态
   * @param currentItem - 聚焦菜单项
   * @param renderWidth - 终端布局列宽
   * @returns 补充预览区行；无补充时为空数组
   */
  private notePreviewLines(
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    currentItem: MenuItem | undefined,
    renderWidth: number,
  ): string[] {
    const lines: string[] = [];
    const label = (text: string): string => this.theme.fg("muted", text);

    const questionNote = st.customText?.trim();
    if (questionNote) {
      pushWrapped(
        lines,
        `${label(TEXTS.view.notePreviewQuestion)} ${this.theme.fg("accent", questionNote)}`,
        renderWidth,
      );
    }

    const optionNote = currentItem ? st.optionNotes.get(currentItem.optionIndex)?.trim() : undefined;
    if (currentItem && optionNote) {
      const optionLabel = this.theme.fg(
        "muted",
        TEXTS.view.notePreviewOption(
          q.options[currentItem.optionIndex]?.label ?? TEXTS.fallbacks.autoOptionLabel(currentItem.optionIndex + 1),
        ),
      );
      pushWrapped(lines, `${optionLabel} ${this.theme.fg("accent", optionNote)}`, renderWidth);
    }
    return lines;
  }

  /**
   * 计算并切片本帧内容区（纯计算，不写回滚动位移）
   * 内容区由题目内容区与补充预览区组成，后者只在有补充时占用行数
   * @param q - 当前题目
   * @param st - 作答状态
   * @param state - 只读视口状态
   * @param currentItem - 聚焦菜单项（缺省时题目内容区留空）
   * @param targetWidth - 内容区可用列宽
   * @param height - 内容区占用的终端行数
   * @returns 恰好 `height` 行的内容区与本帧视口观察值
   */
  private renderContentBand(
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    state: QuestionViewState,
    currentItem: MenuItem | undefined,
    targetWidth: number,
    height: number,
  ): RenderedPreviewBand {
    const mainLines = currentItem ? this.previewContentLines(state.tab, currentItem, targetWidth) : [];
    const notes = this.notePreviewLines(q, st, currentItem, targetWidth);
    const sections = renderContentSections(
      this.theme,
      targetWidth,
      height,
      mainLines,
      notes,
      state.previewScrollOffset,
    );
    return { lines: sections.lines, viewport: { total: mainLines.length, viewHeight: sections.viewHeight } };
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
