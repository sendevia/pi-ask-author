/**
 * @file novel-syntax.ts
 * @description 小说语法资产：定界符 → 语义哨兵 → 原生 Markdown 载体 → 主题样式的声明式模板表
 *
 * 核心架构特性：
 * - 新增小说语法只需在 `NOVEL_TEMPLATES` 表尾追加一项，两个派生索引自动生成
 * - 仅依赖 `theme.ts` 的类型别名，不装载语言资源与任何视图模块
 *
 * 依赖方向：novel-syntax.ts → theme.ts（仅类型）；被 novel-markdown.ts 消费
 */

import type { Theme } from "./theme.js";

/**
 * 语义哨兵前缀：不可见 NUL 控制字符，仅存在于 transform 产出与 `theme.code` 消费之间的中间态
 * 约定：输入侧已在 `format.ts` 边界剥离，分类时立即剥离，绝不进入终端输出
 */
export const NOVEL_MARKER_PREFIX = "\u0000";

/** 小说语法模板的字段规范（定界符 → 语义哨兵 → 原生 Markdown 载体 → 主题样式） */
export interface NovelSyntaxTemplate {
  /** 开始定界符 */
  readonly opener: string;
  /** 结束定界符 */
  readonly closer: string;
  /** 语义哨兵字符（紧随 {@link NOVEL_MARKER_PREFIX} 之后，`theme.code` 分类依据；`d` = dialogue、`m` = monologue） */
  readonly marker: string;
  /** 单个语义跨距最大字符数（含定界符；超出视为残缺定界符并放弃高亮） */
  readonly maxSpanLength: number;
  /**
   * 依据当前主题绘制语义文本
   * @param theme - 当前 TUI 主题实例（类型定义于叶层 `theme.ts`）
   * @param text - 已剥离哨兵的语义原文（含定界符）
   * @returns 应用语义样式后的富文本
   */
  readonly paint: (theme: Theme, text: string) => string;
}

/** 小说语法模板表（模块内部资产，仅由下方两个派生索引对外服务） */
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

/** 开定界符 → 语法模板 的 `O(1)` 索引（同开定界符按声明顺序后者覆盖前者） */
export const NOVEL_TEMPLATE_BY_OPENER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.opener, template]),
);

/** 语义哨兵字符 → 语法模板 的 `O(1)` 索引（`theme.code` 分类依据） */
export const NOVEL_TEMPLATE_BY_MARKER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.marker, template]),
);
