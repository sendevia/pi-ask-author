/**
 * @file view-editor.ts
 * @description 补充说明编辑器的全屏视图构建器
 *
 * 核心架构特性：
 * - 只根据编辑目标拼装标题、上下文与编辑器行，编辑器实例由组件传入并保持焦点状态
 * - 不读取也不写入组件的输入模式标记；离开输入模式仍由组件在按键路径决定
 *
 * 依赖方向：view-editor.ts → format.ts / model.ts / texts.ts / theme.ts / view-rows.ts；禁止反向导入 component.ts
 */

import type { Editor } from "@earendil-works/pi-tui";
import { pushWrapped } from "./format.js";
import type { AskAuthorFormModel, EditTarget } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { optionLabelOf, pushFrameRule } from "./view-rows.js";

/**
 * 渲染补充说明编辑器全屏模式（标题 / 上下文背景 / 编辑框 / 页脚按键提示 / 底部框架线）
 * @param theme - 当前 TUI 主题
 * @param model - 问卷模型（读取题目与选项文案）
 * @param tab - 当前题目索引
 * @param target - 编辑目标（题目整体或指定选项）
 * @param editor - 内置编辑器实例
 * @param renderWidth - 终端可视宽度
 * @returns 编辑器页的完整终端行；题目越界时返回空数组
 */
export function renderEditorPage(
  theme: Theme,
  model: AskAuthorFormModel,
  tab: number,
  target: EditTarget | undefined,
  editor: Editor,
  renderWidth: number,
): string[] {
  const q = model.getQuestion(tab);
  if (!q) return [];

  const lines: string[] = [];
  if (target?.type === "option") {
    const optIdx = target.optionIndex;
    const opt = q.options[optIdx];
    const optLabel = optionLabelOf(q, optIdx);
    const placeholder = opt?.customPlaceholder ?? TEXTS.fallbacks.defaultOptionCustomPlaceholder;

    lines.push(theme.fg("accent", theme.bold(TEXTS.editor.optionTitle(q.title, optLabel))));
    if (opt?.description) {
      pushWrapped(lines, theme.fg("muted", opt.description), renderWidth, "  ");
    }
    lines.push("");
    lines.push(theme.fg("accent", ` ${placeholder}`));
  } else {
    lines.push(theme.fg("accent", theme.bold(TEXTS.editor.title(q.title))));
    if (q.description) {
      pushWrapped(lines, theme.fg("muted", q.description), renderWidth, "  ");
    }
    lines.push("");
    lines.push(theme.fg("accent", ` ${q.customPlaceholder}`));
  }
  lines.push("");

  for (const el of editor.render(Math.max(10, renderWidth - 4))) {
    lines.push(`  ${el}`);
  }
  lines.push("");
  lines.push(theme.fg("dim", TEXTS.editor.footerHelp));
  pushFrameRule(lines, theme, renderWidth);
  return lines;
}
