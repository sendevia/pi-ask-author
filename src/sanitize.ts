/**
 * @file sanitize.ts
 * @description 入参防御性清洗：`prepareArguments` 钩子与不可信工具边界的容错体系
 *
 * 核心架构特性：
 * - 容错范围：JSON 串包裹 / `raw` 包装键 / 字段别名 / 纯字符串选项 / 空选项兜底
 * - 白名单收敛：产物仅含 `RawParams` 声明字段（丢弃未知键），保障宿主 Schema 校验通过
 * - 推演载荷清洗：`sanitizeExpansionPayload` 丢弃引用未知题目的选项追加、重复标签、与既有 ID 冲突的新题目与无选项题目
 * - 防御纵深：本层做类型收敛 / 别名映射 / 结构规整 / 区间兜底，模型层再幂等兜底一次
 *
 * 依赖方向：sanitize.ts → format.ts / layout.ts / texts.ts / schema.ts（类型）；被 index / expansion / tool-card 消费
 */

import { cleanOptional, parseJson } from "./format.js";
import { MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";
import { TEXTS } from "./texts.js";
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

/** 字段别名提取源对象形状（不可信边界，统一经 `pickString` 收敛） */
type LooseRecord = Record<string, unknown>;

/** `pickString` 别名表类型：按声明顺序获取第一个命中的字符串字段 */
type StringAliases = readonly string[];

/**
 * 判定不可信输入是否为宽松记录（非 null、非数组对象），工具入参边界的运行时守卫
 * @param value - 待检测值
 * @returns 非 null 的非数组对象时为 true（充当 `LooseRecord` 类型守卫）
 */
function isPlainRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解包 `raw` 包装键（载荷为可用对象时整体替换外层，否则在浅拷贝上摘除该键）
 * @param source - 外层参数对象浅拷贝
 * @returns 权威对象（`raw` 载荷或已摘除 `raw` 的外层对象）
 */
function unwrapRawPayload(source: LooseRecord): LooseRecord {
  const raw = parseJson(source.raw);
  if (isPlainRecord(raw)) return raw;
  delete source.raw;
  return source;
}

/**
 * 依别名表提取第一个字符串型字段
 * @param o - 宽松源对象
 * @param aliases - 别名键列表（按声明顺序优先）
 * @returns 首个命中的字符串值（可为空串，不做空白清洗）；全部未命中返回 undefined
 */
function pickString(o: LooseRecord, aliases: StringAliases): string | undefined {
  for (const key of aliases) {
    const value = o[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * 宽松解析布尔值（兼容布尔值 / 数字 `0`|`1` / 字符串 `"true"`|`"false"`|`"1"`|`"0"`，字符串大小写不敏感且忽略首尾空白）
 * @param val - 原始输入
 * @param defaultVal - 缺省默认值
 * @returns 解析结果；无法识别时返回 `defaultVal`
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
 * 宽松解析整数（兼容数字字符串；非有限数值返回 undefined）
 * @param val - 原始输入
 * @returns 向下取整后的整数；数字非有限、字符串无法解析或类型不符时返回 undefined
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
 * @returns 负值收敛为 0；缺省、非整数或无法解析时返回 undefined（由 Schema 默认值裁决）
 */
function sanitizeMinSelect(val: unknown): number | undefined {
  const n = parseIntegerValue(val);
  return n === undefined ? undefined : Math.max(0, n);
}

/**
 * 规整最多勾选数
 * @param val - 原始上限输入
 * @returns 不小于 1 的整数；缺省、非整数、无法解析或小于 1 时返回 undefined（由 Schema/模型裁决为选项总数）
 */
function sanitizeMaxSelect(val: unknown): number | undefined {
  const n = parseIntegerValue(val);
  return n !== undefined && n >= 1 ? n : undefined;
}

/**
 * 规整单个显示条件（兼容 `questionId` / `question` 与 `option` / `optionLabel` / `label` 别名）
 * @param value - 不可信条件输入
 * @returns 仅含 `questionId` / `option` / `answered` 白名单字段的条件；缺失 `questionId` 或非对象时返回 undefined
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
 * 规整 `showIf` 字段（兼容 JSON 串包裹 / 单条件对象 / 条件数组，丢弃无法识别的条目）
 * @param value - `showIf` 原始值
 * @returns 单个条件、条件数组（非空）或 undefined（无条件可识别）
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
 * 规整选项列表为 `QuestionOption[]`（兼容纯字符串项、宽松对象项与字段别名，上限 `MAX_OPTIONS`）
 * @param value - 原始输入
 * @returns 规整后的选项数组；JSON 串解析失败或非数组输入返回空数组（调用方再经 `withDefaultOption` 兜底）
 */
function coerceOptions(value: unknown): QuestionOption[] {
  const opts = parseJson(value);
  if (!Array.isArray(opts)) return [];
  return opts.slice(0, MAX_OPTIONS).map((item, idx): QuestionOption => {
    if (typeof item === "string") return { label: item.trim() || TEXTS.fallbacks.autoOptionLabel(idx + 1) };
    // 不可信边界收窄：守卫失败项回退自动标签，不做属性读取
    if (!isPlainRecord(item)) return { label: TEXTS.fallbacks.autoOptionLabel(idx + 1) };
    const o = item;

    // 声明式别名表：标签 / 推演 / 草稿 / 批注占位 / 显示条件各按优先级命中
    return {
      label:
        cleanOptional(pickString(o, ["label", "name", "title", "text", "value", "choice"])) ??
        TEXTS.fallbacks.autoOptionLabel(idx + 1),
      description: cleanOptional(pickString(o, ["description", "desc", "reason", "rationale", "deduction"])),
      preview: cleanOptional(pickString(o, ["preview", "draft", "scene", "content"])),
      customPlaceholder: cleanOptional(pickString(o, ["customPlaceholder", "placeholder"])),
      showIf: coerceShowIf(o.showIf ?? o.when ?? o.visibleIf),
    };
  });
}

/**
 * 规整题目级推演配置（兼容布尔值 / `enabled` 开关 / 推演方向与插入位置对象）
 * @param value - `expansion` 原始值
 * @returns `false`（本题不推演）、仅含 `guidance` / `insert` 的配置对象，或 undefined（缺省继承表单级设置）
 */
function coerceQuestionExpansion(value: unknown): QuestionInput["expansion"] {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const parsed = parseJson(value);
  if (typeof parsed === "boolean") return parsed;
  if (!isPlainRecord(parsed)) return undefined;
  if (parsed.enabled !== undefined && !parseBooleanValue(parsed.enabled, true)) return false;
  const config: NonNullable<Exclude<QuestionInput["expansion"], boolean>> = {};
  const guidance = cleanOptional(pickString(parsed, ["guidance", "instructions", "hint"]));
  if (guidance) config.guidance = guidance;
  const insert = coerceInsertPosition(parsed.insert ?? parsed.position);
  if (insert !== undefined) config.insert = insert;
  return config;
}

/**
 * 判定宽松输入是否形如单题（须含选项类字段 options/choices/items 或显式题目键 question/prompt；`questions` 批量容器一律排除）
 * @param value - 待检测输入
 * @returns 携带选项类字段或显式题目键时为 true；非对象、`null` 与含 `questions` 键的批量容器恒为 false（本函数不排除数组，调用方先 `Array.isArray` 分流）
 */
function isQuestionLike(value: unknown): value is LooseRecord {
  if (typeof value !== "object" || value === null || "questions" in value) return false;
  return "options" in value || "choices" in value || "items" in value || "question" in value || "prompt" in value;
}

/**
 * 规整单题条目为符合 Schema 的输入结构（兼容别名字段；字符串条目直接充当标题，其余非对象条目回退自动标题 + 默认选项）
 * @param value - 单题输入
 * @param index - 题目顺序索引
 * @returns 字段集与 `QuestionSchema` 完全一致的单题对象（`options` 为空时至少含一个默认方案）
 */
function sanitizeQuestionEntry(value: unknown, index: number): QuestionInput {
  if (typeof value === "string") {
    return { title: value, options: withDefaultOption([]) };
  }
  // 不可信边界收窄：经运行时守卫后按宽松记录读取别名，非对象条目回退自动标题 + 默认选项
  if (!isPlainRecord(value)) {
    return { title: TEXTS.fallbacks.autoQuestionTitle(index + 1), options: withDefaultOption([]) };
  }
  const o = value;

  return {
    id: pickString(o, ["id"]),
    title:
      cleanOptional(pickString(o, ["title", "question", "prompt", "query", "heading"])) ??
      TEXTS.fallbacks.autoQuestionTitle(index + 1),
    tabLabel: cleanOptional(pickString(o, ["tabLabel", "tabTitle", "tab"])),
    description: cleanOptional(pickString(o, ["description", "desc", "rationale"])),
    multiSelect: parseBooleanValue(o.multiSelect, false),
    minSelect: sanitizeMinSelect(o.minSelect),
    maxSelect: sanitizeMaxSelect(o.maxSelect),
    allowEmpty: parseBooleanValue(o.allowEmpty, false),
    options: withDefaultOption(coerceOptions(o.options ?? o.choices ?? o.items)),
    allowCustom: parseBooleanValue(o.allowCustom, true),
    customPlaceholder: pickString(o, ["customPlaceholder", "placeholder"]),
    showIf: coerceShowIf(o.showIf ?? o.when ?? o.visibleIf),
    expansion: coerceQuestionExpansion(o.expansion ?? o.expand),
  };
}

/**
 * 归一化题目列表（兼容 JSON 串包裹 / 单题对象包裹 / 数组，上限 `MAX_QUESTIONS`）
 * 边界：空列表或无法识别为题目结构的输入视为未提供
 * @param value - `questions` / `form` / `survey` 容器键的原始值
 * @returns 规整后的题目数组（至少一项）；入参为 undefined / 空列表 / 无法识别时返回 undefined
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
 * @returns 原数组（非空时）或单元素默认方案数组（恒非空，满足 Schema `minItems: 1`）
 */
function withDefaultOption(options: QuestionOption[]): QuestionOption[] {
  return options.length > 0 ? options : [{ label: TEXTS.fallbacks.defaultOptionLabel }];
}

/**
 * 规整推演题目的插入位置（兼容 JSON 串包裹、`after` 别名与 `anchor` 字符串）
 * @param value - `insert` 原始值
 * @returns 预设字符串或 `{ after }` 锚点；无法识别时返回 undefined（由模型层收敛为跟随）
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
 * @returns 仅含 `maxQuestions` / `guidance` / `insert` 的配置；非对象输入返回 undefined（视为未开启推演）
 */
function coerceExpansion(value: unknown): ExpansionConfig | undefined {
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) return undefined;
  const config: ExpansionConfig = {};
  const maxQuestions = parseIntegerValue(parsed.maxQuestions);
  if (maxQuestions !== undefined) config.maxQuestions = Math.min(Math.max(1, maxQuestions), MAX_QUESTIONS);
  const guidance = cleanOptional(pickString(parsed, ["guidance", "instructions", "hint"]));
  if (guidance) config.guidance = guidance;
  const insert = coerceInsertPosition(parsed.insert ?? parsed.position);
  if (insert !== undefined) config.insert = insert;
  return config;
}

/**
 * 解析单题平铺模式题干（三级回退：`question` → `prompt` → 携带候选选项时的 `title` / `taskTitle`）
 * @param rawQuestion - 顶层 `question` 原始值
 * @param rawPrompt - `prompt` 别名原始值
 * @param aliasFormTitle - 由 `title` / `taskTitle` 提取的别名标题
 * @param hasFlatOptions - 平铺模式是否携带候选选项
 * @returns 题干；三个来源均未命中为 undefined（Schema 缺省裁决）
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
 * 入参防御性清洗（`prepareArguments` 钩子）；容错面见文件头，各字段先收敛为本地强类型 `const` 再组装为显式白名单产物
 * @param args - 工具调用原始入参（不可信边界）
 * @returns 仅含 Schema 声明字段的 `RawParams` 白名单对象；输入完全不可辨识时仅返回兜底 `formTitle`
 */
export function sanitizeAskAuthorArgs(args: unknown): RawParams {
  const source = args && typeof args === "object" ? args : parseJson(args);
  if (!isPlainRecord(source)) {
    return { formTitle: TEXTS.fallbacks.defaultFormTitle };
  }

  // 0. 权威对象：浅拷贝外层后解开 `raw` 包装（载荷可用时整体替换外层）
  const p: LooseRecord = unwrapRawPayload({ ...source });

  // 1. 表单标题别名链：formTitle → title / taskTitle → 缺省兜底（aliasFormTitle 留作平铺题干回退）
  const aliasFormTitle: string | undefined = cleanOptional(pickString(p, ["title", "taskTitle"]));
  const formTitle: string =
    cleanOptional(pickString(p, ["formTitle"])) ?? aliasFormTitle ?? TEXTS.fallbacks.defaultFormTitle;

  // 2. 规范化 questions 数组（兼容 questions / form / survey 容器键；空列表视为未提供）
  const questions: QuestionInput[] | undefined = normalizeQuestions(p.questions ?? p.form ?? p.survey);

  // 3. 规范化单题平铺候选选项（兼容 options / choices / items 容器键，任一键存在即视为平铺模式）
  const rawFlatOptions: unknown = p.options ?? p.choices ?? p.items;
  const hasFlatOptions: boolean = p.options !== undefined || p.choices !== undefined || p.items !== undefined;
  const options: QuestionOption[] | undefined = hasFlatOptions
    ? withDefaultOption(coerceOptions(rawFlatOptions))
    : undefined;

  // 4. 题干回退链：question → prompt 别名 →（平铺模式下）title 别名
  const question: string | undefined = resolveFlatQuestion(p.question, p.prompt, aliasFormTitle, hasFlatOptions);

  // 5. 平铺模式标量字段收敛：缺省字段保持 undefined，可选性由 Schema 裁决
  const description: string | undefined = pickString(p, ["description"]);
  const multiSelect: boolean | undefined =
    p.multiSelect === undefined ? undefined : parseBooleanValue(p.multiSelect, false);
  const minSelect: number | undefined = p.minSelect === undefined ? undefined : sanitizeMinSelect(p.minSelect);
  const maxSelect: number | undefined = p.maxSelect === undefined ? undefined : sanitizeMaxSelect(p.maxSelect);
  const allowEmpty: boolean | undefined =
    p.allowEmpty === undefined ? undefined : parseBooleanValue(p.allowEmpty, false);
  const allowCustom: boolean | undefined =
    p.allowCustom === undefined ? undefined : parseBooleanValue(p.allowCustom, true);
  const customPlaceholder: string | undefined = pickString(p, ["customPlaceholder"]);

  // 7. 实时推演配置（缺省保持 undefined，视为不推演）
  const expansion: ExpansionConfig | undefined = p.expansion === undefined ? undefined : coerceExpansion(p.expansion);

  // 8. 白名单收敛：仅保留 RawParams 声明的字段（键序与 Schema 一致），丢弃全部不可信残留键
  const sanitized: RawParams = {
    formTitle,
    description,
    expansion,
    questions,
    question,
    multiSelect,
    minSelect,
    maxSelect,
    allowEmpty,
    options,
    allowCustom,
    customPlaceholder,
  };
  return sanitized;
}

/** 推演载荷的归集上下文：表单当前已声明的题目 ID 与各题已有选项标签 */
export interface ExpansionContext {
  /** 已声明的题目 ID（按题目顺序） */
  readonly questionIds: readonly string[];
  /** 题目 ID → 已有选项标签 */
  readonly optionLabels: ReadonlyMap<string, readonly string[]>;
}

/**
 * 规整推演模型的回复载荷（不可信边界）：丢弃引用未知题目的选项追加、与既有标签重复的选项以及与既有题目 ID 冲突的新题目
 * @param value - 已解析的回复对象（非对象时视为无新增）
 * @param context - 表单当前已声明的题目与选项标签
 * @returns 仅含合法追加项的推演载荷；全部条目被过滤时返回空载荷（表单停止增长）
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
    const labels = new Set<string>();
    question.options = question.options.filter((option) => {
      if (labels.has(option.label)) return false;
      labels.add(option.label);
      return true;
    });
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
    const labels = new Set(declared);
    const options = coerceOptions(entry.options ?? entry.choices ?? entry.items).filter((option) => {
      if (labels.has(option.label)) return false;
      labels.add(option.label);
      return true;
    });
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
