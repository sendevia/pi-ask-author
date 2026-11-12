/**
 * @file component.ts
 * @description `ask_author` 交互式 TUI 主组件（作答页、总览页与补充说明编辑页）
 *
 * - 本组件只负责交互状态机、按键与鼠标路由、整屏帧缓存，排版由 `view-*` 构建
 * - 作答界面挂载为整屏覆盖层；多级缓存分别按尺寸、`revision` 与状态突变失效
 * - 推演只采纳最新请求，在途期间页面换成占位并暂停作答输入
 * - `render()` 及其可达被调函数禁止写入语义状态，滚动位移只在输入路径归一化
 */

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { clamp, clampWindowOffset, normalizeImeKey, safeLine } from "./format.js";
import type { ExpansionRequest, ExpansionRunner } from "./expansion.js";
import { LAYOUT_CONFIG } from "./layout.js";
import {
  AskAuthorFormModel,
  type AskAuthorResult,
  type EditTarget,
  type ExpansionRecord,
  type MenuItem,
  type NormalizedQuestion,
} from "./model.js";
import type { ExpansionPayload, InsertPosition } from "./schema.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { renderEditorPage, type EditorArea } from "./view-editor.js";
import {
  QuestionView,
  type MenuItemHit,
  type NoteButtonHit,
  type PreviewViewport,
  type QuestionActionHit,
  type QuestionActionKind,
} from "./view-question.js";
import {
  buildTabLines,
  optionLabelOf,
  renderExpansionPlaceholderPage,
  type ButtonRect,
  type RowRange,
  type TabBar,
  type TabSegment,
} from "./view-rows.js";
import { SummaryView, type SummaryViewport } from "./view-summary.js";

/**
 * 实时推演服务（由入口层装配模型调用；缺省表示本表单不推演）
 */
export interface ExpansionService {
  /** 执行一次推演（取消经 `signal` 级联） */
  readonly run: ExpansionRunner;
  /** 调用方给出的长期推演方向指示（可选） */
  readonly guidance?: string;
}

/**
 * `ask_author` 交互式 TUI 组件（问卷作答与答卷总览）
 * 状态突变经 `AskAuthorFormModel` 完成并由 `revision` 驱动缓存失效；`dispose()` 幂等，`finish()` 保证 `done` 至多投递一次
 */
export class AskAuthorComponent implements Component, Focusable {
  /** Focusable 接口要求：输入模式焦点指示 */
  private _focused = false;
  /** 当前焦点状态（仅 `true` 时透传内置 Editor 以定位 IME 候选框） */
  get focused(): boolean {
    return this._focused;
  }
  /**
   * 设置焦点状态并级联透传至内置 Editor（同值为无操作，仅失效整屏帧缓存）
   * @param value - 目标焦点状态
   */
  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.editor.focused = this.inputMode && value;
    // Editor 的 IME 光标标记经视图层进入整屏缓存；预览内容与光标无关，内容缓存保留
    this.touch();
  }

  /** TUI 上下文 */
  private readonly tui: TUI;
  /** 主题 */
  private readonly theme: Theme;
  /** 问卷模型（作答状态的唯一来源，mutation 自动推进 revision） */
  private readonly model: AskAuthorFormModel;
  /** 结果达成回调 */
  private readonly done: (result: AskAuthorResult) => void;

  /** 当前 Tab 索引（0-based；questionCount 为总览确认页） */
  private currentTab = 0;
  /** 每道题独立的光标索引记忆表 */
  private readonly cursorByTab = new Map<number, number>();
  /** 当前题目菜单内选中的条目索引 */
  private currentOptionIndex = 0;
  /** 左侧菜单列表滚动位移（行） */
  private listScrollOffset = 0;
  /** 详情预览区滚动位移（行） */
  private previewScrollOffset = 0;
  /** 答卷总览页滚动位移（行） */
  private summaryScrollOffset = 0;

  /** 是否处于补充说明文本输入模式 */
  private inputMode = false;
  /** Esc 丢弃确认标记：编辑器非空时首次 Esc 仅标记，再次 Esc 才丢弃内容 */
  private editorEscArmed = false;
  /** 底部临时状态通知文案 */
  private statusMessage: string | null = null;
  /** 状态通知定时器 */
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否已终结（终结后忽略一切输入，且 `done` 不再投递） */
  private isFinished = false;
  /** 是否已卸载回收（幂等标记；卸载后忽略迟到输入且拒绝再绑定 Abort 监听；`done` 投递不受本标记阻断，见 {@link dispose}） */
  private disposed = false;

  /** AbortSignal 监听绑定对象 */
  private abortBinding?: { signal: AbortSignal; onAbort: () => void };

  /** 整屏缓存键：调用方真实列宽（输出截断依据） */
  private cachedWidth?: number;
  /** 整屏缓存键：布局列宽 `max(20, width)`（折行依据，20 列为窄终端宽度下限） */
  private cachedLayoutWidth?: number;
  /** 整屏缓存键：终端行数（视口行数随之自适应） */
  private cachedHeight?: number;
  /** 整屏已格式化终端行缓存 */
  private cachedLines?: string[];

  /** Tab 栏行缓存（键：当前页 + `revision` + 列宽；行与标签可点击位置一并缓存） */
  private tabCache?: { key: string; bar: TabBar };

  /** 菜单项派生缓存（键：题号 + `revision`，消除 render/输入路径重复构建） */
  private menuCache?: { tab: number; revision: number; items: MenuItem[] };

  /** 上一帧预览视口的观察元数据（渲染写入、输入路径读取以归一化位移） */
  private previewViewportObservation?: PreviewViewport;

  /** 上一帧内容预览区的行范围（渲染写入；鼠标滚轮据此区分预览区与选项区） */
  private previewBandObservation?: RowRange;

  /** 上一帧 Tab 栏的行范围与各标签可点击位置（渲染写入；鼠标点击据此切换题目） */
  private tabHitAreas?: { readonly band: RowRange; readonly segments: readonly TabSegment[] };

  /** 上一帧菜单项的整页行范围（渲染写入；鼠标点击据此移动光标与激活条目） */
  private menuHitAreas?: readonly MenuItemHit[];

  /** 上一帧补充说明按钮的整页矩形范围（渲染写入；鼠标点击据此打开对应批注的编辑器） */
  private noteHitAreas?: readonly NoteButtonHit[];

  /** 上一帧题目底部操作按钮的整页矩形范围（渲染写入；鼠标点击据此打开补充说明或推进确认） */
  private actionHitAreas?: readonly QuestionActionHit[];

  /** 上一帧总览页内容视口（渲染写入；滚动位移据此归一化） */
  private summaryViewportObservation?: SummaryViewport;

  /** 上一帧总览页整卷补充按钮的整页矩形（渲染写入；鼠标点击据此打开编辑器） */
  private summaryFormNoteHit?: ButtonRect;

  /** 上一帧总览页确认提交按钮的整页矩形（渲染写入；鼠标点击据此提交答卷） */
  private summarySubmitHit?: ButtonRect;

  /** 上一帧编辑框位置（渲染写入；输入模式下把鼠标点击换算为编辑框内坐标） */
  private editorAreaObservation?: EditorArea;

  /** 鼠标按下时的目标（按下与松开同在该目标上才算一次点击） */
  private mousePressedTab?: number;
  private mousePressedItem?: number;
  private mousePressedFormNote?: boolean;
  private mousePressedSubmit?: boolean;
  private mousePressedNote?: EditTarget;
  private mousePressedAction?: QuestionActionKind;

  /** 当前编辑器针对的目标（题目整体或指定选项） */
  private editTarget?: EditTarget;

  /** 内置补充说明编辑器实例 */
  private readonly editor: Editor;

  /** 实时推演服务（缺省表示本表单不推演） */
  private readonly expansion?: ExpansionService;
  /** 推演请求序号：只有最新序号的结果会被采纳 */
  private expansionTicket = 0;
  /** 进行中的推演请求中止器 */
  private expansionAbort?: AbortController;
  /** 是否有推演请求正在进行（在途期间作答页整体换成占位页，一切作答输入暂停） */
  private expansionPending = false;

  /** 题目作答页视图构建器（持有预览内容缓存） */
  private readonly questionView: QuestionView;

  /** 答卷总览页视图构建器（持有内容行缓存） */
  private readonly summaryView: SummaryView;

  /**
   * 构造交互式 TUI 主组件
   * @param tui - TUI 上下文
   * @param theme - 主题
   * @param model - 问卷模型
   * @param done - 结果回调
   * @param expansion - 实时推演服务（可选；缺省时表单保持静态）
   */
  constructor(
    tui: TUI,
    theme: Theme,
    model: AskAuthorFormModel,
    done: (result: AskAuthorResult) => void,
    expansion?: ExpansionService,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.model = model;
    this.done = done;
    this.expansion = expansion;
    this.questionView = new QuestionView(theme, model);
    this.summaryView = new SummaryView(theme, model);

    const editorTheme: EditorTheme = {
      borderColor: (s) => this.theme.fg("accent", s),
      selectList: getSelectListTheme(),
    };

    this.editor = new Editor(this.tui, editorTheme);
    this.editor.focused = false;
    // 批注突变委托模型 mutation，并按返回语义提示状态栏
    /**
     * 编辑器提交：写入当前目标（整卷补充、选项专属或题目整体）并按模型返回语义提示状态栏
     * @param text - 编辑器全文（空串即清空对应批注）
     */
    this.editor.onSubmit = (text) => {
      const target = this.editTarget;
      if (!target) {
        this.closeEditor();
        return;
      }

      if (target.type === "form") {
        const result = this.model.setFormNote(text);
        this.setStatus(result === "saved" ? TEXTS.status.formNoteSaved : TEXTS.status.formNoteCleared);
      } else if (target.type === "option") {
        const q = this.model.getQuestion(this.currentTab);
        const optIdx = target.optionIndex;
        // 输入模式下题目与选项集合不可变更，q 缺失仅可能来自异常状态，此时保持自动标签使提示内容易于阅读
        const optLabel = q ? optionLabelOf(q, optIdx) : TEXTS.fallbacks.autoOptionLabel(optIdx + 1);
        const result = this.model.setOptionNote(this.currentTab, optIdx, text);
        if (result === "cleared") this.setStatus(TEXTS.status.optionNoteCleared(optLabel));
        else if (result === "savedAtLimit" && q) this.setStatus(TEXTS.status.optionNoteSavedAtLimit(q.maxSelect));
        else if (result === "savedUnselected") this.setStatus(TEXTS.status.optionNoteSavedUnselected(optLabel));
        else this.setStatus(TEXTS.status.optionNoteSaved(optLabel));
      } else {
        const result = this.model.setQuestionNote(this.currentTab, text);
        this.setStatus(result === "saved" ? TEXTS.status.questionNoteSaved : TEXTS.status.noteCleared);
      }
      this.touchDerived();
      this.closeEditor();
    };
  }

  /**
   * 绑定中止信号（幂等，至多绑定一次）
   * @param signal - 外层 AbortSignal；缺省 / 已绑定 / 已卸载时直接返回
   */
  bindAbortSignal(signal?: AbortSignal): void {
    // disposed 守卫：卸载后再注册的监听器将无人摘除（dispose 已提前返回）
    if (!signal || this.abortBinding || this.disposed) return;
    if (signal.aborted) {
      // 不能在工厂同步调用路径内触发 done（会打断宿主 resolve），故以微任务推迟；finish() 自带幂等守卫
      queueMicrotask(() => this.finish(true));
      return;
    }
    const onAbort = () => this.finish(true);
    signal.addEventListener("abort", onAbort, { once: true });
    this.abortBinding = { signal, onAbort };
  }

  /**
   * 清理定时器、Abort 监听与全部缓存池（幂等）
   * 只设置 `disposed`、不设置 `isFinished`（资源回收 ≠ `done` 已投递），否则宿主先卸载而 `done` 未投递时挂起
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.expansionTicket++;
    this.expansionAbort?.abort();
    this.expansionAbort = undefined;
    this.expansionPending = false;
    this.clearStatusTimer();
    if (this.abortBinding) {
      this.abortBinding.signal.removeEventListener("abort", this.abortBinding.onAbort);
      this.abortBinding = undefined;
    }
    this.clearDerivedCaches();
    this.previewViewportObservation = undefined;
    this.previewBandObservation = undefined;
    this.tabHitAreas = undefined;
    this.menuHitAreas = undefined;
    this.noteHitAreas = undefined;
    this.actionHitAreas = undefined;
    this.summaryViewportObservation = undefined;
    this.summaryFormNoteHit = undefined;
    this.summarySubmitHit = undefined;
    this.editorAreaObservation = undefined;
    this.mousePressedTab = undefined;
    this.mousePressedItem = undefined;
    this.mousePressedFormNote = undefined;
    this.mousePressedSubmit = undefined;
    this.mousePressedNote = undefined;
    this.mousePressedAction = undefined;
    this.clearFrameCaches();
  }

  /** 清空整屏帧缓存（列宽 / 行数键；不触发重绘） */
  private clearFrameCaches(): void {
    this.cachedWidth = undefined;
    this.cachedLayoutWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  /** 清空全部派生缓存（`revision` 键与视图层内容缓存；不触发重绘） */
  private clearDerivedCaches(): void {
    this.questionView.clear();
    this.summaryView.clear();
    this.tabCache = undefined;
    this.menuCache = undefined;
  }

  /** 状态突变时失效整屏缓存并请求重绘（保留派生缓存池复用） */
  private touch(): void {
    this.clearFrameCaches();
    this.tui.requestRender();
  }

  /** 作答变更后的统一失效入口：模型已推进 revision，此处清空全部派生缓存 */
  private touchDerived(): void {
    this.clearDerivedCaches();
    this.touch();
  }

  /**
   * Component 接口约定：宿主重绘上下文（主题切换 / 需从头重绘）时清空全部渲染缓存
   * 终端尺寸变化不调用本方法（宿主 resize 仅 `requestRender`），由整屏缓存键绑定列宽与行数自然失效
   */
  invalidate(): void {
    this.touchDerived();
    this.editor.invalidate();
  }

  /** 清理临时状态定时器（清空引用以便后续 setStatus 重新计时） */
  private clearStatusTimer(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * 触发底部临时状态通知
   * @param msg - 提示文案（取自 `TEXTS.status`，不做控制字符清洗）
   */
  private setStatus(msg: string): void {
    this.statusMessage = msg;
    this.clearStatusTimer();
    this.statusTimer = setTimeout(() => {
      this.statusMessage = null;
      this.statusTimer = null;
      this.touch();
    }, LAYOUT_CONFIG.statusDurationMs);
    this.touch();
  }

  /**
   * 底部状态行文案
   * @returns 待展示的状态行文本；无提示时为 null
   */
  private get statusLine(): string | null {
    return this.statusMessage;
  }

  /**
   * 终结作答流程并触发 `done`（至多投递一次）
   * `isFinished` 防止重复投递；不以 `disposed` 阻断（资源已回收但 `done` 未投递时仍需结算）
   * @param cancelled - 是否用户主动取消
   */
  finish(cancelled: boolean): void {
    if (this.isFinished) return;
    this.isFinished = true;
    this.dispose();

    this.done({
      formTitle: this.model.formTitle,
      formDescription: this.model.formDescription,
      questions: this.model.questions,
      answers: cancelled ? [] : this.model.compileAnswers(),
      cancelled,
    });
  }

  /** 可见页序列：可见题目索引升序 + 总览提交页（`questionCount`）；被条件隐藏的题目不出现在序列中 */
  private get tabOrder(): number[] {
    return [...this.model.getVisibleQuestionIndices(), this.model.questionCount];
  }

  /** 当前 Tab 是否为答卷总览提交页 */
  private get isSubmitTab(): boolean {
    return this.currentTab === this.model.questionCount;
  }

  /** 终端可视行数（`tui.terminal.rows` 不可用或非正数时兜底 24） */
  private get terminalRows(): number {
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? rows : 24;
  }

  /**
   * 当前题目的菜单项
   * @returns 菜单项数组；按 `(题号, revision)` 记忆化，命中时零分配复用
   */
  private getMenuItems(): MenuItem[] {
    const cached = this.menuCache;
    if (cached && cached.tab === this.currentTab && cached.revision === this.model.revision) {
      return cached.items;
    }
    const items = this.model.getMenuItems(this.currentTab);
    this.menuCache = { tab: this.currentTab, revision: this.model.revision, items };
    return items;
  }

  /**
   * 当前聚焦菜单项
   * @returns 越界安全查询结果；无菜单项或索引越界时为 undefined
   */
  private currentMenuItem(): MenuItem | undefined {
    return this.getMenuItems()[this.currentOptionIndex];
  }

  /**
   * 切换题目 / 总览页 Tab，重置滚动位移并按 `cursorByTab` 恢复光标记忆
   * @param newTab - 目标 Tab 索引（0-based；questionCount 为总览页；同页为无操作）
   */
  private switchTab(newTab: number): void {
    if (newTab === this.currentTab) return;
    this.currentTab = newTab;
    this.previewScrollOffset = 0;
    this.summaryScrollOffset = 0;
    this.listScrollOffset = 0;
    this.menuCache = undefined;

    if (!this.isSubmitTab) {
      this.currentOptionIndex =
        this.cursorByTab.get(this.currentTab) ?? this.model.getSelectedIndex(this.currentTab) ?? 0;
      this.adjustScrollForCurrentOption();
    } else {
      this.currentOptionIndex = 0;
    }
    this.touch();
  }

  /**
   * 按可见页序列循环切换 Tab（跳过被条件隐藏的题目）
   * @param delta - 相对位移（正数下一项，负数上一项）
   */
  private switchRelativeTab(delta: number): void {
    const order = this.tabOrder;
    const position = order.indexOf(this.currentTab);
    if (position === -1) {
      this.switchTab(order[0] ?? this.model.questionCount);
      return;
    }
    this.switchTab(order[(position + delta + order.length) % order.length] ?? this.currentTab);
  }

  /** 收敛光标至合法区间并同步选项窗口滚动位移，保证聚焦项可见（菜单项为空时直接返回） */
  private adjustScrollForCurrentOption(): void {
    const count = this.getMenuItems().length;
    if (count === 0) return;
    this.currentOptionIndex = clamp(this.currentOptionIndex, 0, count - 1);

    if (this.currentOptionIndex < this.listScrollOffset) {
      this.listScrollOffset = this.currentOptionIndex;
    } else if (this.currentOptionIndex >= this.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount) {
      this.listScrollOffset = this.currentOptionIndex - LAYOUT_CONFIG.visibleOptionCount + 1;
    }
  }

  /**
   * 移动菜单光标并同步滚动窗口，重置预览位移
   * @param target - 绝对索引或 `{ delta }` 相对位移（越界由 clamp 收敛，菜单为空时无操作）
   */
  private moveCursor(target: number | { delta: number }): void {
    const count = this.getMenuItems().length;
    if (count === 0) return;
    const next = typeof target === "number" ? target : this.currentOptionIndex + target.delta;
    const clamped = clamp(next, 0, count - 1);
    if (clamped === this.currentOptionIndex) return;

    this.currentOptionIndex = clamped;
    this.cursorByTab.set(this.currentTab, clamped);
    this.previewScrollOffset = 0;
    this.adjustScrollForCurrentOption();
    this.touch();
  }

  /**
   * 当前光标默认的编辑目标
   * @returns 聚焦选项时为该选项，否则为题目整体
   */
  private getEditTargetForCurrentSelection(): EditTarget {
    const currentItem = this.currentMenuItem();
    return currentItem ? { type: "option", optionIndex: currentItem.optionIndex } : { type: "question" };
  }

  /**
   * 打开补充说明编辑器（选项专属或题目整体）
   * @param target - 编辑目标；缺省时按当前聚焦项推导（题目缺失或禁用补充说明时无操作）
   */
  private openCustomEditor(target?: EditTarget): void {
    const q = this.model.getQuestion(this.currentTab);
    if (!q || !q.allowCustom) return;

    const st = this.model.getState(this.currentTab);
    const resolvedTarget = target ?? this.getEditTargetForCurrentSelection();
    this.editTarget = resolvedTarget;
    this.inputMode = true;
    this.editorEscArmed = false;

    const initialText =
      resolvedTarget.type === "option" ? (st.optionNotes.get(resolvedTarget.optionIndex) ?? "") : (st.customText ?? "");

    this.editor.setText(initialText);
    this.editor.focused = this._focused;
    this.touch();
  }

  /** 打开整卷补充编辑器（提交页；与题目批注共用键位，提交后回到总览页） */
  private openFormNoteEditor(): void {
    this.editTarget = { type: "form" };
    this.inputMode = true;
    this.editorEscArmed = false;
    this.editor.setText(this.model.formNote ?? "");
    this.editor.focused = this._focused;
    this.touch();
  }

  /** 关闭编辑器并还原非输入模式状态（清空缓冲与焦点；幂等） */
  private closeEditor(): void {
    this.inputMode = false;
    this.editorEscArmed = false;
    this.editTarget = undefined;
    this.editor.focused = false;
    this.editor.setText("");
    this.touch();
  }

  /**
   * 确认当前题并跳转下一题 / 总览页：先把聚焦选项写入模型再推进
   * @param currentItem - 聚焦选项菜单项
   * @param q - 当前题目
   */
  private confirmAndAdvance(currentItem: MenuItem | undefined, q: NormalizedQuestion): void {
    if (currentItem) this.model.commitOption(this.currentTab, currentItem.optionIndex);
    this.advanceIfAnswered(q);
  }

  /**
   * 作答达标时确认本题并前进，否则只在状态栏提示（不写入任何选项）
   * @param q - 当前题目
   */
  private advanceIfAnswered(q: NormalizedQuestion): void {
    if (this.model.isQuestionAnswered(this.currentTab)) {
      // 推演必须在切页前发起：切页后 currentTab 不再是刚确认的题目
      this.expandAfterConfirm(this.currentTab);
      const order = this.tabOrder;
      const position = order.indexOf(this.currentTab);
      const next = position === -1 ? this.model.questionCount : (order[position + 1] ?? this.model.questionCount);
      this.switchTab(next);
      return;
    }
    this.setStatus(q.multiSelect ? TEXTS.status.minSelectRequired(q.minSelect) : TEXTS.status.pleaseAnswerBeforeSubmit);
  }

  // ===== 实时推演编排 =====

  /**
   * 作者确认题目后刷新推演：答案未变则保留既有结果，变了则先撤回再重新请求
   * 仅对声明参与推演的题目发起请求（题目级开关关闭时保持静态）
   * @param qIndex - 刚确认的题目索引（0-based）
   */
  private expandAfterConfirm(qIndex: number): void {
    const service = this.expansion;
    if (!service) return;
    const config = this.model.expansionConfigFor(qIndex);
    if (!config) return;
    const signature = this.model.answerSignature(qIndex);
    if (signature === undefined) return;

    const existing = this.model.getExpansions().find((record) => record.questionIndex === qIndex);
    if (existing?.signature === signature) return;

    if (this.model.retractFrom(qIndex) > 0) {
      this.setStatus(TEXTS.status.expansionRetracted);
      // 被撤回块之后的题目整体前移，其光标记忆随之作废
      for (const tab of [...this.cursorByTab.keys()]) {
        if (tab > qIndex) this.cursorByTab.delete(tab);
      }
      this.trimTabs();
      this.touchDerived();
    }

    const room = this.model.expansionMaxQuestions - this.model.questionCount;
    if (room <= 0) return;

    const ticket = ++this.expansionTicket;
    const controller = new AbortController();
    this.expansionAbort?.abort();
    this.expansionAbort = controller;
    this.expansionPending = true;
    this.touch();

    const request: ExpansionRequest = {
      model: this.model,
      questionIndex: qIndex,
      insert: config.insertLabel,
      guidance: config.guidance ?? service.guidance,
      maxAdditionalQuestions: room,
    };

    service.run(request, controller.signal).then(
      (payload) => this.applyExpansion(ticket, qIndex, signature, config.insert, payload),
      (err: unknown) => this.reportExpansionFailure(ticket, err),
    );
  }

  /**
   * 写入推演结果（仅采纳最新请求；非最新、已终结或已卸载时丢弃）
   * @param ticket - 请求序号
   * @param qIndex - 触发题目索引（0-based）
   * @param signature - 触发题目当时的答案签名
   * @param insert - 本次推演使用的插入位置
   * @param payload - 推演载荷
   */
  private applyExpansion(
    ticket: number,
    qIndex: number,
    signature: string,
    insert: InsertPosition,
    payload: ExpansionPayload,
  ): void {
    if (ticket !== this.expansionTicket || this.isFinished || this.disposed) return;
    this.expansionPending = false;
    this.expansionAbort = undefined;

    // 推演题目插在触发题目之后：作者原本停在紧邻位置时随新题目前移，否则按题目身份跟随
    const wasSubmitTab = this.isSubmitTab;
    const previousTab = this.currentTab;
    const anchorId = wasSubmitTab ? undefined : this.model.getQuestion(previousTab)?.id;
    let record: ExpansionRecord;
    try {
      record = this.model.pushExpansion({ questionIndex: qIndex, signature, insert, payload });
    } catch (err) {
      // 推演内容的条件非法时整批丢弃，作者已填写的作答保持不变
      this.setStatus(TEXTS.status.expansionFailed(this.describeError(err)));
      return;
    }

    if (record.addedQuestions > 0) {
      for (const tab of [...this.cursorByTab.keys()]) {
        if (tab >= record.insertAt) this.cursorByTab.delete(tab);
      }
    }

    if (wasSubmitTab) {
      this.currentTab = record.addedQuestions > 0 ? record.insertAt : this.model.questionCount;
    } else if (anchorId !== undefined) {
      // 作者仍停在触发题目的下一题时跟随新插入的题目，否则按题目身份回到原来的题目
      const landed =
        previousTab === record.insertAt ? record.insertAt : this.model.questions.findIndex((q) => q.id === anchorId);
      if (landed >= 0 && landed !== this.currentTab) this.switchTab(landed);
    }
    this.trimTabs();
    this.touchDerived();

    const optionCount = record.addedOptions.reduce((total, addition) => total + addition.count, 0);
    if (record.addedQuestions === 0 && optionCount === 0) this.setStatus(TEXTS.status.expansionStopped);
    else this.setStatus(TEXTS.status.expansionAdded(record.addedQuestions, optionCount));
  }

  /**
   * 报告推演失败（仅最新请求；作者已填内容保持不变）
   * @param ticket - 请求序号
   * @param err - 失败原因
   */
  private reportExpansionFailure(ticket: number, err: unknown): void {
    if (ticket !== this.expansionTicket || this.isFinished || this.disposed) return;
    this.expansionPending = false;
    this.expansionAbort = undefined;
    this.setStatus(TEXTS.status.expansionFailed(this.describeError(err)));
  }

  /**
   * 提取异常的可读描述
   * @param err - 未知异常
   * @returns `Error` 的 `message`，其余类型取字符串形式
   */
  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** 题目总数变化后收敛 Tab、光标与光标记忆（题数变少时当前页与越界光标一并回退） */
  private trimTabs(): void {
    const limit = this.model.questionCount;
    if (this.currentTab > limit) this.currentTab = limit;
    for (const tab of [...this.cursorByTab.keys()]) {
      if (tab > limit) this.cursorByTab.delete(tab);
    }
    const count = this.getMenuItems().length;
    if (count > 0 && this.currentOptionIndex >= count) this.currentOptionIndex = count - 1;
  }

  // ===== 键盘输入路由与快捷键体系 =====

  /**
   * Component 接口约定：键盘事件三级路由（输入模式 → 全局键 → 分视图）
   * Esc 与 Ctrl+C 同为取消键（宿主不会自行中止工具信号）：常规模式直接 `finish(true)`，输入模式下编辑器非空时首次仅武装丢弃确认
   * @param data - 终端按键序列
   */
  handleInput(data: string): void {
    // 0. 已终结/已卸载的组件忽略一切迟到输入（done 回调到宿主卸载组件之间存在窗口）
    if (this.isFinished || this.disposed) return;

    const isCancelKey = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));

    // 1. 输入模式委托内置 Editor；Esc/Ctrl+C 二次确认防止误触
    if (this.inputMode) {
      if (isCancelKey) {
        if (this.editor.getText() !== "" && !this.editorEscArmed) {
          this.editorEscArmed = true;
          this.setStatus(TEXTS.status.editorDiscardConfirm);
          return;
        }
        this.closeEditor();
        return;
      }
      if (this.editorEscArmed) {
        // 继续输入视为放弃丢弃意图，解除武装并照常透传
        this.editorEscArmed = false;
        this.statusMessage = null;
      }
      this.editor.handleInput(data);
      this.touch();
      return;
    }

    // 2. Esc / Ctrl+C 退出取消
    if (isCancelKey) {
      this.finish(true);
      return;
    }

    // 3. 推演在途：作答页整体是占位页，除取消外的输入全部忽略（入位前改动会让作答快照与插入位置错位）
    if (this.expansionPending) return;

    // 4. 输入法全角字符收敛为半角：候选词框覆盖时按键常以全角送出（`【`/`】`/`０`/`ｈ`），输入模式已在上方返回，此处只处理无输入框页面
    data = normalizeImeKey(data);

    // 5. 数字键 1~9 快捷跳转题目（按可见题目的展示序号映射；10 题以上经 Tab/hl 循环或总览页跳转）
    if (/^[1-9]$/.test(data)) {
      const targetIndex = parseInt(data, 10) - 1;
      const target = this.tabOrder[targetIndex];
      if (target !== undefined && target < this.model.questionCount) {
        this.switchTab(target);
        return;
      }
    }

    // 6. Tab / 方向键左右 / h / l Vim 风格切换题目
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, "l")) {
      this.switchRelativeTab(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, "h")) {
      this.switchRelativeTab(-1);
      return;
    }

    // 7. 分视图输入路由
    if (this.isSubmitTab) {
      this.handleSummaryInput(data);
    } else {
      this.handleQuestionInput(data);
    }
  }

  /**
   * Component 接口约定：接收鼠标事件
   * 作答界面是整屏覆盖层：滚轮一律标记为已消费，预览区内滚预览内容，其余位置移动选项光标
   * 左键单击：按下先把光标移到指针下的条目，同一条目上松开才激活它；Tab 标签按松开动作切页；未命中的不接管，交回 pi 做文本选择
   * 鼠标事件属于输入路径，本方法写回滚动位移与光标
   * @param event - 归一化鼠标事件（坐标已换算为组件内坐标）
   * @returns 已消费的滚轮与命中点击；其余事件不处理
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      if (this.isFinished || this.disposed || this.expansionPending || this.inputMode) return { handled: true };

      const delta = event.wheelDelta ?? 0;
      if (this.isSubmitTab) {
        this.scrollSummaryBy(delta);
        return { handled: true };
      }

      const band = this.previewBandObservation;
      if (band && event.y >= band.start && event.y < band.end) {
        this.scrollPreviewBy(delta);
      } else {
        this.moveCursor({ delta: delta < 0 ? -1 : 1 });
      }
      return { handled: true };
    }

    if (this.isFinished || this.disposed || this.expansionPending) return undefined;

    // 输入模式下只转发左键点击：按下与拖动留给 pi 的文本选择，松开时宿主合成的 click 才是定位光标的动作
    if (this.inputMode) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const area = this.editorAreaObservation;
      if (!area) return undefined;
      const y = event.y - area.top;
      const x = event.x - area.left;
      if (y < 0 || y >= area.height || x < 0 || x >= area.width) return undefined;
      const result = this.editor.handleMouse({
        ...event,
        x,
        y,
        width: area.width,
        height: area.height,
        screenX: event.screenX - area.left,
        screenY: event.screenY - area.top,
      });
      if (!result) return undefined;
      // 编辑器内部光标移动不会改变它的渲染输入，需主动作废整屏帧缓存
      this.touch();
      return result;
    }

    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

    if (event.type === "press") {
      const tab = this.tabAt(event.y, event.x);
      if (tab !== undefined) {
        this.mousePressedTab = tab;
        return { handled: true };
      }
      const noteTarget = this.noteButtonAt(event.y, event.x);
      if (noteTarget) {
        this.mousePressedNote = noteTarget;
        return { handled: true };
      }
      const action = this.actionButtonAt(event.y, event.x);
      if (action) {
        this.mousePressedAction = action;
        return { handled: true };
      }
      if (this.formNoteAt(event.y, event.x)) {
        this.mousePressedFormNote = true;
        return { handled: true };
      }
      if (this.submitButtonAt(event.y, event.x)) {
        this.mousePressedSubmit = true;
        return { handled: true };
      }
      const itemIndex = this.menuItemAt(event.y);
      if (itemIndex === undefined) return undefined;
      this.mousePressedItem = itemIndex;
      this.moveCursor(itemIndex);
      return { handled: true };
    }

    const pressedTab = this.mousePressedTab;
    const pressedItem = this.mousePressedItem;
    const pressedFormNote = this.mousePressedFormNote;
    const pressedSubmit = this.mousePressedSubmit;
    const pressedNote = this.mousePressedNote;
    const pressedAction = this.mousePressedAction;
    this.mousePressedTab = undefined;
    this.mousePressedItem = undefined;
    this.mousePressedFormNote = undefined;
    this.mousePressedSubmit = undefined;
    this.mousePressedNote = undefined;
    this.mousePressedAction = undefined;

    if (pressedTab !== undefined && this.tabAt(event.y, event.x) === pressedTab) {
      this.switchTab(pressedTab);
      return { handled: true };
    }
    if (pressedNote && AskAuthorComponent.sameNoteTarget(pressedNote, this.noteButtonAt(event.y, event.x))) {
      this.openCustomEditor(pressedNote);
      return { handled: true };
    }
    if (pressedAction && this.actionButtonAt(event.y, event.x) === pressedAction) {
      this.runQuestionAction(pressedAction);
      return { handled: true };
    }
    if (pressedFormNote && this.formNoteAt(event.y, event.x)) {
      this.openFormNoteEditor();
      return { handled: true };
    }
    if (pressedSubmit && this.submitButtonAt(event.y, event.x)) {
      this.submitOrJumpToUnfinished();
      return { handled: true };
    }
    if (pressedItem !== undefined && this.menuItemAt(event.y) === pressedItem) {
      const q = this.model.getQuestion(this.currentTab);
      const item = this.currentMenuItem();
      if (q && item) this.activateMenuItem(item, q);
      return { handled: true };
    }
    return undefined;
  }

  /**
   * 命中题目导航标签
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 命中的页索引；未落在任何标签上时为 undefined
   */
  private tabAt(y: number, x: number): number | undefined {
    const areas = this.tabHitAreas;
    if (!areas || y < areas.band.start || y >= areas.band.end) return undefined;
    const row = y - areas.band.start;
    for (const segment of areas.segments) {
      if (segment.row === row && x >= segment.start && x < segment.end) return segment.tab;
    }
    return undefined;
  }

  /**
   * 命中选项菜单条目
   * @param y - 组件内行号
   * @returns 菜单项索引；未落在条目行上时为 undefined
   */
  private menuItemAt(y: number): number | undefined {
    for (const hit of this.menuHitAreas ?? []) {
      if (y >= hit.range.start && y < hit.range.end) return hit.index;
    }
    return undefined;
  }

  /**
   * 命中补充说明按钮
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 命中的按钮对应的批注编辑目标；未落在任何按钮框内时为 undefined
   */
  private noteButtonAt(y: number, x: number): EditTarget | undefined {
    for (const hit of this.noteHitAreas ?? []) {
      if (AskAuthorComponent.withinRect(hit.rect, y, x)) return hit.target;
    }
    return undefined;
  }

  /**
   * 命中题目底部的操作按钮
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 命中的按钮种类；未落在任何按钮框内时为 undefined
   */
  private actionButtonAt(y: number, x: number): QuestionActionKind | undefined {
    for (const hit of this.actionHitAreas ?? []) {
      if (AskAuthorComponent.withinRect(hit.rect, y, x)) return hit.action;
    }
    return undefined;
  }

  /**
   * 执行题目底部的操作按钮（补充说明入口 / 确认推进）
   * @param action - 按钮种类
   */
  private runQuestionAction(action: QuestionActionKind): void {
    const q = this.model.getQuestion(this.currentTab);
    if (!q) return;
    if (action === "note") {
      this.openCustomEditor({ type: "question" });
      return;
    }
    this.advanceIfAnswered(q);
  }

  /**
   * 判定按下与松开是否落在同一个批注按钮上
   * @param pressed - 按下时命中的目标
   * @param released - 松开时命中的目标
   * @returns 两者为同一题目批注或同一选项的批注时为 true
   */
  private static sameNoteTarget(pressed: EditTarget, released: EditTarget | undefined): boolean {
    if (!released || released.type !== pressed.type) return false;
    return pressed.type !== "option" || (released.type === "option" && released.optionIndex === pressed.optionIndex);
  }

  /**
   * 判定指针是否落在按钮矩形内
   * @param rect - 按钮矩形（行与列均为 0-based 半开区间）
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 在矩形内为 true
   */
  private static withinRect(rect: ButtonRect, y: number, x: number): boolean {
    return y >= rect.rows.start && y < rect.rows.end && x >= rect.cols.start && x < rect.cols.end;
  }

  /**
   * 命中总览页的整卷补充按钮（未滚动到时该按钮无可见行，命中恒不成立）
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 指针落在补充按钮可见矩形内时为 true
   */
  private formNoteAt(y: number, x: number): boolean {
    const hit = this.summaryFormNoteHit;
    return hit !== undefined && AskAuthorComponent.withinRect(hit, y, x);
  }

  /**
   * 命中总览页的确认提交按钮
   * @param y - 组件内行号
   * @param x - 组件内列号
   * @returns 指针落在按钮矩形内时为 true
   */
  private submitButtonAt(y: number, x: number): boolean {
    const hit = this.summarySubmitHit;
    return hit !== undefined && AskAuthorComponent.withinRect(hit, y, x);
  }

  /**
   * 题目作答页常规键路由（移动 / 勾选 / 前进 / 补充说明；子路由均为先匹配先消费）
   * @param data - 终端按键序列
   */
  private handleQuestionInput(data: string): void {
    const q = this.model.getQuestion(this.currentTab);
    if (!q) return;

    if (this.handleNoteShortcut(q, data)) return;
    if (this.handlePreviewScroll(data)) return;
    if (this.handleCursorNavigation(data)) return;
    if (this.handleSelectAllShortcut(q, data)) return;

    const currentItem = this.currentMenuItem();

    if (matchesKey(data, Key.ctrl("s"))) {
      this.confirmAndAdvance(currentItem, q);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      // 单选与多选统一：Enter = 选定并确认前进（多选未达下限时阻断），空格负责 toggle 勾选
      this.confirmAndAdvance(currentItem, q);
      return;
    }

    if (!currentItem) return;

    if (matchesKey(data, Key.space)) {
      this.activateMenuItem(currentItem, q);
    }
  }

  /**
   * 补充说明快捷键路由（`n`/`e` 补充当前聚焦项、`N` 题目整体补充、`x`/Delete 清空）
   * @param q - 当前题目
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handleNoteShortcut(q: NormalizedQuestion, data: string): boolean {
    if (!q.allowCustom) return false;

    // 1. 大写 'N'：随时打开题目整体补充说明编辑器
    if (matchesKey(data, Key.shift("n"))) {
      this.openCustomEditor({ type: "question" });
      return true;
    }

    // 2. 小写 'n' / 'e'：针对当前聚焦项打开编辑器（选项专属或题目整体）
    if (matchesKey(data, "n") || matchesKey(data, "e")) {
      this.openCustomEditor();
      return true;
    }

    // 3. 'x' / Delete：清空补充说明（选项专属优先，其次题目整体）
    if (matchesKey(data, "x") || matchesKey(data, Key.delete)) {
      const currentItem = this.currentMenuItem();
      if (currentItem && this.model.clearOptionNote(this.currentTab, currentItem.optionIndex)) {
        this.setStatus(TEXTS.status.optionNoteCleared(optionLabelOf(q, currentItem.optionIndex)));
        return true;
      }
      if (this.model.clearQuestionNote(this.currentTab)) {
        this.setStatus(TEXTS.status.noteCleared);
        return true;
      }
    }

    return false;
  }

  /**
   * 预览区垂直滚动键（方括号 / Alt+上下）
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handlePreviewScroll(data: string): boolean {
    let step = 0;
    if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.alt("up"))) {
      step = -LAYOUT_CONFIG.previewScrollStep;
    } else if (matchesKey(data, Key.rightbracket) || matchesKey(data, Key.alt("down"))) {
      step = LAYOUT_CONFIG.previewScrollStep;
    }
    if (step === 0) return false;
    this.scrollPreviewBy(step);
    return true;
  }

  /**
   * 按行数滚动预览区内容
   * 滚动位移在输入路径归一化：以渲染帧写入的 {@link previewViewportObservation} 为界收敛，缺观察元数据时按预览区最小高度退化
   * @param lines - 行位移（正下负上）
   */
  private scrollPreviewBy(lines: number): void {
    const observation = this.previewViewportObservation;
    const viewHeight = observation?.viewHeight ?? LAYOUT_CONFIG.previewMinHeight;
    const total = observation?.total ?? 0;
    this.previewScrollOffset = clampWindowOffset(this.previewScrollOffset + lines, total, viewHeight);
    this.touch();
  }

  /**
   * 按行数滚动总览页内容
   * @param lines - 行位移（正下负上）
   */
  private scrollSummaryBy(lines: number): void {
    const observation = this.summaryViewportObservation;
    const pageSize = observation?.viewHeight ?? LAYOUT_CONFIG.previewMinHeight;
    const total = observation?.total ?? 0;
    // 先归一化过期位移（End 的超大值 / 题目变更后总行数变短）再叠加步进，保证 End 后按 ↑ 能回退
    const base = clampWindowOffset(this.summaryScrollOffset, total, pageSize);
    this.summaryScrollOffset = clampWindowOffset(base + lines, total, pageSize);
    this.touch();
  }

  /**
   * 选项菜单光标移动键（↑↓ / jk / Home / End）
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handleCursorNavigation(data: string): boolean {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.moveCursor({ delta: -1 });
      return true;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.moveCursor({ delta: 1 });
      return true;
    }
    if (matchesKey(data, Key.home)) {
      this.moveCursor(0);
      return true;
    }
    if (matchesKey(data, Key.end)) {
      this.moveCursor(Number.MAX_SAFE_INTEGER);
      return true;
    }
    return false;
  }

  /**
   * 多选模式下 `a` 键全选 / 清空已选项
   * @param q - 当前题目
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handleSelectAllShortcut(q: NormalizedQuestion, data: string): boolean {
    if (!q.multiSelect || !matchesKey(data, "a")) return false;
    const result = this.model.selectAllOrClear(this.currentTab);
    const visibleOptionCount = q.options.filter((_, idx) => this.model.isOptionVisible(this.currentTab, idx)).length;
    if (result === "filled" && q.maxSelect < visibleOptionCount) {
      this.setStatus(TEXTS.status.selectedUpToLimit(q.maxSelect));
    } else {
      this.touch();
    }
    return true;
  }

  /**
   * 聚焦选项的主动作（唯一入口为空格键：切换勾选，达上限时仅提示状态栏）
   * @param currentItem - 聚焦选项菜单项
   * @param q - 当前题目
   */
  private activateMenuItem(currentItem: MenuItem, q: NormalizedQuestion): void {
    if (this.model.toggleOption(this.currentTab, currentItem.optionIndex) === "limit") {
      this.setStatus(TEXTS.status.maxSelectExceeded(q.maxSelect));
      return;
    }
    // 模型已变更而键盘路由不触发渲染，须立即重绘否则勾选滞后到下次按键
    this.touch();
  }

  /**
   * 提交答卷；尚有题目未完成时跳到第一道未完成的题目并在状态栏说明原因
   * 回车、`Ctrl+S` 与总览页的确认提交按钮共用本逻辑
   */
  private submitOrJumpToUnfinished(): void {
    if (this.model.areAllQuestionsAnswered()) {
      this.finish(false);
      return;
    }
    const firstUnfinished = this.model
      .getVisibleQuestionIndices()
      .find((index) => !this.model.isQuestionAnswered(index));
    if (firstUnfinished === undefined) return;
    this.switchTab(firstUnfinished);
    const unfQ = this.model.getQuestion(firstUnfinished);
    if (!unfQ) return;
    this.setStatus(
      unfQ.multiSelect ? TEXTS.status.minSelectRequired(unfQ.minSelect) : TEXTS.status.pleaseAnswerBeforeSubmit,
    );
  }

  /**
   * 总览页键路由（整卷补充、滚动与回车提交；`Ctrl+S` 同义提交）
   * 空格更改为向下滚动（防止习惯性翻页误提交）；位移归一化归属本路径，上界获取自总览视图缓存的内容行数，`End` 仅设置超大值，由后续输入收敛
   * @param data - 按键序列
   */
  private handleSummaryInput(data: string): void {
    // 整卷补充与题目批注同族键位：`n` / `e` / `N` 打开编辑器，`x` / Delete 清空
    if (matchesKey(data, "n") || matchesKey(data, "e") || matchesKey(data, Key.shift("n"))) {
      this.openFormNoteEditor();
      return;
    }
    if (matchesKey(data, "x") || matchesKey(data, Key.delete)) {
      if (this.model.clearFormNote()) this.setStatus(TEXTS.status.formNoteCleared);
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) {
      this.submitOrJumpToUnfinished();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.summaryScrollOffset = 0;
      this.touch();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.summaryScrollOffset = Number.MAX_SAFE_INTEGER;
      this.touch();
      return;
    }

    let step = this.summaryScrollStep(data);
    if (step === 0 && matchesKey(data, Key.space)) step = LAYOUT_CONFIG.summaryScrollStep;
    if (step === 0) return;
    this.scrollSummaryBy(step);
  }

  /**
   * 计算总览页滚动步长
   * @param data - 按键序列
   * @returns 行位移（正下负上，0 为无动作）
   */
  private summaryScrollStep(data: string): number {
    if (matchesKey(data, Key.leftbracket) || matchesKey(data, Key.alt("up"))) return -LAYOUT_CONFIG.summaryScrollStep;
    if (matchesKey(data, Key.rightbracket) || matchesKey(data, Key.alt("down"))) return LAYOUT_CONFIG.summaryScrollStep;
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) return -1;
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) return 1;
    return 0;
  }

  // ===== 视图渲染层 =====

  /**
   * 当前帧的 Tab 导航栏（按当前页 / 推演在途 / `revision` / 列宽记忆化）
   * @param layoutWidth - 终端布局列宽
   * @returns Tab 栏行与各标签可点击位置
   */
  private tabBar(layoutWidth: number): TabBar {
    const key = `${this.currentTab}_${this.expansionPending ? "p" : "-"}_${this.model.revision}_${layoutWidth}`;
    if (!this.tabCache || this.tabCache.key !== key) {
      this.tabCache = {
        key,
        bar: buildTabLines(this.theme, this.model, this.currentTab, layoutWidth, this.expansionPending),
      };
    }
    return this.tabCache.bar;
  }

  /**
   * Component 接口约定：渲染整屏行（带整屏缓存）
   * 缓存键绑定真实列宽、布局列宽与终端行数（窄于 20 列时两种宽度截断范围不同）；本方法及可达被调函数只刷新缓存，不写入语义状态
   * @param width - 终端真实可视宽度（布局宽度下限 20 列）
   * @returns 不超过 width 的终端行数组（命中缓存时直接返回）
   */
  render(width: number): string[] {
    const layoutWidth = Math.max(20, width);
    const renderHeight = this.terminalRows;
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedLayoutWidth === layoutWidth &&
      this.cachedHeight === renderHeight
    ) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const tabBar = this.tabBar(layoutWidth);

    if (this.expansionPending) {
      // 推演在途占位页也是整页：在途期间不响应鼠标点击
      lines.push(...renderExpansionPlaceholderPage(this.theme, tabBar.lines, layoutWidth, renderHeight));
      this.tabHitAreas = undefined;
      this.menuHitAreas = undefined;
      this.noteHitAreas = undefined;
      this.actionHitAreas = undefined;
      this.summaryViewportObservation = undefined;
      this.summaryFormNoteHit = undefined;
      this.summarySubmitHit = undefined;
      this.editorAreaObservation = undefined;
    } else if (this.inputMode) {
      // 编辑页同样整页占满：编辑框之后补空行，帮助栏与框架线贴在底部（总览页的整卷补充也走本分支）
      const page = renderEditorPage(
        this.theme,
        this.model,
        this.currentTab,
        this.editTarget,
        this.editor,
        tabBar.lines,
        layoutWidth,
        renderHeight,
      );
      lines.push(...page.lines);
      this.tabHitAreas = undefined;
      this.menuHitAreas = undefined;
      this.noteHitAreas = undefined;
      this.actionHitAreas = undefined;
      this.summaryViewportObservation = undefined;
      this.summaryFormNoteHit = undefined;
      this.summarySubmitHit = undefined;
      this.editorAreaObservation = page.editorArea;
    } else if (this.isSubmitTab) {
      // 总览页自带框架线与 Tab 栏，答卷内容占满顶部分内容区
      const view = this.summaryView.render(
        tabBar.lines,
        this.summaryScrollOffset,
        this.statusLine,
        layoutWidth,
        renderHeight,
      );
      lines.push(...view.lines);
      this.tabHitAreas = { band: view.tabRange, segments: tabBar.segments };
      this.menuHitAreas = undefined;
      this.noteHitAreas = undefined;
      this.actionHitAreas = undefined;
      this.summaryViewportObservation = view.viewport;
      this.summaryFormNoteHit = view.formNoteButton;
      this.summarySubmitHit = view.submitButton;
      this.editorAreaObservation = undefined;
    } else {
      // 作答页自上而下自带框架线、预览区、Tab 栏与选项区
      const view = this.questionView.render(
        {
          tab: this.currentTab,
          optionIndex: this.currentOptionIndex,
          listScrollOffset: this.listScrollOffset,
          previewScrollOffset: this.previewScrollOffset,
          statusMessage: this.statusLine,
          menuItems: this.getMenuItems(),
          expandable: this.model.canExpandOnConfirm(this.currentTab, this.expansion !== undefined),
          tabLines: tabBar.lines,
        },
        layoutWidth,
        renderHeight,
      );
      lines.push(...view.lines);
      if (view.previewViewport) this.previewViewportObservation = view.previewViewport;
      if (view.previewBand) this.previewBandObservation = view.previewBand;
      if (view.tabRange) this.tabHitAreas = { band: view.tabRange, segments: tabBar.segments };
      this.menuHitAreas = view.menuItemHits;
      this.noteHitAreas = view.noteButtonHits;
      this.actionHitAreas = view.actionButtonHits;
      this.summaryViewportObservation = undefined;
      this.summaryFormNoteHit = undefined;
      this.summarySubmitHit = undefined;
      this.editorAreaObservation = undefined;
    }

    // 3. 最终行宽保护（按调用方真实列宽截断）与缓存写入
    this.cachedWidth = width;
    this.cachedLayoutWidth = layoutWidth;
    this.cachedHeight = renderHeight;
    this.cachedLines = lines.map((line) => safeLine(line, width));
    return this.cachedLines;
  }
}
