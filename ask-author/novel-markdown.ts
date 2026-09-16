/**
 * @file novel-markdown.ts
 * @description 小说语法高亮引擎：把语义定界符（`「」` / `（）`）标注为携带哨兵的原生行内代码，折行与配色交还 Pi 原生 Markdown 引擎
 *
 * 核心架构特性：
 * - 声明式语法模板表（`NOVEL_TEMPLATE_*` 派生索引）驱动「定界符 → 语义哨兵 → 行内代码载体 → 主题样式」映射
 * - 对话台词「...」与旁白心理（...）由 `MarkdownOptions.transform` 在 marked 解析前完成标注
 * - `theme.code` 回调兼作哨兵分类器，未命中哨兵即完整交还原生行内代码样式
 * - 折行、嵌套与配色全部由原生 Markdown 引擎回填，插件不触碰任何 ANSI 转义流
 * - 零文本改动不变量：输出剥离哨兵与新增反引号后与输入完全等价
 *
 * 索引约定：全文「扁平索引 / 行内列索引」一律指 UTF-16 码元下标，与 `String.prototype.length` / `charAt` / `slice` 对齐，非 Unicode 码点或字节偏移
 *
 * 依赖方向：novel-markdown.ts → format.ts / texts.ts / theme.ts（另取 model.ts 的 `MenuItem` 类型，无回边）；外部依赖 `@earendil-works/pi-tui` 的 `Markdown` / `MarkdownTheme` 与 `@earendil-works/pi-coding-agent` 的 `getMarkdownTheme`
 * 宿主主题耦合：围栏代码块由 `getMarkdownTheme()` 的 `highlightCode` 着色，取色读宿主全局活动主题（须宿主已 `initTheme`，本模块不自持主题）；行内代码仅在未命中哨兵时走同一全局 `code` 取色
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { cleanText } from "./format.js";
import type { MenuItem } from "./model.js";
import {
  NOVEL_MARKER_PREFIX,
  NOVEL_TEMPLATE_BY_MARKER,
  NOVEL_TEMPLATE_BY_OPENER,
  type NovelSyntaxTemplate,
  TEXTS,
} from "./texts.js";
import type { Theme } from "./theme.js";

/**
 * 基于 `getMarkdownTheme()` 定制小说预览主题；`code` 回调兼作哨兵分类器（命中即着色并剥离哨兵，未命中交还原生样式）
 * 覆盖项统一收敛到注入的 TUI 主题前景色族（仅 `code` 未命中哨兵时回退 `getMarkdownTheme()` 的 `mdCode` 取色，即 Pi 运行时全局活动主题）；`codeBlock` 不覆盖——原生 `Markdown` 仅在 `highlightCode` 缺失时才回调它，而 `getMarkdownTheme()` 恒提供 `highlightCode`，覆盖不会生效（代码块走原生语法高亮）；`hr` / `strikethrough` / `underline` / `highlightCode` 取 `getMarkdownTheme()` 的原生实现
 * @param theme - 当前 TUI 主题实例
 * @returns 字段集已由 `getMarkdownTheme()` 展开补齐的完整 `MarkdownTheme`
 */
function createNovelMarkdownTheme(theme: Theme): MarkdownTheme {
  const base = getMarkdownTheme();
  return {
    ...base,
    heading: (text) => theme.fg("accent", theme.bold(text)),
    quote: (text) => theme.fg("muted", text),
    quoteBorder: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    code: (text) => classifyNovelCode(theme, text) ?? base.code(text),
    codeBlockBorder: (text) => theme.fg("dim", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
  };
}

/**
 * 解析行内代码文本中的哨兵序列并按语法模板逐段着色；未命中哨兵返回 undefined 交还原生样式
 * 内容为「`{@link NOVEL_MARKER_PREFIX}` + 哨兵 + 语义原文」的可重复序列，相邻语义片段打包进同一围栏以避免相邻围栏合并歧义
 * @param theme - 当前 TUI 主题实例
 * @param text - `theme.code` 收到的行内代码原文
 * @returns 逐段着色后的文本（哨兵前缀与哨兵字符已剥离）；文本不以哨兵前缀开头，或哨兵序列损坏（缺失哨兵字符 / 中途再现前缀）时返回 `undefined`，由调用方回退原生行内代码样式
 */
function classifyNovelCode(theme: Theme, text: string): string | undefined {
  if (!text.startsWith(NOVEL_MARKER_PREFIX)) return undefined;

  const painted: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.charAt(cursor) !== NOVEL_MARKER_PREFIX) return undefined;
    const template = NOVEL_TEMPLATE_BY_MARKER.get(text.charAt(cursor + 1));
    if (!template) return undefined;
    const next = text.indexOf(NOVEL_MARKER_PREFIX, cursor + 2);
    const end = next < 0 ? text.length : next;
    painted.push(template.paint(theme, text.slice(cursor + 2, end)));
    cursor = end;
  }

  return painted.length > 0 ? painted.join("") : undefined;
}

/** 围栏代码块开启行识别正则（CommonMark：≤3 空格缩进 + 3 个及以上反引号/波浪号） */
const FENCE_OPENING_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** 缩进代码行识别正则（≥4 空格缩进后接非空内容） */
const INDENTED_CODE_PATTERN = /^ {4,}\S/;

/** 原生引擎按原文输出的块级起始行识别正则（HTML 块与表格行），命中即整块放弃标注；`<` 收紧为 CommonMark 合法标签起始以避免正文行误判；裸 `$` 与 `\[` 由数学区掩码接管（见 {@link maskCodeRegions}） */
const RAW_BLOCK_PATTERN = /^ {0,3}(?:<(?=[/!?a-zA-Z])|\|)/;

/** 块级数学区开启行（行首 `$$` 或 `\[…`），与原生 `tokenizeBlockLatex` 的 `start` 接受范围一致 */
const BLOCK_MATH_OPENING_PATTERN = /^ {0,3}(?:\$\$|\\\[)/;

/**
 * 判定行内是否存在行内数学起始定界符（`$x$` / `$$…` / `\(…` / `\[…`）
 * 原生 `tokenizeInlineLatex` 区段经 `renderLatex` 按原文渲染、绕过 `theme.code` 回调，哨兵落入即泄漏到终端，故一律放弃标注
 * `\$` 转义与 `$` 后紧跟空白（原生按字面量处理）不触发
 * @param line - 待判定行
 * @returns 命中未闭合数学起始符（`$$` 或 `\[`）时为 true
 */
function containsMathOpener(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (char === "\\") {
      if (line.charAt(index + 1) === "(" || line.charAt(index + 1) === "[") return true;
      index++; // 跳过转义对，`\$` 为字面量美元符
      continue;
    }
    if (char !== "$") continue;
    const next = line.charAt(index + 1);
    if (next === "" || /\s/.test(next)) continue;
    return true;
  }
  return false;
}

/** 块引用前缀识别正则（兼容 `> ` 与嵌套 `> > ` 写法） */
const QUOTE_PREFIX_PATTERN = /^(?: {0,3}>[ \t]?)+/;

/** 链接定义行识别正则（`def` 令牌不带 `text` 字段，原生 `renderToken` 的 default 分支不会输出该行；哨兵落入即随令牌一并丢失，故整行屏蔽） */
const LINK_DEFINITION_PATTERN = /^ {0,3}\[[^\]\n]*\]:/;

/**
 * 剥离行首块引用前缀（兼容 `> ` 嵌套）
 * @param line - 待处理行
 * @returns 剥离后的行文本；无引用前缀时原样返回
 */
function stripQuotePrefix(line: string): string {
  return line.replace(QUOTE_PREFIX_PATTERN, "");
}

/**
 * 判定是否为 GFM 表格分隔行（兼容引用块内表格）
 * @param line - 待判定行
 * @returns 含至少一个管道符与短横线单元格时为 true
 */
function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(stripQuotePrefix(line));
}

/** 块级结构行识别正则（标题、列表、引用、表格、围栏），语义跨距跨越即放弃高亮 */
const BLOCK_STRUCTURE_PATTERN = /^ {0,3}(?:#{1,6}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]|>|\||`{3,}|~{3,})/;

/**
 * Markdown 行内标记敏感字符模式（强调、链接、原始 HTML、公式、转义、删除线、表格管道符、实体引用）
 * 行内代码内容按字面量呈现，语义跨距一旦含这些字符，标注就会吞掉作者书写的标记并改变可见文本，
 * 故此类跨距一律放弃标注——「零文本改动」优先于「覆盖率」
 */
const MARKDOWN_SENSITIVE_PATTERN = /[`*_\[\]<>$\\|]|~~|&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/;

/** 行索引 → 行首扁平索引的映射表（源码行首索引严格递增；下标单位见文件头「索引约定」） */
type LineStartIndex = readonly number[];

/** 代码上下文掩码：长度等于 `source.length`（UTF-16 码元数，逐码元 1:1 对应），`1` 表示该码元处于代码块、行内代码或原生引擎按原文渲染的块级上下文中 */
type NovelCodeMask = Uint8Array;

/** 待闭合的语义栈帧 */
interface NovelOpenFrame {
  /** 命中的语法模板 */
  readonly template: NovelSyntaxTemplate;
  /** 开始定界符的扁平字符索引 */
  readonly start: number;
}

/** 已配对且通过约束校验的语义跨距（源码行坐标，左闭右开） */
interface NovelSyntaxSpan {
  /** 命中的语法模板 */
  readonly template: NovelSyntaxTemplate;
  /** 起始定界符的扁平字符索引（用于嵌套包含性判定） */
  readonly startFlat: number;
  /** 起始行索引（0-based） */
  readonly startLine: number;
  /** 起始列索引（0-based，含） */
  readonly startCol: number;
  /** 结束行索引（0-based，含） */
  readonly endLine: number;
  /** 结束列索引（0-based，不含） */
  readonly endCol: number;
}

/** 单行局部的待标注片段（行内列坐标，左闭右开） */
interface NovelLineSegment {
  /** 起始列索引（含） */
  readonly start: number;
  /** 结束列索引（不含） */
  readonly end: number;
  /** 命中的语法模板 */
  readonly template: NovelSyntaxTemplate;
}

/**
 * 计算源码各行行首的扁平索引表（相邻行首差值恒为「本行长度 + 1」，故严格递增）
 * @param lines - 源码行数组（行间以单个 `\n` 连接，元素不含行尾换行符）
 * @returns 行索引 → 行首扁平索引（UTF-16 码元下标）的只读数组，长度与 `lines` 相同；仅含行首项，末行之后的位置由 {@link resolveLineIndex} 收敛至末行
 */
function indexLineStarts(lines: readonly string[]): LineStartIndex {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * 计算源码的「代码上下文」掩码：围栏代码块整行、缩进代码行、行内代码片段，以及会被原生引擎按原文输出的块级上下文（表格 / HTML / LaTeX / 链接定义行）
 * 分词与标注一律跳过被标记字符：既不会改动作者书写的代码，也杜绝哨兵落入不经主题回调的渲染路径（代价是表格内放弃着色）
 * @param source - 完整源码（行间以 `\n` 连接）
 * @param lines - 源码行数组
 * @param lineStarts - 行首扁平索引表
 * @returns 与源码等长的掩码；含未配对反引号时为 `null`
 */
function maskCodeRegions(source: string, lines: readonly string[], lineStarts: LineStartIndex): NovelCodeMask | null {
  const mask = new Uint8Array(source.length);
  /** 将扁平索引区间 `[from, to)` 整段标记为代码上下文（越界区间自动退化） */
  const markRange = (from: number, to: number): void => {
    for (let index = from; index < to; index++) mask[index] = 1;
  };
  /** 将整行（不含行尾换行符）标记为代码上下文（越界按空行处理） */
  const markLine = (lineIndex: number): void => {
    const lineStart = lineStarts[lineIndex] ?? 0;
    markRange(lineStart, lineStart + (lines[lineIndex]?.length ?? 0));
  };

  // 1. 行级代码与原文渲染上下文
  let fenceCloser: RegExp | null = null;
  let rawBlock = false;
  // 块级数学区（`$$…$$` / `\[…\]`）可跨空行，且未闭合时按 pending 语义吞并余下全部源码
  // （原生 `pendingBracket` 无条件吞并，`pendingDollar` 另需 `looksLikePendingDollarMath` 启发式；本掩码取更宽的保守范围，宁可放弃着色），故独立于「空行即终止」的 rawBlock 状态机
  let mathCloser: string | null = null;
  let mathContent = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";

    // 空行终止 HTML / 表格等块级上下文；围栏与未闭合的块级数学区不受空行影响
    if (line.trim() === "") {
      rawBlock = false;
      if (fenceCloser !== null) markLine(lineIndex);
      if (mathCloser !== null) markLine(lineIndex);
      continue;
    }

    if (mathCloser !== null) {
      mathContent += line;
      markLine(lineIndex);
      const closerIndex = line.indexOf(mathCloser);
      if (closerIndex >= 0) {
        const remainder = line.slice(closerIndex + mathCloser.length);
        mathCloser = null;
        // 闭合后同行余段若仍含数学起始符，后续段落继续按原文渲染，保持段落级屏蔽
        if (containsMathOpener(remainder)) rawBlock = true;
      }
      continue;
    }

    if (fenceCloser !== null) {
      markLine(lineIndex);
      if (fenceCloser.test(line)) fenceCloser = null;
      continue;
    }

    if (rawBlock) {
      markLine(lineIndex);
      continue;
    }

    // 表格：分隔行命中时连同紧邻表头行一起屏蔽，后续行由 rawBlock 阻断
    if (isTableSeparator(line)) {
      markLine(lineIndex);
      rawBlock = true;
      const previous = lines[lineIndex - 1];
      if (previous !== undefined && previous.includes("|")) markLine(lineIndex - 1);
      continue;
    }

    const opening = FENCE_OPENING_PATTERN.exec(line);
    const run = opening?.[1];
    const infoString = line.slice(opening?.[0].length ?? 0);
    // 反引号围栏的信息串中不得再出现反引号（CommonMark 约束），否则按普通行内内容处理
    if (run !== undefined && (run[0] === "~" || !infoString.includes("`"))) {
      markLine(lineIndex);
      const char = run[0] ?? "`";
      fenceCloser = new RegExp(`^ {0,3}${char}{${run.length},}[ \\t]*$`);
      continue;
    }

    if (INDENTED_CODE_PATTERN.test(line)) {
      markLine(lineIndex);
      continue;
    }

    if (RAW_BLOCK_PATTERN.test(stripQuotePrefix(line))) {
      markLine(lineIndex);
      rawBlock = true;
      continue;
    }

    // 链接定义行是单行块级结构，仅屏蔽该行本身，不开启跨行 rawBlock
    if (LINK_DEFINITION_PATTERN.test(line)) {
      markLine(lineIndex);
      continue;
    }

    // 块级数学区：行首 `$$` / `\[…` 开启至闭合定界符所在行，未闭合时按 pending 语义跨空行吞并至源码末尾
    if (BLOCK_MATH_OPENING_PATTERN.test(line)) {
      const rest = line.replace(BLOCK_MATH_OPENING_PATTERN, "");
      mathContent = rest;
      markLine(lineIndex);
      if (!rest.includes(rest.startsWith("$$") ? "$$" : "\\]")) {
        mathCloser = rest.startsWith("$$") ? "$$" : "\\]";
      }
      continue;
    }

    // 行内数学（`$x$` / `\(…\)` / 行中 `$$` / `\[…`）：起始符所在段落整体放弃标注，避免哨兵落入不经主题回调的 `renderLatex` 渲染路径
    if (containsMathOpener(line)) {
      markLine(lineIndex);
      rawBlock = true;
    }
  }

  // 2. 行内代码片段：等长反引号串配对，跨行的片段内容整体标记
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "`" || mask[cursor] === 1) {
      cursor++;
      continue;
    }
    let runLength = 0;
    while (source[cursor + runLength] === "`" && mask[cursor + runLength] === 0) runLength++;
    const closing = findInlineCodeClosing(source, mask, cursor + runLength, runLength);
    // 未配对反引号会让原生解析结果不可预测，此时放弃全部语义标注
    if (closing < 0) return null;
    markRange(cursor, closing + runLength);
    cursor = closing + runLength;
  }

  return mask;
}

/**
 * 查找与开启反引号串等长的行内代码闭合串（CommonMark：闭合串后不得紧跟反引号）
 * @param source - 完整源码
 * @param mask - 代码上下文掩码
 * @param from - 检索起始扁平索引
 * @param runLength - 开启串长度
 * @returns 闭合串起始索引；未找到为 `-1`（按字面量处理）
 */
function findInlineCodeClosing(source: string, mask: NovelCodeMask, from: number, runLength: number): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] !== "`" || mask[index] === 1) continue;
    let run = 0;
    while (source[index + run] === "`" && mask[index + run] === 0) run++;
    if (run === runLength && source[index + runLength] !== "`") return index;
    index += run - 1;
  }
  return -1;
}

/**
 * 对源码执行小说语法定界符栈式配对
 * 逐字符线性扫描并跳过掩码命中字符；闭合帧时按 `startFlat >= frame.start` 回退剔除其内层已入列跨距（等价于「外层优先」的区间包含语义，且跨距互不重叠）
 * 超长 / 跨空行或块级结构行 / 内容含行内标记字符（详见 {@link MARKDOWN_SENSITIVE_PATTERN}）的跨距一律放弃高亮
 * @param source - 完整源码
 * @param mask - 代码上下文掩码
 * @param lines - 源码行数组
 * @param lineStarts - 行首扁平索引表
 * @returns 通过约束校验的语义跨距列表（按闭合顺序，起始位置单调递增）
 */
function pairNovelSyntax(
  source: string,
  mask: NovelCodeMask,
  lines: readonly string[],
  lineStarts: LineStartIndex,
): NovelSyntaxSpan[] {
  const stack: NovelOpenFrame[] = [];
  const spans: NovelSyntaxSpan[] = [];

  for (let index = 0; index < source.length; index++) {
    if (mask[index] === 1) continue;
    const char = source[index] ?? "";

    const template = NOVEL_TEMPLATE_BY_OPENER.get(char);
    if (template !== undefined) {
      stack.push({ template, start: index });
      continue;
    }

    const depth = findClosingDepth(stack, char);
    if (depth < 0) continue;

    const frame = stack[depth];
    stack.length = depth; // 丢弃更深层未闭合帧，保证回填互不重叠
    if (!frame) continue;

    const end = index + 1;
    if (end - frame.start > frame.template.maxSpanLength) continue;
    // 含行内标记字符时放弃该跨距（详见 {@link MARKDOWN_SENSITIVE_PATTERN}）
    if (MARKDOWN_SENSITIVE_PATTERN.test(source.slice(frame.start, end))) continue;

    const startLine = resolveLineIndex(lineStarts, frame.start);
    const endLine = resolveLineIndex(lineStarts, end - 1);
    if (!isSpanWithinParagraph(lines, startLine, endLine)) continue;

    // 外层跨距成立时剔除其完整包含的内层跨距（外层优先）
    let inner = spans[spans.length - 1];
    while (inner !== undefined && inner.startFlat >= frame.start) {
      spans.pop();
      inner = spans[spans.length - 1];
    }

    spans.push({
      template: frame.template,
      startFlat: frame.start,
      startLine,
      startCol: frame.start - (lineStarts[startLine] ?? 0),
      endLine,
      endCol: end - (lineStarts[endLine] ?? 0),
    });
  }

  return spans;
}

/**
 * 在语义栈中自顶向下查找可被指定闭定界符闭合的栈帧深度
 * @param stack - 未闭合开定界符栈（自底向上）
 * @param closer - 待匹配的闭定界符
 * @returns 栈帧深度（0-based）；无匹配帧返回 `-1`
 */
function findClosingDepth(stack: readonly NovelOpenFrame[], closer: string): number {
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (stack[depth]?.template.closer === closer) return depth;
  }
  return -1;
}

/**
 * 二分查找扁平索引所在行索引（行首索引表严格递增）
 * @param lineStarts - 行首扁平索引表
 * @param flatIndex - 目标扁平索引（可越过末行行首，此时收敛至末行）
 * @returns 满足 `lineStarts[i] <= flatIndex` 的最大行索引；空表返回 0
 */
function resolveLineIndex(lineStarts: LineStartIndex, flatIndex: number): number {
  let low = 0;
  let high = Math.max(0, lineStarts.length - 1);
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= flatIndex) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * 判定语义跨距是否完全落在同一段落内（内部无空行且无块级结构行）
 * @param lines - 源码行数组
 * @param startLine - 起始行索引（0-based）
 * @param endLine - 结束行索引（0-based，含）
 * @returns 单行跨距恒为 true；多行跨距仅校验 `(startLine, endLine]` 区间的空行与 {@link BLOCK_STRUCTURE_PATTERN} 块级结构行（起始行不参与校验：其块级结构在原生引擎中仍按行内内容解析，标注不破坏结构）
 */
function isSpanWithinParagraph(lines: readonly string[], startLine: number, endLine: number): boolean {
  if (startLine === endLine) return true;
  for (let lineIndex = startLine + 1; lineIndex <= endLine; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    if (line.trim() === "" || BLOCK_STRUCTURE_PATTERN.test(line)) return false;
  }
  return true;
}

/**
 * 把一组首尾相接的语义片段包装为单个携带哨兵序列的原生行内代码（固定单反引号围栏；相邻片段合并，避免围栏合并破坏配对）
 * @param line - 该行原始文本
 * @param group - 首尾相接的语义片段组（按位置升序，左闭右开且互不重叠）
 * @returns 单反引号围栏包裹的片段序列（每段为「哨兵前缀 + 哨兵字符 + 语义原文」，逐字透传、不插入任何空白）
 */
function wrapNovelCode(line: string, group: readonly NovelLineSegment[]): string {
  const runs: string[] = [];
  for (const segment of group) {
    runs.push(`${NOVEL_MARKER_PREFIX}${segment.template.marker}${line.slice(segment.start, segment.end)}`);
  }
  return `\`${runs.join("")}\``;
}

/**
 * 在单行内插入语义标注，未命中区间原样透传（片段紧邻反引号时放弃该片段标注）
 * @param line - 该行原始文本
 * @param segments - 该行局部待标注片段（按位置升序、互不重叠）
 * @returns 标注后的行文本
 */
function annotateNovelLine(line: string, segments: readonly NovelLineSegment[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < segments.length) {
    // 非空收窄：外层 `while` 条件已保证 `index` 在界内，`head` 仅可能因越界读取而为 undefined
    const head = segments[index];
    if (!head) break;
    const group: NovelLineSegment[] = [head];
    // 合并首尾相接的片段为单个行内代码，避免相邻围栏合并
    let tail = head;
    while (index + 1 < segments.length) {
      const next = segments[index + 1];
      if (!next || next.start !== tail.end) break;
      index++;
      tail = next;
      group.push(next);
    }

    const start = head.start;
    const end = tail.end;
    const leading = line.slice(cursor, start);
    const body = line.slice(start, end);
    // 防御性兜底：片段紧邻反引号时插入围栏会与之合并而破坏配对；正常情况下掩码层已排除此情形，
    // 此分支仅在掩码与原生解析存在边界偏差时生效——宁可不标注也不改文本
    const touchingBacktick = line.charAt(start - 1) === "`" || line.charAt(end) === "`";

    chunks.push(leading, touchingBacktick ? body : wrapNovelCode(line, group));
    cursor = end;
    index++;
  }

  chunks.push(line.slice(cursor));
  return chunks.join("");
}

/**
 * 判定扁平区间内是否存在代码上下文字符
 * @param mask - 代码上下文掩码（长度等于源码 UTF-16 码元数）
 * @param from - 区间起点（含，扁平索引）
 * @param to - 区间终点（不含，扁平索引）
 * @returns 区间内存在掩码为 `1` 的码元时为 true；空区间恒为 false
 */
function hasCodeCharacter(mask: NovelCodeMask, from: number, to: number): boolean {
  for (let index = from; index < to; index++) {
    if (mask[index] === 1) return true;
  }
  return false;
}

/**
 * 把已配对的语义跨距逐行标注为携带哨兵的原生行内代码并重组源码
 * 跨行跨距按源码行拆分标注，换行语义、块级结构与折行行为保持原样，并天然获得原生引擎对折行片段的样式续色
 * 与代码上下文重叠的行片段一律放弃标注（行内代码无法嵌套），作者书写的反引号仍由原生引擎呈现
 * @param lines - 源码行数组
 * @param lineStarts - 行首扁平索引表
 * @param mask - 代码上下文掩码
 * @param spans - 通过约束校验的语义跨距列表
 * @returns 重新以 `\n` 连接的行文本；无片段行原样返回，已标注行仅在语义片段两侧插入哨兵与原生化反引号
 */
function annotateNovelSource(
  lines: readonly string[],
  lineStarts: LineStartIndex,
  mask: NovelCodeMask,
  spans: readonly NovelSyntaxSpan[],
): string {
  const buckets = new Map<number, NovelLineSegment[]>();

  for (const span of spans) {
    const spanStart = (lineStarts[span.startLine] ?? 0) + span.startCol;
    const spanEnd = (lineStarts[span.endLine] ?? 0) + span.endCol;
    for (let lineIndex = span.startLine; lineIndex <= span.endLine; lineIndex++) {
      const lineStart = lineStarts[lineIndex] ?? 0;
      const lineEnd = lineStart + (lines[lineIndex]?.length ?? 0);
      const from = Math.max(spanStart, lineStart);
      const to = Math.min(spanEnd, lineEnd);
      if (to <= from) continue;
      if (hasCodeCharacter(mask, from, to)) continue;
      const segment: NovelLineSegment = { start: from - lineStart, end: to - lineStart, template: span.template };
      const bucket = buckets.get(lineIndex);
      if (bucket) bucket.push(segment);
      else buckets.set(lineIndex, [segment]);
    }
  }

  return lines
    .map((line, lineIndex) => {
      const bucket = buckets.get(lineIndex);
      if (!bucket) return line;
      bucket.sort((a, b) => a.start - b.start);
      return annotateNovelLine(line, bucket);
    })
    .join("\n");
}

/**
 * 小说语法原生化 transform：把源码中的语义跨距标注为携带哨兵的原生行内代码
 * 作为 `MarkdownOptions.transform` 传入原生 `Markdown` 组件，在 marked 解析前执行「代码上下文掩码 → 定界符栈式配对 → 逐行行内标注」三步扫描，折行、缩进与配色由原生引擎回填
 *
 * 复杂度：掩码与标注均摊 O(n)（n 为源码 UTF-16 码元数，区间标记与分行切片的扫描区间互不重叠）；
 * 配对扫描为 O(n·d)，d 为同时未闭合的开定界符栈深——闭定界符查找 {@link findClosingDepth} 对每个非开定界符码元自顶向下遍历整个栈，
 * 故「大量未闭合 `「` / `（` 之后接续正文」的最坏情形退化为平方级，正常成对文本仍为线性
 *
 * 不变量：输出源码剥离哨兵与新增反引号后与输入完全等价，且不改变换行与块级结构语义；为此含未配对反引号时整体放弃标注，
 * 语义跨距含行内标记字符时放弃该跨距（详见 {@link MARKDOWN_SENSITIVE_PATTERN}）
 *
 * @param source - 面板组装的原始 Markdown 源码
 * @returns 标注了语义哨兵的原生 Markdown 源码
 */
function markNovelSyntax(source: string): string {
  if (source.length === 0) return source;
  const lines = source.split("\n");
  const lineStarts = indexLineStarts(lines);
  const mask = maskCodeRegions(source, lines, lineStarts);
  if (mask === null) return source;
  const spans = pairNovelSyntax(source, mask, lines, lineStarts);
  if (spans.length === 0) return source;
  return annotateNovelSource(lines, lineStarts, mask, spans);
}

/**
 * 把面板标题与提示行序列组装为单个 Markdown 区块
 * 固定为「{@link TEXTS.view.sectionTitle} 三级标题行 + 空行 + 每条提示独占一行」，每行（含最后一条）保留行尾换行，便于以 `\n` 续接后续区块；`tips` 为空时退化为仅含标题与空行
 * @param title - 面板标题文案
 * @param tips - 面板提示行文案序列，按数组顺序逐行输出
 * @returns 组装后的 Markdown 区块字符串
 */
function buildTipsSection(title: string, tips: readonly string[]): string {
  return `${TEXTS.view.sectionTitle(title)}\n\n${tips.map((tip) => `${tip}\n`).join("")}`;
}

/**
 * 构建选项详情/正文草稿预览框的完整未切片内容行列表（原生 Markdown 渲染 + 小说语法语义标注）
 * @param item - 当前选中的菜单项
 * @param customText - 当前填写的题目自由补充说明
 * @param optionNote - 当前选项填写的专属补充说明
 * @param targetWidth - 预览框渲染总列宽 (cols)，含 `Markdown` 组件自身左右各 1 列 `paddingX`（正文可用宽度为其减 2）
 * @param theme - TUI 主题实例
 * @returns 未切片的完整内容行（每行已补足至 `targetWidth`），供组件层做视口切片；`item` 缺省时返回空数组
 */
export function buildFullPreviewContentLines(
  item: MenuItem | undefined,
  customText: string | undefined,
  optionNote: string | undefined,
  targetWidth: number,
  theme: Theme,
): string[] {
  if (!item) return [];

  let mdSource = "";

  if (item.type === "option") {
    // 1. 选项专属作者补充说明（若已填写）
    if (optionNote) {
      mdSource += `${TEXTS.view.sectionTitle(TEXTS.view.optionNotePanelTitle)}\n\n${TEXTS.view.fieldLabel(TEXTS.view.customNotePanelCurrent)}\n\n${cleanText(optionNote)}\n\n`;
    }

    // 2. 情节设定推演说明
    if (item.description) {
      mdSource += `${TEXTS.view.sectionTitle(TEXTS.view.storyDescriptionPanelTitle)}\n\n${cleanText(item.description)}\n\n`;
    }

    // 3. 正文草稿/分镜预览
    if (item.preview) {
      mdSource += `${TEXTS.view.sectionTitle(TEXTS.view.storyDraftPanelTitle)}\n\n${cleanText(item.preview)}\n\n`;
    } else if (!item.description && !optionNote) {
      mdSource += `${TEXTS.view.italicLine(TEXTS.view.previewNoDraft.trim())}\n\n`;
    }
  } else if (item.type === "custom_note") {
    mdSource += buildTipsSection(TEXTS.view.customNotePanelTitle, TEXTS.view.customNotePanelTips);
    if (customText) {
      mdSource += `\n${TEXTS.view.fieldLabel(TEXTS.view.customNotePanelCurrent)}\n\n${cleanText(customText)}\n\n`;
    }
  } else {
    mdSource += buildTipsSection(TEXTS.view.confirmPanelTitle, TEXTS.view.confirmPanelTips);
  }

  const mdTheme = createNovelMarkdownTheme(theme);
  // paddingX = 1 提供终端边距；transform 在原生解析前完成语义标注，折行与配色由 Pi Markdown 引擎回填
  const md = new Markdown(mdSource.trim(), 1, 0, mdTheme, undefined, { transform: markNovelSyntax });

  return md.render(targetWidth);
}
