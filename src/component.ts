/**
 * @file component.ts
 * @description `ask_author` 交互式 TUI 主组件（双栏问卷视图与答卷总览）
 *
 * 核心架构特性：
 * - 宽屏双栏 / 窄屏单栏自适应：`renderWidth >= LAYOUT_CONFIG.splitViewMinWidth` 且题目含富内容时走双栏，否则降级单栏紧凑列表；预览与总览视口行数随终端高度收缩
 * - 多级缓存失效：整屏（尺寸键 + 状态突变清空）、总览 / Tab 栏 / 左栏 / 菜单项（`revision` 键）、预览池（内容键）；视口切片 O(1)；`render()` 无 I/O，Markdown 渲染仅发生在派生缓存未命中时
 * - 逐题独立光标记忆与 `1~9` 跳转题目；内置编辑器透传 Focusable 以定位 IME 候选框
 * - Esc / Ctrl+C 双通道取消（输入模式二次确认）；定时器、Abort 监听与缓存池全量回收
 *
 * 渲染纯度不变量：`render()` 及其可达被调函数禁止写入语义状态（`currentTab`、光标与各 `*ScrollOffset`、`inputMode`、`editTarget`、`editorEscArmed`、`statusMessage`、`isFinished`）；滚动位移归一化一律归属输入路径
 * 可写入透明备忘：`cached*`、`previewCache`、`tabCache`、`leftColCache`、`summaryCachedLines`、`menuCache`、`previewViewportObservation` 均为「渲染输入的纯函数」缓存
 *
 * 依赖方向：component.ts → theme / texts / format / model / novel-markdown / view-rows / view-summary；本组件只做按键路由、视口切片与整屏缓存编排
 */

import {
  Editor,
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { clamp, clampWindowOffset, padToVisibleWidth, pushWrapped, safeLine, windowSlice } from "./format.js";
import {
  AskAuthorFormModel,
  hasQuestionNote,
  type AskAuthorResult,
  type EditTarget,
  type MenuItem,
  type NormalizedQuestion,
  type QuestionAnswerState,
} from "./model.js";
import { buildFullPreviewContentLines } from "./novel-markdown.js";
import { LAYOUT_CONFIG, TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { buildTabLines, formatMenuItemRow, optionLabelOf, pushFrameRule, pushHelpFooter } from "./view-rows.js";
import { buildSubmitSummaryContentLines, buildSummaryHelpParts } from "./view-summary.js";

/** 预览缓存池容量上限（条目数），防止长会话下缓存无界增长 */
const PREVIEW_CACHE_CAPACITY = 32;

/**
 * `ask_author` 交互式 TUI 组件（问卷作答与答卷总览）
 * 状态机：作答突变经 `AskAuthorFormModel`，`revision` 驱动两级缓存失效；`render()` 只写入透明备忘 / 观察缓存，绝不写回滚动位移等语义状态；`dispose()` 幂等且只设置 `disposed`，`finish()` 以 `isFinished` 保证 `done` 至多投递一次
 */
export class AskAuthorComponent implements Component, Focusable {
  /** Focusable 接口要求：输入模式焦点指示 */
  private _focused = false;
  /** 当前焦点状态（仅 `true` 时透传内置 Editor 以定位 IME 候选框） */
  get focused(): boolean {
    return this._focused;
  }
  /**
   * 设置焦点状态并级联透传至内置 Editor（同值为无操作）
   * @param value - 目标焦点状态；同时失效整屏 / Tab 栏 / 左栏缓存
   */
  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.editor.focused = this.inputMode && value;
    // Editor 的 IME 光标标记仅经由 renderInputMode 进入整屏缓存；两栏一并失效以防御后续布局把标记带入其他行
    this.touch();
    this.tabCache = undefined;
    this.leftColCache = undefined;
  }

  /** TUI 上下文 */
  private readonly tui: TUI;
  /** 主题 */
  private readonly theme: Theme;
  /** 问卷模型（作答状态唯一权威，mutation 自动推进 revision） */
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
  /** Esc 丢弃确认武装标记：编辑器非空时首次 Esc 仅武装，再次 Esc 才丢弃内容 */
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

  /** 预览框完整渲染行缓存池（键：题号+条目身份+列宽+补充说明；超 {@link PREVIEW_CACHE_CAPACITY} 按插入序淘汰） */
  private readonly previewCache = new Map<string, string[]>();

  /** 总览页未切片内容行缓存（键：列宽 + `revision`） */
  private summaryCachedLines?: { width: number; revision: number; lines: string[] };

  /** Tab 栏行缓存（键：当前页 + `revision` + 列宽） */
  private tabCache?: { key: string; lines: string[] };

  /** 左栏菜单行缓存（键：题号 + 光标 + 位移 + `revision` + 左栏宽） */
  private leftColCache?: { key: string; lines: string[] };

  /** 菜单项派生缓存（键：题号 + `revision`，消除 render/输入路径重复构建） */
  private menuCache?: { tab: number; revision: number; items: MenuItem[] };

  /** 上一帧预览视口的观察元数据（渲染写入、输入路径读取以归一化位移） */
  private previewViewportObservation?: { total: number; viewHeight: number };

  /** 当前编辑器针对的目标（题目整体或指定选项） */
  private editTarget?: EditTarget;

  /** 内置补充说明编辑器实例 */
  private readonly editor: Editor;

  /**
   * 构造交互式 TUI 主组件
   * @param tui - TUI 上下文
   * @param theme - 主题
   * @param model - 问卷模型
   * @param done - 结果回调
   */
  constructor(tui: TUI, theme: Theme, model: AskAuthorFormModel, done: (result: AskAuthorResult) => void) {
    this.tui = tui;
    this.theme = theme;
    this.model = model;
    this.done = done;

    const editorTheme: EditorTheme = {
      borderColor: (s) => this.theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => this.theme.fg("accent", t),
        selectedText: (t) => this.theme.fg("accent", t),
        description: (t) => this.theme.fg("muted", t),
        scrollInfo: (t) => this.theme.fg("dim", t),
        noMatch: (t) => this.theme.fg("warning", t),
      },
    };

    this.editor = new Editor(this.tui, editorTheme);
    this.editor.focused = false;
    // 批注突变委托模型 mutation，并按返回语义提示状态栏
    /**
     * 编辑器提交：写入当前目标（选项专属或题目整体）并按模型返回语义提示状态栏
     * @param text - 编辑器全文（空串即清空批注）
     */
    this.editor.onSubmit = (text) => {
      const target = this.editTarget;
      if (!target) {
        this.closeEditor();
        return;
      }

      if (target.type === "option") {
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
    this.clearStatusTimer();
    if (this.abortBinding) {
      this.abortBinding.signal.removeEventListener("abort", this.abortBinding.onAbort);
      this.abortBinding = undefined;
    }
    this.clearDerivedCaches();
    this.previewViewportObservation = undefined;
    this.clearFrameCaches();
  }

  /** 清空整屏帧缓存（列宽 / 行数键；不触发重绘） */
  private clearFrameCaches(): void {
    this.cachedWidth = undefined;
    this.cachedLayoutWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  /** 清空全部派生缓存（`revision` 键与内容键：预览池 / 总览 / Tab 栏 / 左栏 / 菜单项；不触发重绘） */
  private clearDerivedCaches(): void {
    this.previewCache.clear();
    this.summaryCachedLines = undefined;
    this.tabCache = undefined;
    this.leftColCache = undefined;
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
   * 终结作答流程并触发 `done`（至多投递一次）
   * `isFinished` 单守卫防止重复投递；不以 `disposed` 阻断（资源已回收但 `done` 未投递时仍须结算），跳转入 {@link dispose}
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

  /** Tab 总页数（题目页 + 总览提交页） */
  private get totalTabs(): number {
    return this.model.questionCount + 1;
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

  /** 总览页视口行数上限（随终端高度自适应；区间 `[4, LAYOUT_CONFIG.summaryPageSize]`） */
  private get summaryPageSize(): number {
    return clamp(this.terminalRows - 10, 4, LAYOUT_CONFIG.summaryPageSize);
  }

  /** 双栏右侧预览视口行数上限（区间 `[6, LAYOUT_CONFIG.splitPreviewHeight]`） */
  private get splitPreviewHeight(): number {
    return clamp(this.terminalRows - 14, 6, LAYOUT_CONFIG.splitPreviewHeight);
  }

  /** 单栏内联预览视口行数上限（区间 `[3, LAYOUT_CONFIG.singlePreviewHeight]`） */
  private get singlePreviewHeight(): number {
    return clamp(this.terminalRows - 18, 3, LAYOUT_CONFIG.singlePreviewHeight);
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
      const st = this.model.getState(this.currentTab);
      this.currentOptionIndex = this.cursorByTab.get(this.currentTab) ?? st.selectedIndex ?? 0;
      this.adjustScrollForCurrentOption();
    } else {
      this.currentOptionIndex = 0;
    }
    this.touch();
  }

  /** 收敛光标至合法区间并同步左栏滚动窗口，保证聚焦项可见（菜单项为空时直接返回） */
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
   * @returns 聚焦预设选项时为该选项，否则为题目整体
   */
  private getEditTargetForCurrentSelection(): EditTarget {
    const currentItem = this.currentMenuItem();
    if (currentItem?.type === "option" && currentItem.optionIndex !== undefined) {
      return { type: "option", optionIndex: currentItem.optionIndex };
    }
    return { type: "question" };
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
   * 确认当前题并跳转下一题 / 总览页（聚焦预设选项时先经模型写入选中）
   * @param currentItem - 聚焦菜单项
   * @param q - 当前题目（未达提交下限时仅提示状态栏，不切页）
   */
  private confirmAndAdvance(currentItem: MenuItem, q: NormalizedQuestion): void {
    if (currentItem.type === "option" && currentItem.optionIndex !== undefined) {
      this.model.commitOption(this.currentTab, currentItem.optionIndex);
    }

    if (this.model.isQuestionAnswered(this.currentTab)) {
      this.switchTab(this.currentTab < this.model.questionCount - 1 ? this.currentTab + 1 : this.model.questionCount);
      return;
    }
    this.setStatus(q.multiSelect ? TEXTS.status.minSelectRequired(q.minSelect) : TEXTS.status.pleaseAnswerBeforeSubmit);
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

    // 3. 数字键 1~9 快捷跳转题目（10 题以上经 Tab/hl 循环或总览页跳转）
    if (/^[1-9]$/.test(data)) {
      const targetIndex = parseInt(data, 10) - 1;
      if (targetIndex < this.model.questionCount) {
        this.switchTab(targetIndex);
        return;
      }
    }

    // 4. Tab / 方向键左右 / h / l Vim 风格切换题目
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l") {
      this.switchTab((this.currentTab + 1) % this.totalTabs);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h") {
      this.switchTab((this.currentTab - 1 + this.totalTabs) % this.totalTabs);
      return;
    }

    // 5. 分视图输入路由
    if (this.isSubmitTab) {
      this.handleSummaryInput(data);
    } else {
      this.handleQuestionInput(data);
    }
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
    if (!currentItem) return;

    if (matchesKey(data, Key.ctrl("s"))) {
      this.confirmAndAdvance(currentItem, q);
      return;
    }

    if (matchesKey(data, Key.space)) {
      this.activateMenuItem(currentItem, q);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (currentItem.type === "custom_note") {
        this.openCustomEditor({ type: "question" });
      } else {
        // 单选与多选统一：Enter = 选定并确认前进（多选未达下限时阻断），空格负责 toggle 勾选
        this.confirmAndAdvance(currentItem, q);
      }
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
    if (data === "N") {
      this.openCustomEditor({ type: "question" });
      return true;
    }

    // 2. 小写 'n' / 'e'：针对当前聚焦项打开编辑器（选项专属或题目整体）
    if (data === "n" || data === "e") {
      this.openCustomEditor();
      return true;
    }

    // 3. 'x' / Delete：清空补充说明（选项专属优先，其次题目整体）
    if (data === "x" || matchesKey(data, Key.delete)) {
      const currentItem = this.currentMenuItem();
      if (currentItem?.type === "option" && currentItem.optionIndex !== undefined) {
        const optIdx = currentItem.optionIndex;
        if (this.model.clearOptionNote(this.currentTab, optIdx)) {
          this.setStatus(TEXTS.status.optionNoteCleared(optionLabelOf(q, optIdx)));
          return true;
        }
      }
      if (this.model.clearQuestionNote(this.currentTab)) {
        this.setStatus(TEXTS.status.noteCleared);
        return true;
      }
    }

    return false;
  }

  /**
   * 预览区垂直滚动键（PgUp / PgDn / 方括号 / Alt+上下）
   * 滚动位移归一化归属输入路径：以渲染帧写入的 {@link previewViewportObservation} 为界经 `clampWindowOffset` 收敛（缺观察元数据时按单栏预览高度退化）
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handlePreviewScroll(data: string): boolean {
    let step = 0;
    if (matchesKey(data, Key.pageUp) || data === "[" || matchesKey(data, Key.alt("up"))) {
      step = -LAYOUT_CONFIG.previewScrollStep;
    } else if (matchesKey(data, Key.pageDown) || data === "]" || matchesKey(data, Key.alt("down"))) {
      step = LAYOUT_CONFIG.previewScrollStep;
    }
    if (step === 0) return false;
    const observation = this.previewViewportObservation;
    const viewHeight = observation?.viewHeight ?? this.singlePreviewHeight;
    const total = observation?.total ?? 0;
    this.previewScrollOffset = clampWindowOffset(this.previewScrollOffset + step, total, viewHeight);
    this.touch();
    return true;
  }

  /**
   * 选项菜单光标移动键（↑↓ / jk / Home / End）
   * @param data - 按键序列
   * @returns 是否已消费该按键
   */
  private handleCursorNavigation(data: string): boolean {
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveCursor({ delta: -1 });
      return true;
    }
    if (matchesKey(data, Key.down) || data === "j") {
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
    if (!q.multiSelect || data !== "a") return false;
    const result = this.model.selectAllOrClear(this.currentTab);
    if (result === "filled" && q.maxSelect < q.options.length) {
      this.setStatus(TEXTS.status.selectedUpToLimit(q.maxSelect));
    } else {
      this.touch();
    }
    return true;
  }

  /**
   * 触发聚焦条目主动作（唯一入口为空格键：选项勾选 / 打开补充说明 / 推进确认）
   * @param currentItem - 聚焦菜单项
   * @param q - 当前题目（选项命中上限时仅提示状态栏）
   */
  private activateMenuItem(currentItem: MenuItem, q: NormalizedQuestion): void {
    if (currentItem.type === "option" && currentItem.optionIndex !== undefined) {
      if (this.model.toggleOption(this.currentTab, currentItem.optionIndex) === "limit") {
        this.setStatus(TEXTS.status.maxSelectExceeded(q.maxSelect));
      } else {
        // 模型已变更而键盘路由不触发渲染，须立即重绘否则勾选滞后到下次按键
        this.touch();
      }
      return;
    }
    if (currentItem.type === "custom_note") {
      this.openCustomEditor({ type: "question" });
      return;
    }
    this.confirmAndAdvance(currentItem, q);
  }

  /**
   * 总览页键路由（滚动与回车提交；`Ctrl+S` 同义提交）
   * 空格更改为向下滚动（防止习惯性翻页误提交）；位移归一化归属本路径，上界获取自 `summaryCachedLines` 总行数与 `summaryPageSize`，`End` 仅设置超大值，由后续输入收敛
   * @param data - 按键序列
   */
  private handleSummaryInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) {
      if (this.model.areAllQuestionsAnswered()) {
        this.finish(false);
      } else {
        const firstUnfinished = this.model.questions.findIndex((_, idx) => !this.model.isQuestionAnswered(idx));
        if (firstUnfinished !== -1) {
          this.switchTab(firstUnfinished);
          const unfQ = this.model.getQuestion(firstUnfinished);
          if (unfQ) {
            this.setStatus(
              unfQ.multiSelect ? TEXTS.status.minSelectRequired(unfQ.minSelect) : TEXTS.status.pleaseAnswerBeforeSubmit,
            );
          }
        }
      }
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
    const total = this.summaryCachedLines?.lines.length ?? 0;
    const pageSize = this.summaryPageSize;
    // 先归一化过期位移（End 的超大值 / 题目变更后总行数变短）再叠加步进，保证 End 后按 ↑ 能回退
    const base = clampWindowOffset(this.summaryScrollOffset, total, pageSize);
    this.summaryScrollOffset = clampWindowOffset(base + step, total, pageSize);
    this.touch();
  }

  /**
   * 计算总览页滚动步长
   * @param data - 按键序列
   * @returns 行位移（正下负上，0 为无动作）
   */
  private summaryScrollStep(data: string): number {
    if (matchesKey(data, Key.pageUp) || data === "[" || matchesKey(data, Key.alt("up")))
      return -LAYOUT_CONFIG.summaryScrollStep;
    if (matchesKey(data, Key.pageDown) || data === "]" || matchesKey(data, Key.alt("down")))
      return LAYOUT_CONFIG.summaryScrollStep;
    if (matchesKey(data, Key.up) || data === "k") return -1;
    if (matchesKey(data, Key.down) || data === "j") return 1;
    return 0;
  }

  // ===== 视图渲染层 =====

  /**
   * Component 接口约定：渲染整屏行（带整屏缓存）
   * 缓存键绑定真实列宽、布局列宽与终端行数（窄于 20 列时二者截断范围不同，仅绑定 layoutWidth 会串帧；行数变化必须整体重新计算）；本方法及可达被调函数绝不写入语义状态，仅刷新透明备忘 / 观察缓存
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

    // 1. 顶部装饰线
    pushFrameRule(lines, this.theme, layoutWidth);

    // 2. Tab 导航栏（块级缓存，整块由 view-rows 层预计算）
    const tabCacheKey = `${this.currentTab}_${this.model.revision}_${layoutWidth}`;
    if (!this.tabCache || this.tabCache.key !== tabCacheKey) {
      this.tabCache = { key: tabCacheKey, lines: buildTabLines(this.theme, this.model, this.currentTab, layoutWidth) };
    }
    lines.push(...this.tabCache.lines);

    if (this.isSubmitTab) {
      this.renderSubmitSummary(lines, layoutWidth);
    } else if (this.inputMode) {
      this.renderInputMode(lines, layoutWidth);
    } else {
      this.renderQuestionView(lines, layoutWidth);
    }

    // 3. 最终行宽保护（按调用方真实列宽截断）与缓存写入
    this.cachedWidth = width;
    this.cachedLayoutWidth = layoutWidth;
    this.cachedHeight = renderHeight;
    this.cachedLines = lines.map((line) => safeLine(line, width));
    return this.cachedLines;
  }

  /**
   * 原地追加底部状态通知行（无文案时不追加，仅包含通知行与前面的空行）
   * @param lines - 输出行数组（原地追加）
   */
  private pushStatusMessage(lines: string[]): void {
    if (!this.statusMessage) return;
    lines.push("");
    lines.push(` ${this.theme.fg("warning", this.statusMessage)}`);
  }

  /**
   * 渲染答卷总览与确认提交页（完成状态 / 已选项 / 补充说明 / 提交指引）
   * 内容行由 `view-summary.ts` 构建并按 `(列宽, revision)` 缓存于 `summaryCachedLines`，本方法只做 O(1) 切片；位移在本地收敛，绝不写回 `summaryScrollOffset`（写入只发生在输入路径）
   * @param lines - 输出行数组
   * @param renderWidth - 终端布局列宽
   */
  private renderSubmitSummary(lines: string[], renderWidth: number): void {
    lines.push(this.theme.fg("accent", this.theme.bold(TEXTS.summary.title)));
    lines.push("");

    const contentWidth = renderWidth - 2;
    if (
      !this.summaryCachedLines ||
      this.summaryCachedLines.width !== contentWidth ||
      this.summaryCachedLines.revision !== this.model.revision
    ) {
      this.summaryCachedLines = {
        width: contentWidth,
        revision: this.model.revision,
        lines: buildSubmitSummaryContentLines(this.model, this.theme, contentWidth),
      };
    }

    const summaryContentLines = this.summaryCachedLines.lines;
    const totalSummaryLines = summaryContentLines.length;
    const pageSize = this.summaryPageSize;
    const offset = clampWindowOffset(this.summaryScrollOffset, totalSummaryLines, pageSize);

    if (offset > 0) {
      lines.push(this.theme.fg("dim", TEXTS.summary.topMore(offset)));
    }
    for (const sl of windowSlice(summaryContentLines, offset, pageSize)) {
      lines.push(sl);
    }
    const remaining = totalSummaryLines - (offset + pageSize);
    if (remaining > 0) {
      lines.push(this.theme.fg("dim", TEXTS.summary.bottomMore(remaining)));
    }

    lines.push("");
    const prompt = this.model.areAllQuestionsAnswered()
      ? this.theme.fg("success", this.theme.bold(TEXTS.summary.allDonePrompt))
      : this.theme.fg("warning", TEXTS.summary.pendingWarning);
    pushWrapped(lines, prompt, contentWidth);

    this.pushStatusMessage(lines);

    lines.push("");
    pushHelpFooter(lines, buildSummaryHelpParts(this.model), this.theme, renderWidth);
    pushFrameRule(lines, this.theme, renderWidth);
  }

  /**
   * 渲染补充说明编辑器全屏模式（标题 / 上下文背景 / 编辑框）
   * @param lines - 输出行数组
   * @param renderWidth - 终端可视宽度
   */
  private renderInputMode(lines: string[], renderWidth: number): void {
    const q = this.model.getQuestion(this.currentTab);
    if (!q) return;

    if (this.editTarget?.type === "option") {
      const optIdx = this.editTarget.optionIndex;
      const opt = q.options[optIdx];
      const optLabel = optionLabelOf(q, optIdx);
      const placeholder = opt?.customPlaceholder ?? TEXTS.fallbacks.defaultOptionCustomPlaceholder;

      lines.push(this.theme.fg("accent", this.theme.bold(TEXTS.editor.optionTitle(q.title, optLabel))));
      if (opt?.description) {
        pushWrapped(lines, this.theme.fg("muted", opt.description), renderWidth, "  ");
      }
      lines.push("");
      lines.push(this.theme.fg("accent", ` ${placeholder}`));
    } else {
      lines.push(this.theme.fg("accent", this.theme.bold(TEXTS.editor.title(q.title))));
      if (q.description) {
        pushWrapped(lines, this.theme.fg("muted", q.description), renderWidth, "  ");
      }
      lines.push("");
      lines.push(this.theme.fg("accent", ` ${q.customPlaceholder}`));
    }
    lines.push("");

    for (const el of this.editor.render(Math.max(10, renderWidth - 4))) {
      lines.push(`  ${el}`);
    }
    lines.push("");
    lines.push(this.theme.fg("dim", TEXTS.editor.footerHelp));
    pushFrameRule(lines, this.theme, renderWidth);
  }

  /**
   * 渲染常规题目作答视图（自适应双栏分屏或单栏紧凑列表）
   * @param lines - 输出行数组
   * @param renderWidth - 终端可视宽度
   */
  private renderQuestionView(lines: string[], renderWidth: number): void {
    const q = this.model.getQuestion(this.currentTab);
    if (!q) return;

    const st = this.model.getState(this.currentTab);
    const items = this.getMenuItems();

    // 1. 题目标签与标题
    const modeTag = q.multiSelect
      ? this.theme.fg("warning", TEXTS.view.modeMulti(q.minSelect, q.maxSelect, q.options.length, q.allowEmpty))
      : this.theme.fg("accent", TEXTS.view.modeSingle);
    pushWrapped(lines, ` ${modeTag} ${this.theme.bold(q.title)}`, renderWidth);

    if (q.description) {
      pushWrapped(lines, this.theme.fg("muted", q.description), renderWidth, "  ");
    }

    // 2. 补充说明横幅（题目整体补充 + 当前聚焦选项专属补充）
    if (st.customText?.trim()) {
      pushWrapped(lines, this.theme.fg("success", TEXTS.view.attachedNoteBanner(st.customText)), renderWidth, "  ");
    }
    const currentItem = this.currentMenuItem();
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
    const hasRichContent = q.options.some(
      (o, idx) => Boolean(o.preview) || visibleWidth(o.description ?? "") > 30 || Boolean(st.optionNotes.get(idx)),
    );
    if (renderWidth >= LAYOUT_CONFIG.splitViewMinWidth && hasRichContent) {
      this.renderSplitView(lines, q, st, items, renderWidth);
    } else {
      this.pushListItems(lines, items, q, st, renderWidth - 2, hasRichContent);
    }

    // 4. 底部状态通知与按键提示
    this.pushStatusMessage(lines);

    lines.push("");
    const helpParts: string[] = [TEXTS.help.switchQuestion];
    if (this.model.questionCount > 1) {
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
    if (hasRichContent) helpParts.push(TEXTS.help.scrollDraft);
    helpParts.push(TEXTS.help.cancel);

    pushHelpFooter(lines, helpParts, this.theme, renderWidth);
    pushFrameRule(lines, this.theme, renderWidth);
  }

  /**
   * 获取聚焦条目的预渲染完整内容行（`previewCache` 透明备忘缓存，跨条目 / 切换题目零重复解析）
   * @param item - 目标菜单项
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @returns 未切片的完整内容行数组；`item` 缺省时返回空数组
   */
  private previewContentLines(
    item: MenuItem | undefined,
    customText: string | undefined,
    optionNote: string | undefined,
    targetWidth: number,
  ): string[] {
    if (!item) return [];

    // 定界拼接杜绝变长字段歧义（字段值均已剥离控制字符）
    const cacheKey = [
      this.currentTab,
      item.type,
      item.optionIndex ?? -1,
      targetWidth,
      customText ?? "",
      optionNote ?? "",
    ].join("\x1f");

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
   * 计算并切片本帧预览框行（纯计算，不写回语义状态）
   * 位移由 `previewScrollOffset` 与本帧总行数在本地收敛；本帧观察元数据写入 {@link previewViewportObservation} 供输入路径归一化位移
   * @param item - 目标菜单项
   * @param customText - 题目整体补充说明
   * @param optionNote - 选项专属补充说明
   * @param targetWidth - 预览可用列宽
   * @param viewHeight - 视口最大行数
   * @returns 本帧可视内容行（含底部滚动信息行）
   */
  private buildPreviewBox(
    item: MenuItem | undefined,
    customText: string | undefined,
    optionNote: string | undefined,
    targetWidth: number,
    viewHeight: number,
  ): string[] {
    const fullLines = this.previewContentLines(item, customText, optionNote, targetWidth);
    const total = fullLines.length;
    this.previewViewportObservation = { total, viewHeight };
    return this.slicePreviewBoxLines(
      fullLines,
      clampWindowOffset(this.previewScrollOffset, total, viewHeight),
      viewHeight,
      targetWidth,
    );
  }

  /**
   * 对预渲染完整内容行做 O(1) 滑动窗口切片并附加底部行号信息
   * @param fullLines - 已折行完整内容行
   * @param scrollOffset - 已由 {@link clampWindowOffset} 收敛的起始行位移
   * @param viewHeight - 视口最大行数
   * @param targetWidth - 预览可用列宽
   * @returns 视口内容行与滚动信息行
   */
  private slicePreviewBoxLines(
    fullLines: readonly string[],
    scrollOffset: number,
    viewHeight: number,
    targetWidth: number,
  ): string[] {
    const totalLines = fullLines.length;
    const offset = clampWindowOffset(scrollOffset, totalLines, viewHeight);
    const boxLines = windowSlice(fullLines, offset, viewHeight).map((line) => safeLine(line, targetWidth));

    if (totalLines > viewHeight) {
      const scrollInfo = TEXTS.view.previewScrollInfo(
        offset + 1,
        Math.min(totalLines, offset + viewHeight),
        totalLines,
      );
      boxLines.push(safeLine(`  ${this.theme.fg("dim", scrollInfo)}`, targetWidth));
    }

    return boxLines;
  }

  /**
   * 渲染双栏视图（左选项菜单 + 右推演 / 分镜预览框）
   * @param lines - 输出行数组
   * @param q - 当前题目
   * @param st - 作答状态
   * @param items - 菜单项
   * @param renderWidth - 终端可用宽度（不足侧补空行至两栏等高）
   */
  private renderSplitView(
    lines: string[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    items: MenuItem[],
    renderWidth: number,
  ): void {
    const leftWidth = clamp(
      Math.floor(renderWidth * LAYOUT_CONFIG.leftColRatio),
      LAYOUT_CONFIG.leftColMin,
      LAYOUT_CONFIG.leftColMax,
    );
    const rightWidth = Math.max(20, renderWidth - leftWidth - LAYOUT_CONFIG.dividerWidth);

    const leftCacheKey = `${this.currentTab}_${this.currentOptionIndex}_${this.listScrollOffset}_${this.model.revision}_${leftWidth}`;
    let leftLines: string[];
    if (this.leftColCache && this.leftColCache.key === leftCacheKey) {
      leftLines = this.leftColCache.lines;
    } else {
      leftLines = [];
      this.pushListItems(leftLines, items, q, st, leftWidth, false);
      this.leftColCache = { key: leftCacheKey, lines: leftLines };
    }

    const currentItem = items[this.currentOptionIndex];
    const currentOptNote =
      currentItem?.type === "option" && currentItem.optionIndex !== undefined
        ? st.optionNotes.get(currentItem.optionIndex)
        : undefined;

    // 位移以本条目本帧总行数为界在本地收敛，绝不写回 previewScrollOffset
    const rightLines = this.buildPreviewBox(
      currentItem,
      st.customText,
      currentOptNote,
      rightWidth,
      this.splitPreviewHeight,
    );

    const maxRows = Math.max(leftLines.length, rightLines.length);
    for (let r = 0; r < maxRows; r++) {
      const lText = leftLines[r] ?? "";
      const rText = rightLines[r] ?? "";
      lines.push(
        `${padToVisibleWidth(lText, leftWidth)}${this.theme.fg("dim", LAYOUT_CONFIG.dividerChar)}${safeLine(rText, rightWidth)}`,
      );
    }
  }

  /**
   * 遍历输出菜单项行，单栏模式下在聚焦项下方内联展开预览
   * @param lines - 输出行数组
   * @param items - 菜单项
   * @param q - 当前题目
   * @param st - 作答状态
   * @param rowWidth - 选项行可用列宽
   * @param expandFocused - 是否展开聚焦项预览（窗口外条目不访问）
   */
  private pushListItems(
    lines: string[],
    items: MenuItem[],
    q: NormalizedQuestion,
    st: QuestionAnswerState,
    rowWidth: number,
    expandFocused: boolean,
  ): void {
    if (this.listScrollOffset > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listTopMore(this.listScrollOffset)));
    }

    const visibleSlice = items.slice(this.listScrollOffset, this.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount);
    for (const [offset, item] of visibleSlice.entries()) {
      if (!item) continue;
      const globalIndex = this.listScrollOffset + offset;
      const isFocused = globalIndex === this.currentOptionIndex;

      // 预设选项与操作区（补充说明/确认按钮）之间间隔一行
      const prevItem = items[globalIndex - 1];
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
        // 位移以本条目本帧实时总行数在本地收敛，绝不写回 previewScrollOffset
        const previewLines = this.buildPreviewBox(
          item,
          st.customText,
          itemOptNote,
          Math.max(10, rowWidth - 2),
          this.singlePreviewHeight,
        );
        for (const pl of previewLines) lines.push(pl);
        lines.push("");
      }
    }

    const remainingBelow = items.length - (this.listScrollOffset + LAYOUT_CONFIG.visibleOptionCount);
    if (remainingBelow > 0) {
      lines.push(this.theme.fg("dim", TEXTS.view.listBottomMore(remainingBelow)));
    }
  }
}
