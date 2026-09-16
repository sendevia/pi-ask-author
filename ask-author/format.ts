/**
 * @file format.ts
 * @description 纯函数算法与排版工具层：视口计算、文本折行、ANSI 宽度测量、文本规整
 *
 * 核心架构特性：
 * - 除 `safeKeyHint` 外全部函数无副作用、不依赖运行时可变状态，供 sanitize / model / novel-markdown / view-* / component / index 复用
 * - `safeKeyHint` 为本层唯一宿主耦合点：经 Pi `keyHint` 读取全局主题与按键表，故以 try/catch 兜底
 * - 终端宽度一律经 `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`，禁止 `string.length` 直算
 *
 * 依赖方向：format.ts → texts.ts（布局常量与文案字典）；另引用宿主 `keyHint`
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { LAYOUT_CONFIG, TEXTS } from "./texts.js";

/**
 * 将数值收敛至闭区间 `[min, max]`
 * @param value - 待收敛数值
 * @param min - 区间下界
 * @param max - 区间上界
 * @returns 落在 `[min, max]` 内的数值；`min > max` 时恒返回 `min`
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 将视口滚动偏移收敛至合法区间，防止越界滚动造成空白视口
 * @param offset - 待收敛的 0-based 起始行偏移
 * @param total - 内容总行数
 * @param viewHeight - 可视行数（调用方须传入非负值）
 * @returns `[0, max(0, total - viewHeight)]` 内的偏移；列表为空或内容不足一屏（`total <= viewHeight`）时恒为 0
 */
export function clampWindowOffset(offset: number, total: number, viewHeight: number): number {
  return clamp(offset, 0, Math.max(0, total - viewHeight));
}

/**
 * 截取视口可视行切片（仅复制可视区，不遍历非可视区数据）
 * @param lines - 完整内容行数组（只读，不修改入参）
 * @param offset - 0-based 起始行偏移（须先经 {@link clampWindowOffset} 收敛；负值退化为从尾部切片）
 * @param viewHeight - 可视行数
 * @returns 至多 `viewHeight` 行的新数组；`lines` 为空、`viewHeight <= 0` 或 `offset` 越过末行时返回空数组
 */
export function windowSlice<T>(lines: readonly T[], offset: number, viewHeight: number): T[] {
  return lines.slice(offset, offset + viewHeight);
}

/**
 * 清除回车符并将制表符规整为双空格（纯文本规整，不剥离 ANSI 控制序列）
 * @param str - 原始文本；缺省时按空串处理
 * @returns 规整后的文本（入参为 undefined 时返回空串，永不返回 undefined）
 */
export function cleanText(str: string | undefined): string {
  return str ? str.replace(/\t/g, "  ").replace(/\r/g, "") : "";
}

/**
 * 剥离终端转义与控制字符（防 ANSI 注入污染 TUI 渲染管线）
 * 覆盖 OSC（BEL/ST 终止）、CSI、双字符转义与残余 C0 控制字符；换行符保留，由调用方决定单行化时机
 * @param str - 已由 `cleanText` 规整的字符串（无回车与制表符）
 * @returns 剥离全部转义序列与残余 C0 控制字符（含 DEL `\x7f`）的字符串；换行符 `\n` 保留
 */
function stripControlSequences(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * 裁剪空白并剥离终端控制序列；纯空白或剥离后为空的输入均返回 undefined
 * 契约：返回值要么是非空字符串，要么是 undefined——调用方的 `?? 兜底` 不会漏接空串
 * 边界：仅用于不可信输入边界（工具参数、编辑器文本）；渲染路径用 `cleanText` / `safeLine`
 * @param str - 原始不可信文本；缺省时返回 undefined
 * @returns 清洗后的非空字符串；纯空白或剥离控制序列后为空时返回 undefined
 */
export function cleanOptional(str: string | undefined): string | undefined {
  const t = str?.trim();
  return t ? stripControlSequences(cleanText(t)) || undefined : undefined;
}

/**
 * 尝试 `JSON.parse`；非字符串原样返回，解析失败返回 undefined
 * @param value - 待解析值
 * @returns 解析结果或原值；字符串长度（UTF-16 码元）超过 1_000_000 时直接返回 undefined，以规避解析开销与内存放大
 */
export function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 1_000_000) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * 悬挂缩进折行：首行携带前缀，后续折行左缘按前缀可见宽度对齐
 * 宽度按 CJK 全角与 ANSI 转义精确计算（`visibleWidth` / `wrapTextWithAnsi`）
 * @param prefix - 首行前缀（后续行以同宽空格悬挂对齐）
 * @param text - 待折行文本
 * @param width - 可视总宽度（列）；调用方须传 `>= 1`，`width <= 0` 时不截断前缀
 * @returns 折行后的行数组；`text` 无法产出任何行时返回 `[prefix]`（前缀非空）或空数组
 */
function hangText(prefix: string, text: string, width: number): string[] {
  let prefixW = visibleWidth(prefix);
  if (prefixW >= width && width > 0) {
    prefix = truncateToWidth(prefix, width - 1);
    prefixW = visibleWidth(prefix);
  }
  const availableW = Math.max(1, width - prefixW);
  const pad = " ".repeat(prefixW);
  const wrapped = wrapTextWithAnsi(text, availableW);
  if (wrapped.length === 0) return prefix ? [prefix] : [];
  return wrapped.map((line, i) => (i === 0 ? prefix + line : pad + line));
}

/**
 * 将悬挂折行结果原地追加至目标行数组
 * @param lines - 目标行数组（原地追加）
 * @param text - 待追加文本
 * @param width - 可视总宽度
 * @param prefix - 首行前缀（后续折行等宽悬挂缩进对齐）
 */
export function pushWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  lines.push(...hangText(prefix, text, width));
}

/**
 * 单行安全截断，保证可见宽度不超过 `maxWidth`（超宽部分截断，并沿用 `truncateToWidth` 的默认省略号 `...`）
 * @param str - 原始文本（先经 `cleanText` 清除回车与制表符）
 * @param maxWidth - 最大可见宽度（列）；`<= 0` 时返回空串
 * @returns 可见宽度不超过 `maxWidth` 的单行文本（未超宽时原样返回，不做补齐）
 */
export function safeLine(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const cleaned = cleanText(str);
  return visibleWidth(cleaned) > maxWidth ? truncateToWidth(cleaned, maxWidth) : cleaned;
}

/**
 * 按可见宽度填充至指定宽度（支持 CJK 与 ANSI）
 * @param str - 原始文本（先经 `cleanText` 清除回车与制表符）
 * @param targetWidth - 目标可见宽度（列）；`<= 0` 时返回空串
 * @returns 可见宽度不超过 `targetWidth` 的单行文本：不足则右补空格，超宽则截断并以默认省略号 `...` 收尾（含全角字符时结果可能略窄于 `targetWidth`）
 */
export function padToVisibleWidth(str: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  const cleaned = cleanText(str);
  const w = visibleWidth(cleaned);
  if (w >= targetWidth) return truncateToWidth(cleaned, targetWidth);
  return cleaned + " ".repeat(targetWidth - w);
}

/**
 * 生成指定宽度的横向分隔线
 * @param width - 目标可见宽度（列）
 * @param char - 填充字符（默认 `LAYOUT_CONFIG.dividerThin`，每字符宽度按 1 列计）
 * @returns `width <= 0` 时返回空串，否则返回 `char` 重复 `width` 次
 */
export function divider(width: number, char: string = LAYOUT_CONFIG.dividerThin): string {
  return width > 0 ? char.repeat(width) : "";
}

/**
 * 极限压缩正文草稿/分镜为高密度单行 LLM 指令：逐行剥离行首 Markdown 标题标识与引用符，折叠连续空白，各片段以 `TEXTS.markdown.draftSegmentSeparator` 连接
 * @param preview - 原始草稿/分镜文本；缺省或全空白时返回 undefined
 * @returns 单行分镜指令；无有效片段时返回 undefined
 */
export function compressDraftPreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const cleaned = cleanText(preview);
  if (!cleaned.trim()) return undefined;

  const segments = cleaned
    .split("\n")
    .map((line) => {
      let l = line.trim();
      if (!l) return "";
      // 单次交替剥离行首任意层级的 Markdown 标题标识与引用符（`> # 标题` 需同时去除两类前缀，故不可拆成两次行首替换）
      l = l.replace(/^(?:[>#]+\s*)+/, "");
      l = l.replace(/\s+/g, " ");
      return l;
    })
    .filter(Boolean);

  if (segments.length === 0) return undefined;
  return segments.join(TEXTS.markdown.draftSegmentSeparator);
}

/**
 * 折叠不可信文本的换行与连续空白为单空格：LLM 生成的描述/批注含换行会破坏返回封套的行结构
 * @param text - 原始文本
 * @returns 单行文本（所有 `\s+` 折叠为一个空格并去除首尾空白；纯空白输入返回空串）
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 安全获取快捷键提示（本模块唯一宿主耦合点）
 * `keyHint` 会读取宿主全局 `theme` 代理（未 `initTheme()` 时抛错）与全局按键表，故以 try/catch 退化
 * @param id - 命名空间化按键绑定 ID（如 `app.tools.expand`）
 * @param description - 兜底说明文案（取自 `TEXTS`）
 * @returns 宿主格式化后的按键提示（含 ANSI 着色）；宿主不可用时返回 `description`
 */
export function safeKeyHint(id: Parameters<typeof keyHint>[0], description: string): string {
  try {
    return keyHint(id, description);
  } catch {
    return description;
  }
}
