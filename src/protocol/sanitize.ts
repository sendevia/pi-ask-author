/**
 * @file protocol/sanitize.ts
 * @description 入参防御性清洗：`prepareArguments` 钩子与不可信工具边界的容错处理
 *
 * - 容错范围：JSON 串包裹 / `raw` 包装键 / 字段别名 / 纯字符串选项 / 空选项兜底
 * - 白名单收敛：产物仅含 `RawParams` 声明字段，保障宿主 Schema 校验通过
 * - 本层做类型收敛、别名映射与区间兜底，模型层再幂等兜底一次
 */

import { cleanOptional, parseJson } from "../core/format.js";
import { MAX_OPTIONS, MAX_QUESTIONS } from "../core/layout.js";
import { TEXTS } from "../core/texts.js";
import type {
  ExpansionConfig,
  ExpansionPayload,
  InsertPosition,
  OptionAddition,
  QuestionInput,
  QuestionOption,
  RawParams,
  ShowIfInput,
  VisibilityConditionInput,
} from "./schema.js";

/** 不可信边界源对象形状（字段一律经 `pickString` 等提取器收敛） */
type LooseRecord = Record<string, unknown>;

/** 别名表：按声明顺序取第一个命中的字符串字段 */
type StringAliases = readonly string[];

/**
 * 判定不可信输入是否为普通对象（非 null、非数组）
 * @param value - 待检测值
 * @returns 是普通对象时为 true（充当 `LooseRecord` 类型守卫）
 */
function isPlainRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解包 `raw` 包装键
 * @param source - 外层参数对象浅拷贝
 * @returns `raw` 载荷为可用对象时整体替换外层，否则在浅拷贝上摘除该键
 */
function unwrapRawPayload(source: LooseRecord): LooseRecord {
  const raw = parseJson(source.raw);
  if (isPlainRecord(raw)) return raw;
  delete source.raw;
  return source;
}

/**
 * 依别名表提取首个字符串型字段
 * @param o - 源对象
 * @param aliases - 别名键列表（按声明顺序优先）
 * @returns 首个命中的字符串（可为空串，不做空白清洗）；未命中为 undefined
 */
function pickString(o: LooseRecord, aliases: StringAliases): string | undefined {
  for (const key of aliases) {
    const value = o[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * 宽松解析布尔值（兼容布尔值、数字 `0`|`1` 与字符串 `"true"`|`"false"`|`"1"`|`"0"`，不区分大小写）
 * @param val - 原始输入
 * @param defaultVal - 缺省默认值
 * @returns 解析结果；无法识别时为 `defaultVal`
 */
function parseBooleanValue(val: unknown, defaultVal: boolean): boolean {
  if (typeof val === "boolean") return val;
  if (val === 1) return true;
  if (val === 0) return false;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return defaultVal;
}

/**
 * 宽松解析整数（兼容数字字符串）
 * @param val - 原始输入
 * @returns 向下取整的整数；非有限数值、无法解析或类型不符时为 undefined
 */
function parseIntegerValue(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return Math.floor(val);
  if (typeof val === "string") {
    const n = parseInt(val.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 规整最少勾选数
 * @param val - 原始下限输入
 * @returns 负值收敛为 0；无法解析时为 undefined（由 Schema 默认值裁决）
 */
function sanitizeMinSelect(val: unknown): number | undefined {
  const n = parseIntegerValue(val);
  return n === undefined ? undefined : Math.max(0, n);
}

/**
 * 规整最多勾选数
 * @param val - 原始上限输入
 * @returns 不小于 1 的整数；无法解析或小于 1 时为 undefined（由 Schema / 模型裁决为选项总数）
 */
function sanitizeMaxSelect(val: unknown): number | undefined {
  const n = parseIntegerValue(val);
  return n !== undefined && n >= 1 ? n : undefined;
}

/**
 * 规整单个显示条件（兼容 `questionId` / `question` 与 `option` / `optionLabel` / `label` 别名）
 * @param value - 不可信条件输入
 * @returns 仅含 `questionId` / `option` / `answered` 的条件；非对象或缺 `questionId` 时为 undefined
 */
function coerceCondition(value: unknown): VisibilityConditionInput | undefined {
  if (!isPlainRecord(value)) return undefined;
  const questionId = cleanOptional(pickString(value, ["questionId", "question"]));
  if (!questionId) return undefined;
  const condition: VisibilityConditionInput = { questionId };
  const option = cleanOptional(pickString(value, ["option", "optionLabel", "label"]));
  if (option) condition.option = option;
  if (value.answered !== undefined) condition.answered = parseBooleanValue(value.answered, true);
  return condition;
}

/**
 * 规整 `showIf` 字段（兼容 JSON 串包裹、单条件对象与条件数组，丢弃无法识别的条目）
 * @param value - `showIf` 原始值
 * @returns 单个条件、非空条件数组，或 undefined（无可识别条件）
 */
function coerceShowIf(value: unknown): ShowIfInput | undefined {
  const parsed = parseJson(value);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const conditions = entries
    .map(coerceCondition)
    .filter((condition): condition is VisibilityConditionInput => condition !== undefined);
  if (Array.isArray(parsed)) return conditions.length > 0 ? conditions : undefined;
  return conditions[0];
}

/**
 * 规整选项列表为 `QuestionOption[]`（兼容纯字符串项、普通对象项与字段别名，上限 `MAX_OPTIONS`）
 * @param value - 原始输入
 * @returns 规整后的选项数组；解析失败或非数组输入为空数组（调用方再经 `withDefaultOption` 兜底）
 */
function coerceOptions(value: unknown): QuestionOption[] {
  const opts = parseJson(value);
  if (!Array.isArray(opts)) return [];
  return opts.slice(0, MAX_OPTIONS).map((item, idx): QuestionOption => {
    if (typeof item === "string") return { label: item.trim() || TEXTS.fallbacks.autoOptionLabel(idx + 1) };
    // 不可信边界收窄：守卫失败项回退自动标签，不读属性
    if (!isPlainRecord(item)) return { label: TEXTS.fallbacks.autoOptionLabel(idx + 1) };
    return {
      label:
        cleanOptional(pickString(item, ["label", "name", "title", "text", "value", "choice"])) ??
        TEXTS.fallbacks.autoOptionLabel(idx + 1),
      description: cleanOptional(pickString(item, ["description", "desc", "reason", "rationale", "deduction"])),
      preview: cleanOptional(pickString(item, ["preview", "draft", "scene", "content"])),
      customPlaceholder: cleanOptional(pickString(item, ["customPlaceholder", "placeholder"])),
      showIf: coerceShowIf(item.showIf ?? item.when ?? item.visibleIf),
    };
  });
}

/**
 * 提取推演对象中的方向指示与插入位置
 * @param record - 已确认为普通对象的推演配置
 * @returns 仅含 `guidance` / `insert` 的配置对象
 */
function extractExpansionFields(record: LooseRecord): { guidance?: string; insert?: InsertPosition } {
  const config: { guidance?: string; insert?: InsertPosition } = {};
  const guidance = cleanOptional(pickString(record, ["guidance", "instructions", "hint"]));
  if (guidance) config.guidance = guidance;
  const insert = coerceInsertPosition(record.insert ?? record.position);
  if (insert !== undefined) config.insert = insert;
  return config;
}

/**
 * 规整题目级推演配置（兼容布尔值、`enabled` 开关与推演方向、插入位置对象）
 * @param value - `expansion` 原始值
 * @returns `false`（本题不推演）、仅含 `guidance` / `insert` 的对象，或 undefined（继承表单级设置）
 */
function coerceQuestionExpansion(value: unknown): QuestionInput["expansion"] {
  if (value === undefined) return undefined;
  const parsed = typeof value === "boolean" ? value : parseJson(value);
  if (typeof parsed === "boolean") return parsed;
  if (!isPlainRecord(parsed)) return undefined;
  if (parsed.enabled !== undefined && !parseBooleanValue(parsed.enabled, true)) return false;
  return extractExpansionFields(parsed);
}

/**
 * 判定输入是否形如单题（含选项类字段 options/choices/items 或题目键 question/prompt；带 `questions` 的批量容器一律排除）
 * @param value - 待检测输入
 * @returns 形如单题时为 true；非对象、`null` 与批量容器恒为 false
 */
function isQuestionLike(value: unknown): value is LooseRecord {
  if (!isPlainRecord(value) || "questions" in value) return false;
  return "options" in value || "choices" in value || "items" in value || "question" in value || "prompt" in value;
}

/**
 * 规整单题条目为符合 Schema 的输入结构（兼容别名字段；字符串条目充当标题，非对象条目回退自动标题与默认选项）
 * @param value - 单题输入
 * @param index - 题目顺序索引
 * @returns 字段集与 `QuestionSchema` 一致的单题对象（`options` 为空时至少含一个默认方案）
 */
function sanitizeQuestionEntry(value: unknown, index: number): QuestionInput {
  if (typeof value === "string") {
    return { title: value, options: withDefaultOption([]) };
  }
  if (!isPlainRecord(value)) {
    return { title: TEXTS.fallbacks.autoQuestionTitle(index + 1), options: withDefaultOption([]) };
  }
  return {
    id: pickString(value, ["id"]),
    title:
      cleanOptional(pickString(value, ["title", "question", "prompt", "query", "heading"])) ??
      TEXTS.fallbacks.autoQuestionTitle(index + 1),
    tabLabel: cleanOptional(pickString(value, ["tabLabel", "tabTitle", "tab"])),
    description: cleanOptional(pickString(value, ["description", "desc", "rationale"])),
    multiSelect: parseBooleanValue(value.multiSelect, false),
    minSelect: sanitizeMinSelect(value.minSelect),
    maxSelect: sanitizeMaxSelect(value.maxSelect),
    allowEmpty: parseBooleanValue(value.allowEmpty, false),
    options: withDefaultOption(coerceOptions(value.options ?? value.choices ?? value.items)),
    allowCustom: parseBooleanValue(value.allowCustom, true),
    customPlaceholder: pickString(value, ["customPlaceholder", "placeholder"]),
    showIf: coerceShowIf(value.showIf ?? value.when ?? value.visibleIf),
    expansion: coerceQuestionExpansion(value.expansion ?? value.expand),
  };
}

/**
 * 归一化题目列表（兼容 JSON 串包裹、单题对象包裹与数组，上限 `MAX_QUESTIONS`）
 * @param value - `questions` / `form` / `survey` 容器键的原始值
 * @returns 规整后的题目数组（至少一项）；未提供、空列表或无法识别时为 undefined
 */
function normalizeQuestions(value: unknown): QuestionInput[] | undefined {
  if (value === undefined) return undefined;
  const parsed = parseJson(value);
  const questionList = Array.isArray(parsed) ? parsed : isQuestionLike(parsed) ? [parsed] : [];
  if (questionList.length === 0) return undefined;
  return questionList.slice(0, MAX_QUESTIONS).map((entry, index) => sanitizeQuestionEntry(entry, index));
}

/**
 * 空选项数组兜底为单个默认方案
 * @param options - 已规整的选项数组
 * @returns 原数组，或单元素默认方案（恒非空，满足 `minItems: 1`）
 */
function withDefaultOption(options: QuestionOption[]): QuestionOption[] {
  return options.length > 0 ? options : [{ label: TEXTS.fallbacks.defaultOptionLabel }];
}

/**
 * 规整推演题目的插入位置（兼容 JSON 串包裹、`after` 别名与裸字符串锚点）
 * @param value - `insert` 原始值
 * @returns 预设字符串或 `{ after }` 锚点；无法识别时为 undefined（由模型层收敛为跟随）
 */
function coerceInsertPosition(value: unknown): InsertPosition | undefined {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "follow" || normalized === "tail") return normalized;
    const anchor = cleanOptional(value);
    return anchor ? { after: anchor } : undefined;
  }
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) return undefined;
  const after = cleanOptional(pickString(parsed, ["after", "questionId", "anchor", "id"]));
  return after ? { after } : undefined;
}

/**
 * 规整实时推演配置（兼容 JSON 串包裹与 `instructions` / `hint` 别名）
 * @param value - `expansion` 原始值
 * @returns 仅含 `maxQuestions` / `guidance` / `insert` 的配置；非对象输入为 undefined（视为未开启推演）
 */
function coerceExpansion(value: unknown): ExpansionConfig | undefined {
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) return undefined;
  const config: ExpansionConfig = extractExpansionFields(parsed);
  const maxQuestions = parseIntegerValue(parsed.maxQuestions);
  if (maxQuestions !== undefined) config.maxQuestions = Math.min(Math.max(1, maxQuestions), MAX_QUESTIONS);
  return config;
}

/**
 * 按选项标签去重选项数组，保留首次出现或不在已知集合中的选项
 * @param options - 待过滤的选项列表
 * @param seen - 已占用的标签集合（原地登记新标签）
 * @returns 去重后的选项列表
 */
function filterUniqueOptions(options: QuestionOption[], seen: Set<string>): QuestionOption[] {
  return options.filter((option) => {
    if (seen.has(option.label)) return false;
    seen.add(option.label);
    return true;
  });
}

/**
 * 解析单题平铺模式题干（三级回退：`question` → `prompt` → 携带候选选项时的 `title` / `taskTitle`）
 * @param rawQuestion - 顶层 `question` 原始值
 * @param rawPrompt - `prompt` 别名原始值
 * @param aliasFormTitle - 由 `title` / `taskTitle` 提取的别名标题
 * @param hasFlatOptions - 平铺模式是否携带候选选项
 * @returns 题干；三个来源均未命中时为 undefined（由 Schema 缺省裁决）
 */
function resolveFlatQuestion(
  rawQuestion: unknown,
  rawPrompt: unknown,
  aliasFormTitle: string | undefined,
  hasFlatOptions: boolean,
): string | undefined {
  if (typeof rawQuestion === "string") return rawQuestion;
  if (typeof rawPrompt === "string") return rawPrompt;
  return hasFlatOptions ? aliasFormTitle : undefined;
}

/**
 * 入参防御性清洗（`prepareArguments` 钩子）
 * @param args - 工具调用原始入参（不可信边界）
 * @returns 仅含 Schema 声明字段的白名单对象；输入完全不可辨识时仅含兜底 `formTitle`
 */
export function sanitizeAskAuthorArgs(args: unknown): RawParams {
  const source = args && typeof args === "object" ? args : parseJson(args);
  if (!isPlainRecord(source)) {
    return { formTitle: TEXTS.fallbacks.defaultFormTitle };
  }

  // 0. 权威对象：浅拷贝外层后解开 `raw` 包装（载荷可用时整体替换外层）
  const p = unwrapRawPayload({ ...source });

  // 1. 表单标题别名链：formTitle → title / taskTitle → 缺省兜底（aliasFormTitle 留作平铺题干回退）
  const aliasFormTitle = cleanOptional(pickString(p, ["title", "taskTitle"]));
  const formTitle = cleanOptional(pickString(p, ["formTitle"])) ?? aliasFormTitle ?? TEXTS.fallbacks.defaultFormTitle;

  // 2. 规范化 questions 数组（兼容 questions / form / survey 容器键；空列表视为未提供）
  const questions = normalizeQuestions(p.questions ?? p.form ?? p.survey);

  // 3. 规范化单题平铺候选选项（兼容 options / choices / items 容器键，任一键存在即视为平铺模式）
  const rawFlatOptions = p.options ?? p.choices ?? p.items;
  const hasFlatOptions = p.options !== undefined || p.choices !== undefined || p.items !== undefined;
  const options = hasFlatOptions ? withDefaultOption(coerceOptions(rawFlatOptions)) : undefined;

  // 4. 题干回退链：question → prompt 别名 →（平铺模式下）title 别名
  const question = resolveFlatQuestion(p.question, p.prompt, aliasFormTitle, hasFlatOptions);

  // 5. 白名单收敛：仅保留 `RawParams` 声明的字段（键序与 Schema 一致）
  return {
    formTitle,
    description: pickString(p, ["description"]),
    expansion: p.expansion === undefined ? undefined : coerceExpansion(p.expansion),
    questions,
    question,
    multiSelect: p.multiSelect === undefined ? undefined : parseBooleanValue(p.multiSelect, false),
    minSelect: p.minSelect === undefined ? undefined : sanitizeMinSelect(p.minSelect),
    maxSelect: p.maxSelect === undefined ? undefined : sanitizeMaxSelect(p.maxSelect),
    allowEmpty: p.allowEmpty === undefined ? undefined : parseBooleanValue(p.allowEmpty, false),
    options,
    allowCustom: p.allowCustom === undefined ? undefined : parseBooleanValue(p.allowCustom, true),
    customPlaceholder: pickString(p, ["customPlaceholder"]),
  };
}

/** 推演载荷的归集上下文：表单已声明的题目 ID 与各题已有选项标签 */
export interface ExpansionContext {
  /** 已声明的题目 ID（按题目顺序） */
  readonly questionIds: readonly string[];
  /** 题目 ID → 已有选项标签 */
  readonly optionLabels: ReadonlyMap<string, readonly string[]>;
}

/**
 * 规整推演模型的回复载荷（不可信边界）：丢弃引用未知题目的选项追加、与既有标签重复的选项、与既有题目 ID 冲突的新题目与无选项的新题目
 * @param value - 已解析的回复对象（非对象时视为无新增）
 * @param context - 表单已声明的题目与选项标签
 * @returns 仅含合法追加项的推演载荷；全部条目被过滤时为空载荷（表单停止增长）
 */
export function sanitizeExpansionPayload(value: unknown, context: ExpansionContext): ExpansionPayload {
  if (!isPlainRecord(value)) return { questions: [], optionAdditions: [] };

  const usedQuestionIds = new Set(context.questionIds);
  const questions: QuestionInput[] = [];
  for (const entry of asArray(parseJson(value.questions))) {
    // 无标题或无选项的生成题目不进入表单：占位题目对作者没有决策价值
    if (!isPlainRecord(entry)) continue;
    if (!cleanOptional(pickString(entry, ["title", "question", "prompt", "query", "heading"]))) continue;
    if (asArray(parseJson(entry.options ?? entry.choices ?? entry.items)).length === 0) continue;

    const question = sanitizeQuestionEntry(entry, questions.length);
    // 同一题目内重复标签会破坏按标签定位的显示条件，保留首次出现
    question.options = filterUniqueOptions(question.options, new Set<string>());
    // 与既有题目 ID 冲突的新题目重新派生 ID，避免 showIf 引用歧义
    if (question.id !== undefined && usedQuestionIds.has(question.id)) question.id = undefined;
    if (question.id !== undefined) usedQuestionIds.add(question.id);
    questions.push(question);
  }

  const optionAdditions: OptionAddition[] = [];
  for (const entry of asArray(parseJson(value.options ?? value.optionAdditions))) {
    if (!isPlainRecord(entry)) continue;
    const questionId = cleanOptional(pickString(entry, ["questionId", "question", "id"]));
    if (!questionId) continue;
    const declared = context.optionLabels.get(questionId);
    if (!declared) continue;
    const options = filterUniqueOptions(
      coerceOptions(entry.options ?? entry.choices ?? entry.items),
      new Set(declared),
    );
    if (options.length > 0) optionAdditions.push({ questionId, options });
  }

  return { questions, optionAdditions };
}

/**
 * 归一化不可信输入为数组（非数组与缺省一律视为空列表）
 * @param value - 待检测值
 * @returns 原数组或空数组
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
