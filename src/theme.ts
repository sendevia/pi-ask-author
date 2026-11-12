/**
 * @file theme.ts
 * @description TUI 主题类型别名，实例由 Pi 运行时注入
 *
 * 仅含类型导出，编译期擦除，无插件内依赖
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** TUI 主题实例类型（取自扩展上下文 `ui.theme`） */
export type Theme = ExtensionContext["ui"]["theme"];

/** 主题前景色令牌（`Theme.fg` 的第一个参数） */
export type ThemeColor = Parameters<Theme["fg"]>[0];
