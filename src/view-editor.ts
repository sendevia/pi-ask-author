/**
 * @file view-editor.ts
 * @description 补充说明编辑器的全屏视图构建器
 *
 * 编辑框实例由组件传入并保持焦点；构造后回传编辑框位置供鼠标点击换算
 */

import type { Editor } from "@earendil-works/pi-tui";
import { pushWrapped } from "./format.js";
import type { AskAuthorFormModel, EditTarget } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { optionLabelOf, pushFrameRule } from "./view-rows.js";

/** 编辑框左右两侧的缩进列数 */
const EDITOR_INDENT = 2;

/** 编辑框在整页中的位置（鼠标点击换算依据） */
export interface EditorArea {
  /** 首行（编辑框顶部边框）在整页中的行号 */
  readonly top: number;
  /** 编辑框渲染行数 */
  readonly height: number;
  /** 左侧缩进的可见列数 */
  readonly left: number;
  /** 传给编辑器的渲染宽度 */
  readonly width: number;
}

/** 编辑器页渲染结果 */
export interface EditorPage {
  /** 整页终端行（题目缺失时为空数组） */
  readonly lines: string[];
  /** 编辑框位置；题目缺失时为 undefined */
  readonly editorArea?: EditorArea;
}

/**
 * 渲染补充说明编辑器全屏页（顶部分割线 / Tab 栏 / 标题与上下文 / 编辑框 / 页脚按键提示 / 底部分割线）
 * @param theme - 当前 TUI 主题
 * @param model - 问卷模型（读取题目与选项文案）
 * @param tab - 当前题目索引
 * @param target - 编辑目标（题目整体或指定选项）
 * @param editor - 内置编辑器实例
 * @param tabLines - 题目导航 Tab 栏行（组件缓存）
 * @param renderWidth - 终端可视宽度
 * @param terminalRows - 终端可视行数
 * @returns 整页终端行与编辑框位置；题目不存在时行数组为空且无编辑框位置
 */
export function renderEditorPage(
  theme: Theme,
  model: AskAuthorFormModel,
  tab: number,
  target: EditTarget | undefined,
  editor: Editor,
  tabLines: readonly string[],
  renderWidth: number,
  terminalRows: number,
): EditorPage {
  const q = model.getQuestion(tab);
  if (!q) return { lines: [] };

  const lines: string[] = [];
  pushFrameRule(lines, theme, renderWidth);
  lines.push(...tabLines);

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

  const editorWidth = Math.max(10, renderWidth - EDITOR_INDENT * 2);
  const editorTop = lines.length;
  const editorLines = editor.render(editorWidth).map((line) => `${" ".repeat(EDITOR_INDENT)}${line}`);
  lines.push(...editorLines);

  const tail: string[] = [""];
  pushWrapped(tail, theme.fg("dim", TEXTS.editor.footerHelp), renderWidth, " ");
  pushFrameRule(tail, theme, renderWidth);

  for (let i = lines.length + tail.length; i < terminalRows; i++) lines.push("");
  lines.push(...tail);

  return { lines, editorArea: { top: editorTop, height: editorLines.length, left: EDITOR_INDENT, width: editorWidth } };
}
