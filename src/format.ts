/**
 * @file format.ts
 * @description 纯函数工具层：视口计算、文本折行、ANSI 宽度测量与文本规整
 *
 * 无副作用，不装载语言资源；终端宽度一律经 `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi` 计算
 */

import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { LAYOUT_CONFIG } from "./layout.js";

/**
 * 将数值收敛至闭区间 `[min, max]`
 * @param value - 待收敛数值
 * @param min - 区间下界
 * @param max - 区间上界
 * @returns `[min, max]` 内的数值；`min > max` 时恒返回 `min`
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 将视口位移收敛至合法区间，防止越界滚动造成空白视口
 * @param offset - 0-based 起始行位移
 * @param total - 内容总行数
 * @param viewHeight - 可视行数
 * @returns `[0, max(0, total - viewHeight)]` 内的位移；内容不足一屏时恒为 0
 */
export function clampWindowOffset(offset: number, total: number, viewHeight: number): number {
  return clamp(offset, 0, Math.max(0, total - viewHeight));
}

/**
 * 截取视口可视行切片（不遍历非可视区数据）
 * @param lines - 完整内容行数组（不修改入参）
 * @param offset - 0-based 起始行位移（须先经 {@link clampWindowOffset} 收敛；负值从尾部开始切片）
 * @param viewHeight - 可视行数
 * @returns 至多 `viewHeight` 行的新数组；`viewHeight <= 0` 或 `offset` 越过末行时为空数组
 */
export function windowSlice<T>(lines: readonly T[], offset: number, viewHeight: number): T[] {
  return lines.slice(offset, offset + viewHeight);
}

/**
 * 清除回车符并把制表符规整为双空格（不剥离 ANSI 控制序列）
 * @param str - 原始文本；缺省时按空串处理
 * @returns 规整后的文本，永不返回 undefined
 */
export function cleanText(str: string | undefined): string {
  return str ? str.replace(/\t/g, "  ").replace(/\r/g, "") : "";
}

/**
 * 剥离终端转义与控制字符，防止 ANSI 注入污染 TUI 渲染
 * @param str - 原始文本
 * @returns 剥离全部转义序列与残余 C0 控制字符（含 DEL `\x7f`）的字符串；换行符保留
 */
function stripControlSequences(str: string): string {
  return stripTerminalSequences(str).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * 裁剪空白并剥离终端控制序列；结果为空时返回 undefined
 * 仅用于不可信输入边界（工具参数、编辑器文本），渲染路径用 `cleanText` / `safeLine`
 * @param str - 原始不可信文本
 * @returns 清洗后的非空字符串，或 undefined
 */
export function cleanOptional(str: string | undefined): string | undefined {
  const t = str?.trim();
  return t ? stripControlSequences(cleanText(t)) || undefined : undefined;
}

/**
 * 尝试 `JSON.parse`；非字符串原样返回，解析失败返回 undefined
 * @param value - 待解析值
 * @returns 解析结果或原值；字符串长度超过 1_000_000 码元时返回 undefined
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
 * 悬挂缩进折行：首行携带前缀，后续折行左缘与前缀可见宽度一致
 * @param prefix - 首行前缀（超宽时截断至 `width - 1`）
 * @param text - 待折行文本
 * @param width - 可视总宽度（列），调用方必须传入 `>= 1`
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
 * 将悬挂折行结果追加至目标行数组
 * @param lines - 目标行数组（原地追加）
 * @param text - 待追加文本
 * @param width - 可视总宽度
 * @param prefix - 首行前缀
 */
export function pushWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  lines.push(...hangText(prefix, text, width));
}

/**
 * 单行安全截断，保证可见宽度不超过 `maxWidth`（超宽部分以 `truncateToWidth` 的默认省略号收尾）
 * @param str - 原始文本（先经 `cleanText` 规整）
 * @param maxWidth - 最大可见宽度（列）；`<= 0` 时返回空串
 * @returns 可见宽度不超过 `maxWidth` 的单行文本（未超宽时原样返回）
 */
export function safeLine(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  return truncateToWidth(cleanText(str), maxWidth);
}

/**
 * 按可见宽度右补空格至指定宽度
 * @param str - 原始文本（先经 `cleanText` 规整）
 * @param targetWidth - 目标可见宽度（列）；`<= 0` 时返回空串
 * @returns 不足则补齐，超宽则截断并以默认省略号收尾
 */
export function padToVisibleWidth(str: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  return truncateToWidth(cleanText(str), targetWidth, "...", true);
}

/**
 * 生成指定宽度的横向分隔线
 * @param width - 目标可见宽度（列）
 * @param char - 填充字符（按 1 列宽计）
 * @returns `width <= 0` 时为空串
 */
export function divider(width: number, char: string = LAYOUT_CONFIG.dividerThin): string {
  return width > 0 ? char.repeat(width) : "";
}

/**
 * 中文输入法全角状态下送出的标点没有对应的 `Key` 常量，这里映射为等价的半角字符
 * 全角 ASCII 区（U+FF01~U+FF5E）与半角的码位差为 0xFEE0
 */
const IME_KEY_ALIASES: Record<string, string> = { "\u3000": " ", "【": "[", "】": "]" };

/**
 * 把输入法全角字符收敛为半角，使快捷键在中文输入法开启时仍然命中
 * @param data - 终端按键序列
 * @returns 单个全角字符被替换后的序列；长度非 1 的序列原样返回
 */
export function normalizeImeKey(data: string): string {
  if (data.length !== 1) return data;
  const alias = IME_KEY_ALIASES[data];
  if (alias !== undefined) return alias;
  const code = data.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return data;
}

/**
 * 把不可信文本的换行与连续空白折叠为单空格：换行会破坏返回封套的行结构
 * @param text - 原始文本
 * @returns 单行文本（去首尾空白，纯空白输入为空串）
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
