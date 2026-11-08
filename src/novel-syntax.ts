/**
 * @file novel-syntax.ts
 * @description 小说语法模板表：定界符 → 语义哨兵 → 主题样式
 *
 * 新增语法只需在 `NOVEL_TEMPLATES` 追加一项，两个派生索引自动生成
 */

import type { Theme } from "./theme.js";

/**
 * 语义哨兵前缀：不可见 NUL 字符，仅存在于转换产物与 `theme.code` 分类之间这个中间态，不进入终端输出
 */
export const NOVEL_MARKER_PREFIX = "\u0000";

/** 小说语法模板的字段规范 */
export interface NovelSyntaxTemplate {
  /** 开始定界符 */
  readonly opener: string;
  /** 结束定界符 */
  readonly closer: string;
  /** 语义哨兵字符，`theme.code` 据此分类（`d` 对话、`m` 独白） */
  readonly marker: string;
  /** 单个语义跨距的最大字符数（含定界符），超出视为残缺定界符并放弃高亮 */
  readonly maxSpanLength: number;
  /**
   * 依据当前主题绘制语义文本
   * @param theme - 当前 TUI 主题实例
   * @param text - 已剥离哨兵的语义原文（含定界符）
   * @returns 应用语义样式后的富文本
   */
  readonly paint: (theme: Theme, text: string) => string;
}

/** 小说语法模板表（仅由下方两个派生索引对外服务） */
const NOVEL_TEMPLATES: readonly NovelSyntaxTemplate[] = [
  /** 对话台词（`「」`）：以 accent 强调色着色 */
  { opener: "「", closer: "」", marker: "d", maxSpanLength: 400, paint: (theme, text) => theme.fg("accent", text) },
  /** 内心独白与旁白（`（）`）：muted 柔和色叠加斜体 */
  {
    opener: "（",
    closer: "）",
    marker: "m",
    maxSpanLength: 400,
    paint: (theme, text) => theme.fg("muted", theme.italic(text)),
  },
];

/** 开定界符 → 模板的查询索引（同键按声明顺序后者覆盖前者） */
export const NOVEL_TEMPLATE_BY_OPENER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.opener, template]),
);

/** 语义哨兵字符 → 模板的查询索引 */
export const NOVEL_TEMPLATE_BY_MARKER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.marker, template]),
);
