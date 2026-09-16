/**
 * @file view-summary.ts
 * @description 纯函数视图排版层：答卷总览确认页的内容行与底部按键提示构建器
 *
 * 核心架构特性：
 * - 全部函数为无状态纯函数（无 `this` / 缓存 / IO）：内容构建器返回未切片的完整内容行数组，提示构建器返回提示片段数组
 * - 多选分支一律经 `model.getSelectedIndices`（升序不变量由模型层集中保证）
 *
 * 依赖方向：view-summary.ts → format.ts / model.ts / texts.ts / theme.ts；禁止反向导入 `component.ts`
 */

import { pushWrapped } from "./format.js";
import type { AskAuthorFormModel } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";

/**
 * 构建总览页底部按键提示片段（依据题目数量动态增删跳转题目提示）
 * @param model - 问卷表单数据模型（提供题目总数）
 * @returns 包含切换题目 / 滚动 / 提交 / 取消四项，题目数 > 1 时额外插入跳转题目提示
 */
export function buildSummaryHelpParts(model: AskAuthorFormModel): string[] {
  return [
    TEXTS.help.switchQuestion,
    ...(model.questionCount > 1 ? [TEXTS.help.jumpQuestion] : []),
    TEXTS.help.scrollSummary,
    TEXTS.help.confirmSubmit,
    TEXTS.help.cancel,
  ];
}

/**
 * 构建未切片的完整答卷总览内容行
 * 逐题输出四段（状态徽章 + 题目标题 / 已选项 / 选项专属批注 / 题目整体批注），题间以空行分隔；显式跳过与仅批注提交的题目同样入列，不静默消失
 * @param model - 问卷表单数据模型（作答状态的唯一权威来源）
 * @param theme - 主题样式提供者
 * @param contentWidth - 总览主体可用列宽（列），超宽行沿各段悬挂前缀折行
 * @returns 完整未切片的内容行数组；无效题目跳过，无有效题目时返回空数组
 */
export function buildSubmitSummaryContentLines(
  model: AskAuthorFormModel,
  theme: Theme,
  contentWidth: number,
): string[] {
  const summaryContentLines: string[] = [];

  for (let i = 0; i < model.questionCount; i++) {
    const q = model.getQuestion(i);
    if (!q) continue;
    const answered = model.isQuestionAnswered(i);
    const st = model.getState(i);
    const statusBadge = answered
      ? theme.fg("success", TEXTS.summary.statusDone)
      : theme.fg("warning", TEXTS.summary.statusPending);
    pushWrapped(
      summaryContentLines,
      `${statusBadge} ${theme.bold(TEXTS.summary.questionPrefix(i + 1, q.title))}`,
      contentWidth,
      " ",
    );

    const selectedLabels: string[] = [];
    if (q.multiSelect) {
      // 升序展示与 compileAnswers 保持一致（排序不变量由模型 getSelectedIndices 集中保证）
      for (const idx of model.getSelectedIndices(i)) {
        const opt = q.options[idx];
        if (!opt) continue;
        const note = st.optionNotes.get(idx);
        selectedLabels.push(note ? `${opt.label} ${TEXTS.summary.optionNoteBadge}` : opt.label);
      }
    } else if (st.selectedIndex !== undefined) {
      const opt = q.options[st.selectedIndex];
      if (opt) {
        const note = st.optionNotes.get(st.selectedIndex);
        selectedLabels.push(note ? `${opt.label} ${TEXTS.summary.optionNoteBadge}` : opt.label);
      }
    }

    const value = selectedLabels.length
      ? theme.fg("accent", selectedLabels.join(TEXTS.common.optionSeparator))
      : theme.fg("dim", TEXTS.fallbacks.unselectedOption);
    pushWrapped(summaryContentLines, `${theme.fg("muted", TEXTS.summary.selectedLabel)} ${value}`, contentWidth, "  ");

    // 显示各选项的专属批注
    for (const [optIdx, note] of st.optionNotes.entries()) {
      const opt = q.options[optIdx];
      if (opt && note?.trim()) {
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
