/**
 * @file view-summary.ts
 * @description 答卷总览确认页的视图构建：内容区、分页、提示与操作栏
 *
 * 内容构建器与提示构建器无状态；`SummaryView` 只持有按列宽与 `revision` 失效的内容行缓存
 */

import { pushWrapped } from "./format.js";
import { LAYOUT_CONFIG } from "./layout.js";
import type { AskAuthorFormModel } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import {
  buildScrollBand,
  pushFrameRule,
  pushHelpFooter,
  pushStatusMessage,
  renderButtonGroup,
  type ButtonRect,
  type RowRange,
} from "./view-rows.js";

/** 总览页内容区左右缩进（与题目行的悬挂缩进一致） */
const SUMMARY_INSET = 2;

/**
 * 构建总览页底部按键提示片段（可见题目数大于 1 时插入跳转题目提示）
 * 提交与整卷补充各有底部按钮，提示行不再重复
 * @param model - 问卷模型
 * @returns 切换题目 / 滚动 / 补充说明清空 / 取消，可见题目数大于 1 时额外插入跳转题目
 */
export function buildSummaryHelpParts(model: AskAuthorFormModel): string[] {
  return [
    TEXTS.help.switchQuestion,
    ...(model.getVisibleQuestionIndices().length > 1 ? [TEXTS.help.jumpQuestion] : []),
    TEXTS.help.scrollSummary,
    TEXTS.help.editFormNote,
    TEXTS.help.cancel,
  ];
}

/** 总览页内容视口的观察值（渲染后回传组件，用于归一化滚动位移） */
export interface SummaryViewport {
  /** 未切片的完整内容行数 */
  readonly total: number;
  /** 本帧内容区可视行数（已扣除滚动信息行） */
  readonly viewHeight: number;
}

/** 总览页渲染结果 */
export interface SummaryViewResult {
  /** 整页终端行（含顶部分割线、内容区、Tab 栏、提示、按钮与帮助栏） */
  readonly lines: string[];
  /** 本帧内容视口观察值 */
  readonly viewport: SummaryViewport;
  /** Tab 栏占用的整页行范围（鼠标点击路由依据） */
  readonly tabRange: RowRange;
  /** 本帧可见的整卷补充按钮矩形（鼠标点击路由依据）；未滚动到时为 undefined */
  readonly formNoteButton?: ButtonRect;
  /** 确认提交按钮的整页矩形（鼠标点击路由依据） */
  readonly submitButton?: ButtonRect;
}

/** 总览页未切片的完整内容行与其中整卷补充按钮的矩形 */
export interface SummaryContent {
  /** 完整未切片的内容行 */
  readonly lines: string[];
  /** 整卷补充按钮在内容行中的矩形（行号相对内容首行） */
  readonly formNoteButton?: ButtonRect;
}

/** 答卷总览与提交页构建器（持有内容行缓存，主题与模型在构造期固定） */
export class SummaryView {
  /** 未切片内容行缓存（键：列宽 + `revision`） */
  private cache?: { width: number; revision: number; content: SummaryContent };

  /**
   * @param theme - 当前 TUI 主题
   * @param model - 问卷模型
   */
  constructor(
    private readonly theme: Theme,
    private readonly model: AskAuthorFormModel,
  ) {}

  /** 清空内容行缓存（状态突变、主题切换与组件回收时调用） */
  clear(): void {
    this.cache = undefined;
  }

  /**
   * 渲染总览页：顶部分割线 → 内容区 → Tab 栏 → 标题与提示 → 帮助栏 → 底部分割线
   * 内容区占满终端剩余高度，长答卷按滚轮分页
   * @param tabLines - 题目导航 Tab 栏行（组件缓存）
   * @param scrollOffset - 当前滚动位移（在本地收敛，不写回）
   * @param statusMessage - 底部临时状态通知
   * @param renderWidth - 终端布局列宽
   * @param terminalRows - 终端可视行数
   * @returns 整页终端行、本帧内容视口与 Tab 栏行范围
   */
  render(
    tabLines: readonly string[],
    scrollOffset: number,
    statusMessage: string | null,
    renderWidth: number,
    terminalRows: number,
  ): SummaryViewResult {
    const contentWidth = renderWidth - 2;

    if (!this.cache || this.cache.width !== contentWidth || this.cache.revision !== this.model.revision) {
      this.cache = {
        width: contentWidth,
        revision: this.model.revision,
        content: buildSubmitSummaryContentLines(this.model, this.theme, contentWidth),
      };
    }

    // 1. 内容区以下的各带：标题、提示、状态、确认提交按钮、快捷键与底部分割线
    const ready = this.model.areAllQuestionsAnswered();
    const body: string[] = [this.theme.fg("accent", this.theme.bold(TEXTS.summary.title))];
    const prompt = ready
      ? this.theme.fg("success", this.theme.bold(TEXTS.summary.allDonePrompt))
      : this.theme.fg("warning", TEXTS.summary.pendingWarning);
    pushWrapped(body, prompt, contentWidth);
    pushStatusMessage(body, this.theme, statusMessage);

    body.push("");
    const submitGroup = renderButtonGroup(
      this.theme,
      [{ text: TEXTS.summary.submitButton, tone: ready ? "success" : "warning" }],
      renderWidth,
      "right",
    );
    body.push(...submitGroup.lines);

    body.push("");
    pushHelpFooter(body, buildSummaryHelpParts(this.model), this.theme, renderWidth);
    pushFrameRule(body, this.theme, renderWidth);

    // 2. 内容区占满终端剩余高度（不设上限）
    const bandHeight = Math.max(LAYOUT_CONFIG.previewMinHeight, terminalRows - 1 - tabLines.length - body.length);
    const content = this.cache.content;
    const band = buildScrollBand(content.lines, bandHeight, scrollOffset, this.theme, renderWidth);

    // 整卷补充按钮只在滚入可视窗口时回传，鼠标换行到带宽之外的点不接管
    const noteButton = content.formNoteButton;
    const noteStart = noteButton ? Math.max(noteButton.rows.start, band.offset) : 0;
    const noteEnd = noteButton ? Math.min(noteButton.rows.end, band.offset + band.viewHeight) : 0;
    const submitRect = submitGroup.rects[0];
    const bodyStart = 1 + bandHeight + tabLines.length;

    // 3. 按带序输出整页（顶部分割线占首行，内容区紧接其后）
    const lines: string[] = [];
    pushFrameRule(lines, this.theme, renderWidth);
    lines.push(...band.lines, ...tabLines, ...body);
    return {
      lines,
      viewport: { total: content.lines.length, viewHeight: band.viewHeight },
      tabRange: { start: 1 + bandHeight, end: 1 + bandHeight + tabLines.length },
      formNoteButton:
        noteButton && noteEnd > noteStart
          ? { rows: { start: 1 + noteStart - band.offset, end: 1 + noteEnd - band.offset }, cols: noteButton.cols }
          : undefined,
      submitButton: submitRect
        ? {
            rows: { start: bodyStart + submitRect.rows.start, end: bodyStart + submitRect.rows.end },
            cols: submitRect.cols,
          }
        : undefined,
    };
  }
}

/**
 * 构建未切片的完整答卷总览内容行
 * 逐题输出四段（状态徽章 + 标题 / 已选项 / 选项专属批注 / 题目整体批注），题间以空行分隔；隐藏题目不入列，显式跳过与仅批注提交的题目同样入列
 * 全部题目条目之后追加整卷补充块（标题行 + 正文或未填写占位）
 * @param model - 问卷模型（作答状态的唯一来源）
 * @param theme - 主题样式提供者
 * @param contentWidth - 总览主体可用列宽，超宽行沿悬挂前缀折行
 * @returns 完整未切片内容行与其中整卷补充块的行范围；无可见题目时内容行仅含补充块
 */
export function buildSubmitSummaryContentLines(
  model: AskAuthorFormModel,
  theme: Theme,
  contentWidth: number,
): SummaryContent {
  const summaryContentLines: string[] = [];

  for (const [displayIndex, i] of model.getVisibleQuestionIndices().entries()) {
    const q = model.getQuestion(i);
    if (!q) continue;
    const answered = model.isQuestionAnswered(i);
    const st = model.getState(i);
    const statusBadge = answered
      ? theme.fg("success", TEXTS.summary.statusDone)
      : theme.fg("warning", TEXTS.summary.statusPending);
    pushWrapped(
      summaryContentLines,
      `${statusBadge} ${theme.bold(TEXTS.summary.questionPrefix(displayIndex + 1, q.title))}`,
      contentWidth,
      " ",
    );

    const selectedLabels: string[] = [];
    if (q.multiSelect) {
      // 升序展示与 compileAnswers 保持一致（排序不变量由 getSelectedIndices 保证，已剔除隐藏选项）
      for (const idx of model.getSelectedIndices(i)) {
        const opt = q.options[idx];
        if (!opt) continue;
        const note = st.optionNotes.get(idx);
        selectedLabels.push(note ? `${opt.label} ${TEXTS.summary.optionNoteBadge}` : opt.label);
      }
    } else {
      const selectedIndex = model.getSelectedIndex(i);
      const opt = selectedIndex === undefined ? undefined : q.options[selectedIndex];
      if (opt && selectedIndex !== undefined) {
        const note = st.optionNotes.get(selectedIndex);
        selectedLabels.push(note ? `${opt.label} ${TEXTS.summary.optionNoteBadge}` : opt.label);
      }
    }

    const value = selectedLabels.length
      ? theme.fg("accent", selectedLabels.join(TEXTS.common.optionSeparator))
      : theme.fg("dim", TEXTS.fallbacks.unselectedOption);
    pushWrapped(summaryContentLines, `${theme.fg("muted", TEXTS.summary.selectedLabel)} ${value}`, contentWidth, "  ");

    // 显示各选项的专属批注（仅当前可见选项）
    for (const [optIdx, note] of st.optionNotes.entries()) {
      const opt = q.options[optIdx];
      if (opt && note?.trim() && model.isOptionVisible(i, optIdx)) {
        pushWrapped(
          summaryContentLines,
          `${theme.fg("muted", TEXTS.summary.optionNotePrefix(opt.label))} ${theme.fg("accent", note)}`,
          contentWidth,
          "  ",
        );
      }
    }

    // 显示题目整体批注
    if (st.customText) {
      pushWrapped(
        summaryContentLines,
        `${theme.fg("muted", TEXTS.summary.customNoteLabel)} ${theme.fg("accent", st.customText)}`,
        contentWidth,
        "  ",
      );
    }
    summaryContentLines.push("");
  }

  // 整卷补充排在全部题目条目之后：作者在提交前最后填写，位置与封套中的输出顺序一致
  const formNote = model.formNote?.trim();
  const start = summaryContentLines.length;
  const group = renderButtonGroup(
    theme,
    [
      {
        text: formNote ? TEXTS.summary.formNoteFilled(formNote) : TEXTS.summary.formNoteEmpty,
        tone: formNote ? "success" : "muted",
      },
    ],
    contentWidth,
    "left",
    SUMMARY_INSET,
  );
  summaryContentLines.push(...group.lines);

  const rect = group.rects[0];
  return {
    lines: summaryContentLines,
    formNoteButton: rect
      ? {
          rows: { start: start + rect.rows.start, end: start + rect.rows.end },
          cols: rect.cols,
        }
      : undefined,
  };
}
