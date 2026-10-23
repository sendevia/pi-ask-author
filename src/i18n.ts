/**
 * @file i18n.ts
 * @description 语言资源注册、系统语言探测与模板字典编译的完整实现
 *
 * 资源约定：
 * - 语言文件位于仓库根 `lang/`，文件名即 locale 标识，新增语言只需在 {@link LOCALE_PACKAGES} 追加一项导入
 * - 纯字符串即原样文案；字符串数组即文案列表；`{ "template": "…", "params": ["a", "b"] }` 为带插值的模板对象，声明形参时编译为定参函数，省略 `params` 时在装载期求值为常量文案
 * - 模板占位符 `{name}` 取 `params` 同名形参，`{icon.<键>}` 取调用方传入的共享常量解析器结果
 * - `en_US` 为规范语言：键集合、参数个数与取值种类以它为准；其余语言缺失的键回退 `en_US`，结构与规范语言不符时立即抛出异常
 *
 * 语言探测：按 GNU gettext 优先级读取 `LANGUAGE`（冒号分隔的候选列表）→ `LC_ALL` → `LC_MESSAGES` → `LANG`，再以 `Intl` 解析出的系统语言兜底；候选值先精确匹配 locale，再按主语言匹配同族语言，全部落空时回退规范语言
 *
 * 依赖方向：i18n.ts 仅导入 `lang/` 下的语言文件，不导入项目内任何模块；由 `texts.ts` 装载并组装为全局文案字典
 */

import enUS from "../lang/en_US.json" with { type: "json" };
import jaJP from "../lang/ja_JP.json" with { type: "json" };
import koKR from "../lang/ko_KR.json" with { type: "json" };
import zhCN from "../lang/zh_CN.json" with { type: "json" };

/** 带插值的模板声明（`params` 为规范语言声明的形参名，决定编译后函数的形参个数） */
export interface TemplateSpec {
  /** 模板原文，占位符写作 `{形参名}` 或 `{icon.<ICONS 键>}` */
  readonly template: string;
  /** 形参名列表（省略表示无形参） */
  readonly params?: readonly string[];
}

/** 语言资源树节点：文案、文案列表、模板声明或嵌套分组 */
export type TreeNode = string | readonly string[] | TemplateSpec | { readonly [key: string]: TreeNode };

/** 编译结果类型：声明形参的模板转为定参函数，无形参模板折叠为常量文案，数组转为只读列表，分组递归展开 */
export type CompiledTree<T> = T extends { readonly template: string; readonly params: readonly string[] }
  ? (...args: Array<string | number>) => string
  : T extends { readonly template: string }
    ? string
    : T extends string
      ? string
      : T extends readonly string[]
        ? readonly string[]
        : T extends object
          ? { readonly [key in keyof T]: CompiledTree<T[key]> }
          : never;

/** 可用语言包注册表（文件名即键；新增语言在此追加一项导入） */
const LOCALE_PACKAGES: Readonly<Record<string, TreeNode>> = { en_US: enUS, ja_JP: jaJP, ko_KR: koKR, zh_CN: zhCN };

/** 规范语言：键集合、形参个数与缺失键回退值的来源 */
const CANONICAL_LOCALE = "en_US";

/** 语言环境变量读取顺序（GNU gettext 中 `LANGUAGE` 优先级最高，其后按 POSIX 层级递降） */
const LOCALE_ENV_NAMES = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** 占位符常量解析器：返回 undefined 表示该名字交给形参处理 */
export type ResolveTemplateConstant = (name: string) => string | undefined;

/**
 * 归一化 locale 写法：剥离字符集与修饰符（`zh_CN.UTF-8` → `zh_CN`），统一分隔符与大小写
 * @param raw - 环境变量或 `Intl` 给出的原始 locale
 * @returns 主语言小写、地区大写的 locale；`C` / `POSIX` / 空值返回 undefined
 */
function normalizeLocale(raw: string): string | undefined {
  const head = raw.trim().split(/[.@]/)[0] ?? "";
  if (!head || /^(c|posix)$/i.test(head)) return undefined;
  const parts = head.replace(/-/g, "_").split("_");
  const language = parts[0];
  if (!language) return undefined;
  const region = parts[1];
  return region ? `${language.toLowerCase()}_${region.toUpperCase()}` : language.toLowerCase();
}

/**
 * 依据系统语言环境选择界面语言
 * @param environment - 环境变量表（生产传入 `process.env`，测试可传入任意白名单对象）
 * @param systemLocale - `Intl` 解析出的系统 locale（可选，作为最后一位候选）
 * @returns 注册表中命中的 locale 键；无任何命中时为 {@link CANONICAL_LOCALE}
 */
export function detectLocale(environment: Record<string, string | undefined>, systemLocale?: string): string {
  const candidates: string[] = [];
  for (const name of LOCALE_ENV_NAMES) {
    const value = environment[name];
    if (!value) continue;
    if (name === "LANGUAGE") candidates.push(...value.split(":"));
    else candidates.push(value);
  }
  if (systemLocale) candidates.push(systemLocale);

  const available = Object.keys(LOCALE_PACKAGES);
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (!normalized) continue;
    const exact = available.find((locale) => locale.toLowerCase() === normalized);
    if (exact) return exact;
    const language = normalized.split("_")[0];
    const family = available.find((locale) => locale.toLowerCase().split("_")[0] === language);
    if (family) return family;
  }
  return CANONICAL_LOCALE;
}

/** 本次进程解析出的界面语言键 */
export const ACTIVE_LOCALE = detectLocale(process.env, Intl.DateTimeFormat().resolvedOptions().locale);

/** 判定模板对象 */
function isTemplate(value: TreeNode | undefined): value is TemplateSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly template?: unknown }).template === "string"
  );
}

/** 节点种类：纯文案 / 模板声明 / 文案列表 / 嵌套分组 */
type NodeKind = "text" | "template" | "list" | "group";

/** 判定节点种类（规范语言与当前语言的种类必须一致） */
function kindOf(value: TreeNode): NodeKind {
  if (typeof value === "string") return "text";
  if (isTemplate(value)) return "template";
  return Array.isArray(value) ? "list" : "group";
}

/** 模板片段：字符串为字面量，数值为形参下标 */
type TemplateSegment = string | number;

/**
 * 编译单个模板为定参函数
 * @param spec - 生效的模板声明（参数名以规范语言声明为准，故从 `params` 单独传入）
 * @param params - 规范语言声明的形参名列表
 * @param resolveConstant - 占位符常量解析器（`{icon.x}` 等）
 * @returns 形参个数与 `params` 一致的渲染函数；占位符未声明时在装载期抛出，实参个数不符时在调用期抛出
 */
function compileTemplate(
  spec: TemplateSpec,
  params: readonly string[],
  resolveConstant: ResolveTemplateConstant,
): (...args: Array<string | number>) => string {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const match of spec.template.matchAll(/\{([^{}]+)\}/g)) {
    const start = match.index;
    const name = (match[1] ?? "").trim();
    segments.push(spec.template.slice(cursor, start));
    const paramIndex = params.indexOf(name);
    if (paramIndex >= 0) {
      segments.push(paramIndex);
    } else {
      const constant = resolveConstant(name);
      if (constant === undefined) throw new Error(`语言资源模板存在未声明的占位符 {${name}}：${spec.template}`);
      segments.push(constant);
    }
    cursor = start + match[0].length;
  }
  segments.push(spec.template.slice(cursor));

  return (...args) => {
    if (args.length !== params.length) {
      throw new Error(`语言资源模板形参数量不匹配（声明 ${params.length}，实际 ${args.length}）：${spec.template}`);
    }
    return segments.map((segment) => (typeof segment === "string" ? segment : String(args[segment]))).join("");
  };
}

/**
 * 以规范语言为骨架合并并编译语言资源树
 * @param canonical - 规范语言节点
 * @param localized - 当前语言节点（缺失时为 undefined，整棵子树回退规范语言）
 * @param resolveConstant - 占位符常量解析器
 * @param path - 当前键路径（仅用于异常信息）
 * @returns 编译后的节点
 */
function compileTree(
  canonical: TreeNode,
  localized: TreeNode | undefined,
  resolveConstant: ResolveTemplateConstant,
  path: string,
): unknown {
  const kind = kindOf(canonical);
  if (localized !== undefined && kindOf(localized) !== kind) {
    throw new Error(`语言资源键 ${path} 的取值种类与 ${CANONICAL_LOCALE} 不一致`);
  }
  const effective = localized ?? canonical;
  if (kind === "template") {
    const params = (canonical as TemplateSpec).params ?? [];
    const render = compileTemplate(effective as TemplateSpec, params, resolveConstant);
    return params.length === 0 ? render() : render;
  }
  if (kind === "text") return effective as string;
  if (kind === "list") return [...(effective as readonly string[])];
  const localizedGroup = effective as { readonly [key: string]: TreeNode };
  const compiled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(canonical as { readonly [key: string]: TreeNode })) {
    compiled[key] = compileTree(value, localizedGroup[key], resolveConstant, path ? `${path}.${key}` : key);
  }
  return compiled;
}

/**
 * 装载当前界面语言的文案字典
 * @param resolveConstant - 占位符常量解析器（`{icon.<键>}` 等共享符号）
 * @returns 以规范语言结构为准、按当前语言填充文案的函数字典
 */
export function loadTexts(resolveConstant: ResolveTemplateConstant): CompiledTree<typeof enUS> {
  const localized = LOCALE_PACKAGES[ACTIVE_LOCALE];
  return compileTree(enUS, localized, resolveConstant, "") as CompiledTree<typeof enUS>;
}
