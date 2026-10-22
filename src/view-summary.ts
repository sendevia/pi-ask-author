/**
 * @file view-summary.ts
 * @description 答卷总览确认页的视图构建层：内容行、分页、提示与操作栏
 *
 * 核心架构特性：
 * - 内容构建器与提示构建器为无状态纯函数；`SummaryView` 只持有按（列宽, `revision`）失效的内容行缓存
 * - 多选分支一律经 `model.getSelectedIndices`（升序不变量由模型层集中保证）
 *
 * 依赖方向：view-summary.ts → format.ts / layout.ts / model.ts / texts.ts / theme.ts / view-rows.ts；禁止反向导入 `component.ts`
 */

import { clamp, clampWindowOffset, pushWrapped, windowSlice } from "./format.js";
import { LAYOUT_CONFIG } from "./layout.js";
import type { AskAuthorFormModel } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { pushFrameRule, pushHelpFooter, pushStatusMessage } from "./view-rows.js";

/**
 * 构建总览页底部按键提示片段（依据可见题目数量动态增删跳转题目提示）
 * @param model - 问卷表单数据模型（提供可见题目数与作答完成度）
 * @returns 包含切换题目 / 滚动 / 提交 / 取消四项，可见题目数 > 1 时额外插入跳转题目提示
 */
export function buildSummaryHelpParts(model: AskAuthorFormModel): string[] {
  return [
    TEXTS.help.switchQuestion,
    ...(model.getVisibleQuestionIndices().length > 1 ? [TEXTS.help.jumpQuestion] : []),
    TEXTS.help.scrollSummary,
    TEXTS.help.confirmSubmit,
    TEXTS.help.cancel,
  ];
}

/**
 * 总览页视口高度（随终端高度自适应；区间 `[4, LAYOUT_CONFIG.summaryPageSize]`）
 * @param terminalRows - 终端可视行数
 * @returns 单页最大内容行数
 */
export function summaryPageSize(terminalRows: number): number {
  return clamp(terminalRows - 10, 4, LAYOUT_CONFIG.summaryPageSize);
}

/**
 * 答卷总览与提交页构建器（持有内容行缓存，模型与主题在构造期固定）
 */
export class SummaryView {
  /** 未切片内容行缓存（键：列宽 + `revision`） */
  private cache?: { width: number; revision: number; lines: string[] };

  /**
   * @param theme - 当前 TUI 主题
   * @param model - 问卷模型（只读访问）
   */
  constructor(
    private readonly theme: Theme,
    private readonly model: AskAuthorFormModel,
  ) {}

  /** 清空内容行缓存（状态突变、主题切换与组件回收时调用） */
  clear(): void {
    this.cache = undefined;
  }

  /** 上一次构建的内容行总数（供组件在输入路径归一化滚动位移；尚未渲染时为 0） */
  get contentLineCount(): number {
    return this.cache?.lines.length ?? 0;
  }

  /**
   * 渲染总览页
   * @param scrollOffset - 当前滚动位移（在本地收敛，不写回）
   * @param pageSize - 单页最大内容行数
   * @param statusMessage - 底部临时状态通知（可为空）
   * @param renderWidth - 终端布局列宽
   * @returns 总览页完整终端行（含标题、提示、状态、帮助与底部框架线）
   */
  render(scrollOffset: number, pageSize: number, statusMessage: string | null, renderWidth: number): string[] {
    const lines: string[] = [this.theme.fg("accent", this.theme.bold(TEXTS.summary.title)), ""];
    const contentWidth = renderWidth - 2;

    if (!this.cache || this.cache.width !== contentWidth || this.cache.revision !== this.model.revision) {
      this.cache = {
        width: contentWidth,
        revision: this.model.revision,
        lines: buildSubmitSummaryContentLines(this.model, this.theme, contentWidth),
      };
    }

    const contentLines = this.cache.lines;
    const total = contentLines.length;
    const offset = clampWindowOffset(scrollOffset, total, pageSize);

    if (offset > 0) {
      lines.push(this.theme.fg("dim", TEXTS.summary.topMore(offset)));
    }
    for (const contentLine of windowSlice(contentLines, offset, pageSize)) {
      lines.push(contentLine);
    }
    const remaining = total - (offset + pageSize);
    if (remaining > 0) {
      lines.push(this.theme.fg("dim", TEXTS.summary.bottomMore(remaining)));
    }

    lines.push("");
    const prompt = this.model.areAllQuestionsAnswered()
      ? this.theme.fg("success", this.theme.bold(TEXTS.summary.allDonePrompt))
      : this.theme.fg("warning", TEXTS.summary.pendingWarning);
    pushWrapped(lines, prompt, contentWidth);

    pushStatusMessage(lines, this.theme, statusMessage);

    lines.push("");
    pushHelpFooter(lines, buildSummaryHelpParts(this.model), this.theme, renderWidth);
    pushFrameRule(lines, this.theme, renderWidth);
    return lines;
  }
}

/**
 * 构建未切片的完整答卷总览内容行
 * 逐题输出四段（状态徽章 + 题目标题 / 已选项 / 选项专属批注 / 题目整体批注），题间以空行分隔；隐条件隐藏的题目不入列，
 * 显式跳过与仅批注提交的题目同样入列；题目序号为可见题目的展示序号
 * @param model - 问卷表单数据模型（作答状态的唯一权威来源）
 * @param theme - 主题样式提供者
 * @param contentWidth - 总览主体可用列宽（列），超宽行沿各段悬挂前缀折行
 * @returns 完整未切片的内容行数组；无效题目跳过，无可见题目时返回空数组
 */
export function buildSubmitSummaryContentLines(
  model: AskAuthorFormModel,
  theme: Theme,
  contentWidth: number,
): string[] {
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
      // 升序展示与 compileAnswers 保持一致（排序不变量由模型 getSelectedIndices 集中保证，已剔除隐藏选项）
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

  return summaryContentLines;
}
