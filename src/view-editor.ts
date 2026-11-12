/**
 * @file view-editor.ts
 * @description 补充说明编辑页的全屏视图构建：面包屑标题区、编辑内容区与提示区
 *
 * 编辑框实例由组件传入并保持焦点；构造后回传编辑框位置供鼠标点击换算
 */

import type { Editor } from "@earendil-works/pi-tui";
import { pushWrapped } from "./format.js";
import { ICONS } from "./layout.js";
import type { AskAuthorFormModel, EditTarget } from "./model.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { composePage, optionLabelOf, renderLeadingButton, type ButtonRect } from "./view-rows.js";

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
  /** 返回按钮在整页中的矩形（鼠标点击路由依据） */
  readonly backButton?: ButtonRect;
}

/**
 * 拼装补充说明编辑页的标题区面包屑（问卷 → 题目 → 选项 → 补充说明面板）
 * @param theme - 当前 TUI 主题
 * @param segments - 由粗到细的定位片段
 * @returns 单行着色面包屑
 */
function breadcrumb(theme: Theme, segments: readonly string[]): string {
  const trail = segments.join(TEXTS.titleArea.breadcrumbSeparator);
  return theme.fg("accent", theme.bold(`${ICONS.note} ${trail}`));
}

/**
 * 渲染补充说明编辑页：题目标题区（返回按钮 + 可折行面包屑）→ 上下文与编辑框 → 提示区
 * @param theme - 当前 TUI 主题
 * @param model - 问卷模型（读取问卷标题与题目、选项文案）
 * @param tab - 当前题目索引
 * @param target - 编辑目标（整卷补充、题目整体或指定选项）
 * @param editor - 内置编辑器实例
 * @param tabLines - 题目导航 Tab 栏行（组件缓存）
 * @param statusMessage - 提示区的临时状态通知（丢弃确认等提醒）
 * @param renderWidth - 终端可视宽度
 * @param terminalRows - 终端可视行数
 * @returns 整页终端行、编辑框位置与返回按钮矩形；题目目标下题目不存在时行数组为空且无编辑框位置
 */
export function renderEditorPage(
  theme: Theme,
  model: AskAuthorFormModel,
  tab: number,
  target: EditTarget | undefined,
  editor: Editor,
  tabLines: readonly string[],
  statusMessage: string | null,
  renderWidth: number,
  terminalRows: number,
): EditorPage {
  // 1. 题目标题区：返回按钮在左、可折行的面包屑在右；内容区开头：编辑目标的上下文与占位提示
  const context: string[] = [];
  let title: string;

  if (target?.type === "form") {
    if (model.formDescription) pushWrapped(context, theme.fg("muted", model.formDescription), renderWidth, "  ");
    context.push(theme.fg("accent", ` ${TEXTS.fallbacks.defaultFormCustomPlaceholder}`));
    title = breadcrumb(theme, [model.formTitle, TEXTS.titleArea.formNote]);
  } else {
    const q = model.getQuestion(tab);
    if (!q) return { lines: [] };

    if (target?.type === "option") {
      const optIdx = target.optionIndex;
      const opt = q.options[optIdx];
      const optLabel = optionLabelOf(q, optIdx);
      if (opt?.description) pushWrapped(context, theme.fg("muted", opt.description), renderWidth, "  ");
      context.push(theme.fg("accent", ` ${opt?.customPlaceholder ?? TEXTS.fallbacks.defaultOptionCustomPlaceholder}`));
      title = breadcrumb(theme, [model.formTitle, q.title, optLabel, TEXTS.titleArea.optionNote]);
    } else {
      if (q.description) pushWrapped(context, theme.fg("muted", q.description), renderWidth, "  ");
      context.push(theme.fg("accent", ` ${q.customPlaceholder}`));
      title = breadcrumb(theme, [model.formTitle, q.title, TEXTS.titleArea.questionNote]);
    }
  }
  context.push("");

  // 2. 内容区：编辑框，占满四个区域之外的全部高度
  const head = renderLeadingButton(
    theme,
    { text: theme.fg("muted", TEXTS.titleArea.backButton), tone: "muted" },
    title,
    renderWidth,
  );
  const editorWidth = Math.max(10, renderWidth - EDITOR_INDENT * 2);
  const editorLines = editor.render(editorWidth).map((line) => `${" ".repeat(EDITOR_INDENT)}${line}`);
  const page = composePage(
    theme,
    renderWidth,
    terminalRows,
    { tabLines, titleLines: head.lines, answerLines: [], statusMessage, helpParts: [TEXTS.editor.footerHelp] },
    (height) => {
      const content = [...context, ...editorLines];
      while (content.length < height) content.push("");
      return content;
    },
  );

  const titleTop = tabLines.length;
  return {
    lines: page.lines,
    editorArea: {
      top: page.contentBand.start + context.length,
      height: editorLines.length,
      left: EDITOR_INDENT,
      width: editorWidth,
    },
    backButton: {
      rows: { start: titleTop + head.rect.rows.start, end: titleTop + head.rect.rows.end },
      cols: head.rect.cols,
    },
  };
}
