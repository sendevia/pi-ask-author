/**
 * @file theme.ts
 * @description TUI 主题类型的单一源头与依赖叶层，实例由 Pi 运行时注入
 *
 * 核心架构特性：
 * - 仅含类型别名，`import type` 编译期擦除，本模块零运行期依赖
 * - 不得导入插件内其他模块（维持无环单向依赖，避免 `texts.ts` ↔ `format.ts` 类型的环）
 *
 * 依赖方向：theme.ts → 无插件内依赖；外部仅取 `@earendil-works/pi-coding-agent` 类型
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** TUI 主题样式提供者类型（取自扩展上下文 `ui.theme`，与 `ctx.ui.custom` / `renderCall` / `renderResult` 注入的实例同型） */
export type Theme = ExtensionContext["ui"]["theme"];
