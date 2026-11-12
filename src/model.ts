/**
 * @file model.ts
 * @description 问卷数据模型与状态机：题目归一化、作答状态流转、答卷编译与封套输出
 *
 * - 内部作答状态 0-based，对外答卷编号 1-based
 * - `sanitize.ts` 边界归一化之后再幂等兜底一次，绕过该层直接构造模型同样安全
 * - 插值文本经 `sanitizeEnvelopeText` 归一，封套定界符无法被作者文本击穿
 * - 显隐快照按 `revision` 缓存，隐藏项的选择既不计入作答也不进入答卷
 * - 推演的插入与撤回整体平移后续题目的条件、作答状态与记录索引
 * - 整卷补充独立于各题作答状态，作为封套末行的单独令牌输出
 */

import { cleanOptional, cleanText, clamp, toSingleLine } from "./format.js";
import { MAX_QUESTIONS } from "./layout.js";
import { TEXTS } from "./texts.js";
import type {
  ExpansionPayload,
  InsertPosition,
  OptionAddition,
  QuestionInput,
  QuestionOption,
  RawParams,
  ShowIfInput,
} from "./schema.js";

/**
 * 显示条件的归一化形态（题目索引与选项索引已解析）
 * - `option`：指定题目中某个选项当前处于选中状态
 * - `answered`：指定题目存在（或不存在）作答痕迹
 */
export type VisibilityCondition =
  | { readonly kind: "option"; readonly questionIndex: number; readonly optionIndex: number }
  | { readonly kind: "answered"; readonly questionIndex: number; readonly answered: boolean };

/** 归一化后的候选选项（在 Schema 选项字段之外附带显示条件） */
export interface NormalizedOption {
  /** 选项标签 */
  label: string;
  /** 情节推演与设定阐述 */
  description?: string;
  /** 正文草稿或分镜头预览 */
  preview?: string;
  /** 选项补充说明占位词 */
  customPlaceholder?: string;
  /** 显示条件（空数组表示恒显示） */
  showIf: VisibilityCondition[];
}

/** 归一化后的问题对象（字段已兜底，区间已收敛） */
export interface NormalizedQuestion {
  /** 题目唯一标识符 */
  id: string;
  /** 题目标题 */
  title: string;
  /** Tab 短标签（缺省时 Tab 栏显示题号） */
  tabLabel?: string;
  /** 题目背景描述 */
  description?: string;
  /** 是否多选（默认 false） */
  multiSelect: boolean;
  /** 收敛后的最少勾选数（`0 ~ options.length`） */
  minSelect: number;
  /** 是否显式给出 `minSelect`（显式即强制下限） */
  minSelectExplicit: boolean;
  /** 收敛后的最多勾选数（`minSelect ~ options.length`） */
  maxSelect: number;
  /** 是否允许 0 勾选提交（默认 false，单选与多选均生效） */
  allowEmpty: boolean;
  /** 归一化后的候选选项列表（至少一项） */
  options: NormalizedOption[];
  /** 是否允许自由补充说明（默认 true） */
  allowCustom: boolean;
  /** 补充说明输入框占位提示词 */
  customPlaceholder: string;
  /** 该题目的显示条件（空数组表示恒显示） */
  showIf: VisibilityCondition[];
  /** 确认该题目后是否发起实时推演（表单未开启推演时不起作用） */
  expandOnConfirm: boolean;
  /** 该题目的推演方向指示（覆盖表单级设置） */
  expansionGuidance?: string;
  /** 该题目的推演插入位置（覆盖表单级设置） */
  expansionInsert?: InsertPosition;
}

/** 自适应条件非法（引用未知题目、后置题目或不存在的选项）：携带英文诊断消息，由入口层映射为结构化错误结果 */
export class AdaptiveConditionError extends Error {
  /**
   * 构造自适应条件异常
   * @param message - 英文诊断消息（取自 `TEXTS.markdown.adaptiveErrors`）
   */
  constructor(message: string) {
    super(message);
    this.name = "AdaptiveConditionError";
  }
}

/** 单题作答状态（选项索引 0-based） */
export interface QuestionAnswerState {
  /** 单选选中项索引（未选中时缺省） */
  selectedIndex?: number;
  /** 多选选中项索引集合 */
  selectedIndices: Set<number>;
  /** 题目级整体补充说明 */
  customText?: string;
  /** 选项批注映射（0-based `optionIndex` → 批注内容） */
  optionNotes: Map<number, string>;
}

/** 单题最终答卷条目（索引 1-based） */
export interface AuthorAnswerItem {
  /** 题目唯一标识符 */
  questionId: string;
  /** 题目标题 */
  questionTitle: string;
  /** 是否为多选模式 */
  multiSelect: boolean;
  /** 单选选中项（含专属批注） */
  selectedOption?: QuestionOption & { customText?: string };
  /** 单选选中项序号（1-based；未选中时缺省） */
  selectedOptionIndex?: number;
  /** 多选选中项列表（每项含专属批注） */
  selectedOptions?: Array<QuestionOption & { customText?: string }>;
  /** 多选选中项序号列表（1-based，升序） */
  selectedIndices?: number[];
  /** 题目整体补充说明 */
  customText?: string;
  /** 选项批注映射（1-based `optionIndex` → 批注，含未选中选项上的孤立批注） */
  optionNotes?: Record<number, string>;
}

/** 工具执行完成返回的持久化结果结构 */
export interface AskAuthorResult {
  /** 问卷总标题 */
  formTitle: string;
  /** 问卷全局背景描述 */
  formDescription?: string;
  /** 归一化的问题列表 */
  questions: NormalizedQuestion[];
  /** 收集到的答卷条目列表 */
  answers: AuthorAnswerItem[];
  /** 提交页填写的整卷自由补充（未填写时缺省） */
  supplement?: string;
  /** 用户是否主动取消了本次请示 */
  cancelled: boolean;
  /** 执行过程中的错误信息 */
  error?: string;
}

/** 批注编辑目标：`form` 整卷补充 / `question` 题目整体 / `option` 指定选项专属（`optionIndex` 为 0-based，越界不写入状态） */
export type EditTarget =
  | { type: "form" }
  | { type: "question" }
  | { type: "option"; optionIndex: number };

/** 题目菜单项（一个可见预设选项） */
export interface MenuItem {
  /** 预设选项索引（0-based） */
  optionIndex: number;
  /** 菜单项显示文本 */
  label: string;
  /** 菜单项背景描述推演 */
  description?: string;
  /** 菜单项正文草稿/分镜头预览 */
  preview?: string;
}

/** 题目底部操作按钮的文案（补在选项列表之后，靠右成组） */
export interface QuestionActions {
  /** 题目补充说明入口按钮文案；题目禁用补充说明时缺省 */
  readonly note?: string;
  /** 确认推进按钮文案 */
  readonly confirm: string;
}

/** 勾选 toggle 的操作语义（不导出，组件层映射为状态栏提示） */
type ToggleResult = "selected" | "deselected" | "limit";

/** 一次推演追加的记录，作为撤回的最小单元 */
export interface ExpansionRecord {
  /** 触发推演的题目索引（0-based） */
  readonly questionIndex: number;
  /** 触发时该题的答案签名（选中项标签按序拼接） */
  readonly signature: string;
  /** 追加题目在题目列表中的起始位置（即触发题目的下一题） */
  readonly insertAt: number;
  /** 本次插入的题目数 */
  readonly addedQuestions: number;
  /** 本次向既有题目追加的选项 */
  readonly addedOptions: readonly { readonly questionIndex: number; readonly count: number }[];
}

/** 全选/清空操作语义 */
type SelectAllResult = "cleared" | "filled";

/** 批注保存操作语义 */
type NoteSaveResult = "saved" | "cleared" | "savedUnselected" | "savedAtLimit";

/**
 * 判定是否存在非空题目级批注
 * @param st - 题目作答状态
 * @returns `customText` 去空白后非空时为 true
 */
export function hasQuestionNote(st: QuestionAnswerState): boolean {
  return Boolean(st.customText?.trim());
}

/**
 * 判定是否存在非空选项批注
 * @param st - 题目作答状态
 * @returns 任一选项批注去空白后非空时为 true
 */
function hasAnyOptionNote(st: QuestionAnswerState): boolean {
  for (const n of st.optionNotes.values()) {
    if (n?.trim()) return true;
  }
  return false;
}

/**
 * 判定是否存在任意非空批注（题目级或选项级）
 * @param st - 题目作答状态
 * @returns 任一非空批注存在时为 true
 */
function hasAnyNote(st: QuestionAnswerState): boolean {
  return hasQuestionNote(st) || hasAnyOptionNote(st);
}

/** 多选区间收敛结果 */
interface SelectBounds {
  /** 收敛后的最少勾选数 */
  minSelect: number;
  /** 是否显式给出最少勾选数（区分缺省下限与强制下限） */
  minSelectExplicit: boolean;
  /** 收敛后的最多勾选数 */
  maxSelect: number;
}

/**
 * 依据选项实际数量收敛 min/max 边界
 * @param minRaw - 原始最少勾选数
 * @param maxRaw - 原始最多勾选数
 * @param optionCount - 题目选项总数
 * @returns `minSelect` 收敛至 `[0, optionCount]`，`maxSelect` 收敛至 `[minSelect, optionCount]`；`minSelectExplicit` 标记入参是否显式给出下限
 */
function clampSelectBounds(minRaw: number | undefined, maxRaw: number | undefined, optionCount: number): SelectBounds {
  const minSelectExplicit = minRaw !== undefined;
  const minSelect = clamp(minRaw ?? 1, 0, optionCount);
  const maxSelect = clamp(maxRaw ?? optionCount, minSelect, optionCount);
  return { minSelect, minSelectExplicit, maxSelect };
}

/** 待解析的显示条件（题目 ID 与选项标签尚未映射到索引） */
interface RawCondition {
  /** 被引用的题目 ID */
  readonly questionId: string;
  /** 被引用题目中的选项标签（可选） */
  readonly option?: string;
  /** 作答存在性（仅无 `option` 时生效） */
  readonly answered?: boolean;
}

/** `buildQuestion` 的中间产物：归一化题目与待解析的显示条件 */
interface PendingQuestion {
  /** 归一化题目（`showIf` 暂为空） */
  readonly question: NormalizedQuestion;
  /** 题目级待解析条件 */
  readonly questionConditions: RawCondition[];
  /** 选项级待解析条件（按选项索引对齐） */
  readonly optionConditions: RawCondition[][];
}

/**
 * 把 Schema 层的 `showIf`（单条件或条件数组）展开为待解析条件列表
 * @param input - 原始显示条件输入
 * @returns 待解析条件列表；未声明时为空数组
 */
function toRawConditions(input: ShowIfInput | undefined): RawCondition[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list.map((condition) => ({
    questionId: condition.questionId,
    option: condition.option,
    answered: condition.answered,
  }));
}

/**
 * 规整单个题目为标准数据结构
 * 全程对文本字段应用幂等 `cleanOptional` 兜底，绕过 sanitize 钩子直接构造模型时同样安全
 * @param q - 原始题目输入
 * @param index - 题目顺序索引（0-based），仅用于派生缺省 id 与标题
 * @returns id/title/label 为空时回退 `TEXTS.fallbacks`；`minSelect` / `maxSelect` 收敛至 `[0, options.length]` 且保证 `minSelect <= maxSelect`；`showIf` 留待 {@link resolveConditions} 解析
 */
function buildQuestion(q: QuestionInput, index: number): PendingQuestion {
  const expansion = q.expansion;
  return {
    question: {
      id: cleanOptional(q.id) ?? TEXTS.fallbacks.autoQuestionId(index + 1),
      title: cleanOptional(q.title) ?? TEXTS.fallbacks.autoQuestionTitle(index + 1),
      tabLabel: cleanOptional(q.tabLabel),
      description: cleanOptional(q.description),
      multiSelect: Boolean(q.multiSelect),
      ...clampSelectBounds(q.minSelect, q.maxSelect, q.options.length),
      options: q.options.map((o) => ({
        label: cleanOptional(o.label) ?? TEXTS.fallbacks.unnamedOptionLabel,
        description: cleanOptional(o.description),
        preview: cleanOptional(o.preview),
        customPlaceholder: cleanOptional(o.customPlaceholder),
        showIf: [],
      })),
      allowEmpty: Boolean(q.allowEmpty),
      allowCustom: q.allowCustom !== false,
      customPlaceholder: cleanOptional(q.customPlaceholder) ?? TEXTS.fallbacks.defaultCustomPlaceholder,
      showIf: [],
      expandOnConfirm: expansion !== false,
      expansionGuidance: typeof expansion === "object" ? cleanOptional(expansion.guidance) : undefined,
      expansionInsert: typeof expansion === "object" ? expansion.insert : undefined,
    },
    questionConditions: toRawConditions(q.showIf),
    optionConditions: q.options.map((o) => toRawConditions(o.showIf)),
  };
}

/**
 * 把待解析条件映射为题目索引与选项索引
 * @param raw - 待解析条件列表
 * @param ownerIndex - 条件所属题目的索引（条件只允许引用更早题目）
 * @param indexById - 题目 ID → 题目索引
 * @param questions - 归一化后的全部题目（用于按标签定位选项）
 * @returns 解析后的条件列表
 * @throws AdaptiveConditionError 引用未知题目、后置题目或不存在的选项时抛出
 */
function resolveConditions(
  raw: readonly RawCondition[],
  ownerIndex: number,
  indexById: ReadonlyMap<string, number>,
  questions: readonly NormalizedQuestion[],
): VisibilityCondition[] {
  return raw.map((condition): VisibilityCondition => {
    const questionId = cleanOptional(condition.questionId) ?? "";
    const questionIndex = indexById.get(questionId);
    if (questionIndex === undefined) {
      throw new AdaptiveConditionError(TEXTS.markdown.adaptiveErrors.unknownQuestion(questionId));
    }
    if (questionIndex >= ownerIndex) {
      throw new AdaptiveConditionError(TEXTS.markdown.adaptiveErrors.forwardQuestion(questionId));
    }
    const optionLabel = cleanOptional(condition.option);
    if (optionLabel === undefined) {
      return { kind: "answered", questionIndex, answered: condition.answered !== false };
    }
    const optionIndex = questions[questionIndex]?.options.findIndex((option) => option.label === optionLabel) ?? -1;
    if (optionIndex < 0) {
      throw new AdaptiveConditionError(TEXTS.markdown.adaptiveErrors.unknownOption(questionId, optionLabel));
    }
    return { kind: "option", questionIndex, optionIndex };
  });
}

/**
 * 构建并解析全部题目的显示条件
 * @param rawQuestions - 原始题目输入
 * @returns 题目 ID 唯一、条件已解析的题目列表
 * @throws AdaptiveConditionError 任一条件引用非法时抛出
 */
function buildQuestions(rawQuestions: readonly QuestionInput[]): NormalizedQuestion[] {
  const pending = rawQuestions.map((raw, index) => buildQuestion(raw, index));
  const questions = dedupeQuestionIds(pending.map((entry) => entry.question));
  const indexById = new Map(questions.map((question, index) => [question.id, index]));
  return questions.map((question, index) => {
    const conditions = pending[index];
    return {
      ...question,
      showIf: resolveConditions(conditions?.questionConditions ?? [], index, indexById, questions),
      options: question.options.map((option, optionIndex) => ({
        ...option,
        showIf: resolveConditions(conditions?.optionConditions[optionIndex] ?? [], index, indexById, questions),
      })),
    };
  });
}

/**
 * 把归一化选项投影为答卷条目选项（剥离显示条件等内部字段）
 * @param option - 归一化选项
 * @param customText - 该选项专属批注
 * @returns 仅含 Schema 选项字段的答卷选项
 */
function toAnswerOption(option: NormalizedOption, customText?: string): QuestionOption & { customText?: string } {
  const answer: QuestionOption & { customText?: string } = {
    label: option.label,
    description: option.description,
    preview: option.preview,
    customPlaceholder: option.customPlaceholder,
  };
  if (customText) answer.customText = customText;
  return answer;
}

/**
 * 去重题目 ID（跨题重复会让 `formatAnswers` 按 id 归题出错；重复项回退为顺序自动 ID，仍冲突时追加序号后缀）
 * @param questions - 归一化题目列表
 * @returns ID 全局唯一的题目列表
 */
function dedupeQuestionIds(questions: NormalizedQuestion[]): NormalizedQuestion[] {
  const used = new Set<string>();
  return questions.map((q, index) => {
    if (!used.has(q.id)) {
      used.add(q.id);
      return q;
    }
    let candidate = TEXTS.fallbacks.autoQuestionId(index + 1);
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${candidate}_${suffix}`;
    }
    used.add(candidate);
    return { ...q, id: candidate };
  });
}

/**
 * 封套注入消毒：折叠单行并归一化可击穿封套定界符的字符（封套以 ASCII 方括号与 `;` 承载结构语义）
 * 替换顺序：弯引号族 → `'`，ASCII 方括号 → 全角 `［］`，剥除 `【】`，ASCII `;` → 全角 `；`
 * @param text - 原始批注/描述/标签文本
 * @returns 令牌边界不可能被插值文本提前闭合或伪造的单行文本
 */
function sanitizeEnvelopeText(text: string): string {
  return toSingleLine(text)
    .replace(/[“”„‟«»]/g, "'")
    .replace(/[\[\]]/g, (bracket) => (bracket === "[" ? "［" : "］"))
    .replace(/[【】]/g, "")
    .replace(/;/g, "；");
}

/**
 * 把正文草稿与分镜头压缩为高密度单行指令：逐行剥离 Markdown 标题标识与引用符，折叠空白，片段以 `draftSegmentSeparator` 连接
 * @param preview - 原始草稿文本
 * @returns 单行分镜头指令；缺省、全空白或无有效片段时为 undefined
 */
function compressDraftPreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const cleaned = cleanText(preview);
  if (!cleaned.trim()) return undefined;

  const segments = cleaned
    .split("\n")
    .map((line) => {
      let l = line.trim();
      if (!l) return "";
      // 单次交替剥离行首任意层级的 Markdown 标题标识与引用符（`> # 标题` 需同时去除两类前缀，故不可分成两次行首替换）
      l = l.replace(/^(?:[>#]+\s*)+/, "");
      l = l.replace(/\s+/g, " ");
      return l;
    })
    .filter(Boolean);

  if (segments.length === 0) return undefined;
  return segments.join(TEXTS.markdown.draftSegmentSeparator);
}

/**
 * 把自动生成的占位题目标题替换为英文占位；非占位标题原样返回
 * 占位文案在 sanitize 与 {@link buildQuestion} 阶段即写入题目对象，结构上无法保留身份标记，故按生成函数的返回值比对
 * @param title - 答卷条目的题目标题
 * @param questionIndex - 题目顺序索引（0-based）；缺省表示无法定位
 * @returns 占位标题替换为 `TEXTS.markdown.fallbackQuestionTitle(questionIndex + 1)`
 */
function envelopeQuestionTitle(title: string, questionIndex: number | undefined): string {
  if (questionIndex === undefined) return title;
  const isPlaceholder =
    title === TEXTS.fallbacks.defaultQuestionTitle || title === TEXTS.fallbacks.autoQuestionTitle(questionIndex + 1);
  return isPlaceholder ? TEXTS.markdown.fallbackQuestionTitle(questionIndex + 1) : title;
}

/**
 * 把自动生成的占位选项标签替换为英文占位；非占位标签原样返回
 * 占位来源：`sanitize.ts` 的 `选项 N` / `默认方案`，{@link buildQuestion} 的 `未命名方案`
 * @param label - 选项标签
 * @param optionIndex1 - 选项序号（1-based，与占位标签的编号一致）；缺省表示无法定位
 * @returns 占位标签替换为 `TEXTS.markdown.fallbackOptionLabel(optionIndex1)`
 */
function envelopeOptionLabel(label: string, optionIndex1: number | undefined): string {
  if (optionIndex1 === undefined) return label;
  const isPlaceholder =
    label === TEXTS.fallbacks.unnamedOptionLabel ||
    label === TEXTS.fallbacks.defaultOptionLabel ||
    label === TEXTS.fallbacks.autoOptionLabel(optionIndex1);
  return isPlaceholder ? TEXTS.markdown.fallbackOptionLabel(optionIndex1) : label;
}

/**
 * 问卷数据模型：题目归一化、作答状态流转与答卷编译
 * 全部状态突变经本类的 mutation 方法完成并自动推进 `revision`，组件层只读
 */
export class AskAuthorFormModel {
  /** 问卷总标题 */
  readonly formTitle: string;
  /** 问卷全局背景阐述 */
  readonly formDescription?: string;
  /** 推演允许的题目总量上限（含初始题目） */
  readonly expansionMaxQuestions: number;
  /** 推演题目的插入位置预设（缺省为跟随触发题目） */
  readonly expansionInsert: InsertPosition;

  /** 归一化后的题目列表（推演会向末尾追加，外部只读） */
  private readonly questionList: NormalizedQuestion[];

  /** 推演追加记录栈（按追加顺序；撤回时从栈顶开始） */
  private readonly expansions: ExpansionRecord[] = [];

  /** 作答状态版本号：单调递增，作为组件层派生缓存的失效键 */
  private revisionValue = 0;

  /** 各题作答状态映射（题目索引 0-based） */
  private readonly states = new Map<number, QuestionAnswerState>();

  /** 整卷自由补充（提交页填写，独立于各题作答状态） */
  private formNoteValue?: string;

  /** 显隐快照缓存（按 `revision` 失效；含题目可见性、选项可见性与可见选中项） */
  private visibilityCache?: { revision: number; questions: boolean[]; options: boolean[][]; selected: number[][] };

  /**
   * 构造问卷数据模型实例（单题平铺与批量问卷两模式归一化）
   * @param rawParams - 经 prepareArguments 规整的入参；`questions` 缺省或为空时回退单题平铺模式，`options` 亦为空则题目列表为空
   */
  constructor(rawParams: RawParams) {
    const rawQuestions = rawParams.questions ?? [];
    const isBatch = rawQuestions.length > 0;
    this.formTitle = cleanOptional(rawParams.formTitle) ?? TEXTS.fallbacks.defaultFormTitle;
    this.formDescription = cleanOptional(rawParams.description);
    this.expansionMaxQuestions = clamp(rawParams.expansion?.maxQuestions ?? MAX_QUESTIONS, 1, MAX_QUESTIONS);
    this.expansionInsert = rawParams.expansion?.insert ?? "follow";

    if (isBatch) {
      this.questionList = buildQuestions(rawQuestions);
    } else if (rawParams.options?.length) {
      this.questionList = buildQuestions([
        {
          title: cleanOptional(rawParams.question) ?? TEXTS.fallbacks.defaultQuestionTitle,
          description: cleanOptional(rawParams.description),
          multiSelect: rawParams.multiSelect,
          minSelect: rawParams.minSelect,
          maxSelect: rawParams.maxSelect,
          allowEmpty: rawParams.allowEmpty,
          options: rawParams.options,
          allowCustom: rawParams.allowCustom,
          customPlaceholder: rawParams.customPlaceholder,
        },
      ]);
    } else {
      this.questionList = [];
    }

    // 自定义插入锚点在构建期校验：拼写错误在构造阶段就变成结构化错误
    this.resolveInsertIndex(this.expansionInsert);
    for (const question of this.questionList) {
      if (question.expansionInsert) this.resolveInsertIndex(question.expansionInsert);
    }
  }

  /** 归一化后的题目列表（推演会插入新题目，调用方只读） */
  get questions(): NormalizedQuestion[] {
    return this.questionList;
  }

  /**
   * 获取指定题目的推演配置（题目级设置优先，缺省沿用表单级）
   * 推演题目带有未知锚点时，首次确认该题时再抛出（此时尚未改动任何题目）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 插入位置、可读描述与题目级方向指示；题目越界或该题不开推演时为 undefined
   */
  expansionConfigFor(qIndex: number): { insert: InsertPosition; insertLabel: string; guidance?: string } | undefined {
    const question = this.questionList[qIndex];
    if (!question || !question.expandOnConfirm) return undefined;
    const insert = question.expansionInsert ?? this.expansionInsert;
    return { insert, insertLabel: this.insertLabel(insert), guidance: question.expansionGuidance };
  }

  /**
   * 生成插入位置的可读描述
   * @param insert - 插入位置预设
   * @returns 供推演模型判定哪些题目位于插入点之前的英文描述
   */
  private insertLabel(insert: InsertPosition): string {
    if (insert === "follow") return "right after the question the author just confirmed";
    if (insert === "tail") return "at the end of the form";
    return `right after question "${insert.after}"`;
  }

  /** 当前作答状态版本号（组件层派生缓存失效键） */
  get revision(): number {
    return this.revisionValue;
  }

  /** 整卷自由补充（未填写时为 undefined） */
  get formNote(): string | undefined {
    return this.formNoteValue;
  }

  /** 问卷题目总数 */
  get questionCount(): number {
    return this.questions.length;
  }

  /**
   * 获取指定索引的归一化题目
   * @param index - 题目顺序索引（0-based）
   * @returns 归一化题目对象；索引越界时为 undefined
   */
  getQuestion(index: number): NormalizedQuestion | undefined {
    return this.questions[index];
  }

  /**
   * 获取指定题目的作答状态（懒加载单例）
   * 不校验题目边界：越界索引同样创建并缓存空状态（调用方须先经 {@link getQuestion} 校验）
   * @param index - 题目顺序索引（0-based）
   * @returns 该题目的状态引用，可写入，同一索引恒返回同一对象；首次创建不改变可观察作答语义、不推进 `revision`
   */
  getState(index: number): QuestionAnswerState {
    let st = this.states.get(index);
    if (!st) {
      st = { selectedIndices: new Set<number>(), optionNotes: new Map<number, string>() };
      this.states.set(index, st);
    }
    return st;
  }

  /**
   * 获取当前显隐快照（按 `revision` 缓存，题目顺序一次正向计算）
   * 条件只允许引用更早题目，被引用题目自身不可见时引用它的条件恒不成立
   * @returns 题目可见性、各题选项可见性与各题可见选中项索引（升序）
   */
  private snapshot(): { questions: boolean[]; options: boolean[][]; selected: number[][] } {
    const cached = this.visibilityCache;
    if (cached && cached.revision === this.revisionValue) return cached;

    const questions: boolean[] = [];
    const options: boolean[][] = [];
    const selected: number[][] = [];

    for (const [index, q] of this.questions.entries()) {
      const questionVisible = q.showIf.every((condition) => this.conditionHolds(condition, questions, selected));
      const optionVisible = q.options.map((option) =>
        option.showIf.every((condition) => this.conditionHolds(condition, questions, selected)),
      );
      const st = this.states.get(index);
      const selectedIndices: number[] = [];
      if (st) {
        if (q.multiSelect) {
          for (const optionIndex of st.selectedIndices) {
            if (optionVisible[optionIndex]) selectedIndices.push(optionIndex);
          }
        } else if (st.selectedIndex !== undefined && optionVisible[st.selectedIndex]) {
          selectedIndices.push(st.selectedIndex);
        }
      }
      selectedIndices.sort((a, b) => a - b);

      questions.push(questionVisible);
      options.push(optionVisible);
      selected.push(selectedIndices);
    }

    this.visibilityCache = { revision: this.revisionValue, questions, options, selected };
    return this.visibilityCache;
  }

  /**
   * 判定单个显示条件是否成立
   * @param condition - 已解析的条件
   * @param questions - 下标小于当前题的题目可见性
   * @param selected - 下标小于当前题的可见选中项
   * @returns 被引用题目不可见时为 false；否则按选项选中态或作答存在性判定
   */
  private conditionHolds(
    condition: VisibilityCondition,
    questions: readonly boolean[],
    selected: readonly number[][],
  ): boolean {
    if (!questions[condition.questionIndex]) return false;
    if (condition.kind === "answered") return this.hasAnyResponse(condition.questionIndex) === condition.answered;
    return (selected[condition.questionIndex] ?? []).includes(condition.optionIndex);
  }

  /**
   * 判定指定题目是否留下过作答痕迹（已选选项或非空批注，不区分选项当前是否可见）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 存在任意痕迹时为 true；状态未创建时为 false
   */
  hasAnyResponse(qIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st) return false;
    return st.selectedIndex !== undefined || st.selectedIndices.size > 0 || hasAnyNote(st);
  }

  /**
   * 判定指定题目是否可见
   * @param index - 题目顺序索引（0-based）
   * @returns 无显示条件或全部条件成立时为 true；索引越界为 false
   */
  isQuestionVisible(index: number): boolean {
    return this.snapshot().questions[index] ?? false;
  }

  /**
   * 判定指定选项是否可见
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 选项索引（0-based）
   * @returns 无显示条件或全部条件成立时为 true；索引越界为 false
   */
  isOptionVisible(qIndex: number, optionIndex: number): boolean {
    return this.snapshot().options[qIndex]?.[optionIndex] ?? false;
  }

  /**
   * 获取当前可见题目索引
   * @returns 升序索引数组；题目列表非空时恒非空（第一题无前置题目可引用）
   */
  getVisibleQuestionIndices(): number[] {
    const { questions } = this.snapshot();
    const indices: number[] = [];
    for (const [index, visible] of questions.entries()) {
      if (visible) indices.push(index);
    }
    return indices;
  }

  /**
   * 获取已勾选且当前可见的选项索引（0-based 升序，未作答为空数组；排序不变量唯一实现在此）
   * 选项因条件失效而隐藏时，其既有勾选不计入作答与答卷；条件恢复后重新生效
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 新数组（调用方可安全持有）；题目越界或状态未创建时为空数组
   */
  getSelectedIndices(qIndex: number): number[] {
    return [...(this.snapshot().selected[qIndex] ?? [])];
  }

  /**
   * 获取单选选中项索引（可见选中项为空时 undefined）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 首个可见选中项索引；未选中、选中项已隐藏或索引越界时为 undefined
   */
  getSelectedIndex(qIndex: number): number | undefined {
    return this.snapshot().selected[qIndex]?.[0];
  }

  /** 推进作答状态版本号（全部 mutation 方法的统一出口） */
  private bumpRevision(): void {
    this.revisionValue++;
  }

  // ===== 实时推演 mutation API（作者确认答案后由组件层调用） =====

  /**
   * 获取推演追加记录快照
   * @returns 按追加顺序排列的新数组（调用方可安全持有）
   */
  getExpansions(): readonly ExpansionRecord[] {
    return [...this.expansions];
  }

  /**
   * 计算指定题目的答案签名（判断该题推演结果是否仍然有效）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 可见选中项标签按索引升序以 `|` 拼接的签名；未作答或题目不存在时为 undefined
   */
  answerSignature(qIndex: number): string | undefined {
    const q = this.questionList[qIndex];
    if (!q) return undefined;
    const indices = this.getSelectedIndices(qIndex);
    if (indices.length === 0) return undefined;
    return indices.map((index) => q.options[index]?.label ?? "").join("|");
  }

  /**
   * 计算推演题目的插入位置
   * @param insert - 插入位置预设（跟随触发题目 / 队尾 / 指定题目之后）
   * @param triggerIndex - 触发推演的题目索引（0-based，仅 `follow` 使用）
   * @returns 插入位置（0-based；`questionList.length` 表示队尾）
   * @throws AdaptiveConditionError 自定义锚点引用的题目不存在时抛出
   */
  private resolveInsertIndex(insert: InsertPosition, triggerIndex = 0): number {
    if (insert === "tail") return this.questionList.length;
    if (insert === "follow") return Math.min(triggerIndex + 1, this.questionList.length);
    const anchor = cleanOptional(insert.after) ?? "";
    const index = this.questionList.findIndex((question) => question.id === anchor);
    if (index < 0) throw new AdaptiveConditionError(TEXTS.markdown.adaptiveErrors.unknownInsertAnchor(anchor));
    return index + 1;
  }

  /**
   * 写入一次推演结果（新题目按 `insert` 指定位置插入，新选项追加到目标题目末尾）
   * @param input - 记录元数据与推演载荷；`insert` 缺省使用表单级插入位置，超出 {@link expansionMaxQuestions} 的新题目被截断
   * @returns 本次追加记录（无实际追加时计数均为 0，记录仍入栈以标记该答案已推演）
   * @throws AdaptiveConditionError 追加内容的条件引用非法时抛出（本次追加整体不生效）
   */
  pushExpansion(input: {
    questionIndex: number;
    signature: string;
    insert?: InsertPosition;
    payload: ExpansionPayload;
  }): ExpansionRecord {
    const room = Math.max(0, this.expansionMaxQuestions - this.questionList.length);
    const insertAt = this.resolveInsertIndex(input.insert ?? this.expansionInsert, input.questionIndex);
    const addedQuestions = this.insertQuestions(insertAt, input.payload.questions.slice(0, room));
    const addedOptions = this.appendOptions(input.payload.optionAdditions);
    const record: ExpansionRecord = {
      questionIndex: input.questionIndex,
      signature: input.signature,
      insertAt,
      addedQuestions,
      addedOptions,
    };
    this.expansions.push(record);
    if (addedQuestions > 0 || addedOptions.length > 0) this.bumpRevision();
    return record;
  }

  /**
   * 撤回指定题目及其后续题目的推演结果（作者改动答案后调用）
   * @param questionIndex - 起始题目索引（0-based）；触发题目不早于该索引的记录全部撤回
   * @returns 撤回的记录数；无记录被撤回时为 0（状态与 `revision` 均不变）
   */
  retractFrom(questionIndex: number): number {
    let removed = 0;
    while (this.expansions.length > 0) {
      const top = this.expansions[this.expansions.length - 1];
      if (!top || top.questionIndex < questionIndex) break;
      this.expansions.pop();
      this.rollback(top);
      removed++;
    }
    if (removed > 0) this.bumpRevision();
    return removed;
  }

  /**
   * 判定指定题目在确认时是否会发起实时推演
   * 条件：表单开启推演、该题声明参与推演且可见、题目总数未达上限、该答案尚未推演过
   * @param qIndex - 题目顺序索引（0-based）
   * @param enabled - 本表单是否开启推演（由组件层持有）
   * @returns 确认本题将发起新的推演请求时为 true
   */
  canExpandOnConfirm(qIndex: number, enabled: boolean): boolean {
    if (!enabled) return false;
    if (!this.questionList[qIndex]?.expandOnConfirm) return false;
    if (!this.isQuestionVisible(qIndex)) return false;
    if (this.questionList.length >= this.expansionMaxQuestions) return false;
    const signature = this.answerSignature(qIndex);
    if (signature === undefined) return true;
    return this.expansions.find((record) => record.questionIndex === qIndex)?.signature !== signature;
  }

  /**
   * 归一化并在指定位置插入新题目（全部条件先校验，任一非法项抛出时整个批次不生效）
   * @param at - 插入位置（原有索引不小于该值的题目整体后移）
   * @param raws - 推演给出的原始题目
   * @returns 实际插入的题目数
   */
  private insertQuestions(at: number, raws: readonly QuestionInput[]): number {
    if (raws.length === 0) return 0;
    const used = new Set(this.questionList.map((question) => question.id));
    const pending: PendingQuestion[] = raws.map((raw, offset) => {
      const index = at + offset;
      const built = buildQuestion(raw, index);
      const id = this.uniqueQuestionId(built.question.id, index, used);
      return { ...built, question: { ...built.question, id } };
    });

    // 先在未改动的题目列表上试算插入后的索引，条件全部合法后才让既有题目、作答状态与推演记录让位
    const scoped = [
      ...this.questionList.slice(0, at),
      ...pending.map((entry) => entry.question),
      ...this.questionList.slice(at),
    ];
    const indexById = new Map(scoped.map((question, index) => [question.id, index]));
    const inserted = pending.map((entry, offset) => {
      const index = at + offset;
      const question = entry.question;
      return {
        ...question,
        showIf: resolveConditions(entry.questionConditions, index, indexById, scoped),
        options: question.options.map((option, optionIndex) => ({
          ...option,
          showIf: resolveConditions(entry.optionConditions[optionIndex] ?? [], index, indexById, scoped),
        })),
      };
    });

    this.remapQuestionIndices(at, pending.length);
    this.questionList.splice(at, 0, ...inserted);
    return inserted.length;
  }

  /**
   * 把索引不小于指定值的题目引用整体平移（插入或移除题目后维持条件、作答状态与推演记录的指向）
   * @param from - 起始索引（0-based）
   * @param delta - 位移量（插入为正、移除为负）
   */
  private remapQuestionIndices(from: number, delta: number): void {
    const remap = (index: number): number => (index >= from ? index + delta : index);

    for (const [index, question] of this.questionList.entries()) {
      this.questionList[index] = {
        ...question,
        showIf: question.showIf.map((condition) => ({ ...condition, questionIndex: remap(condition.questionIndex) })),
        options: question.options.map((option) => ({
          ...option,
          showIf: option.showIf.map((condition) => ({ ...condition, questionIndex: remap(condition.questionIndex) })),
        })),
      };
    }

    const states = new Map<number, QuestionAnswerState>();
    for (const [index, state] of this.states) states.set(remap(index), state);
    this.states.clear();
    for (const [index, state] of states) this.states.set(index, state);

    for (const [position, record] of this.expansions.entries()) {
      this.expansions[position] = {
        ...record,
        questionIndex: remap(record.questionIndex),
        insertAt: remap(record.insertAt),
        addedOptions: record.addedOptions.map((addition) => ({
          ...addition,
          questionIndex: remap(addition.questionIndex),
        })),
      };
    }
  }

  /**
   * 向既有题目追加选项（全部条件先校验，任一非法项抛出时整个批次不生效）
   * @param additions - 按题目 ID 归集的追加选项
   * @returns 每题实际追加的选项数
   */
  private appendOptions(additions: readonly OptionAddition[]): { questionIndex: number; count: number }[] {
    if (additions.length === 0) return [];
    const indexById = new Map(this.questionList.map((question, index) => [question.id, index]));

    const staged: { questionIndex: number; options: NormalizedOption[] }[] = [];
    for (const addition of additions) {
      const questionIndex = indexById.get(addition.questionId);
      if (questionIndex === undefined) continue;
      staged.push({
        questionIndex,
        options: addition.options.map((option) => ({
          label: option.label,
          description: option.description,
          preview: option.preview,
          customPlaceholder: option.customPlaceholder,
          showIf: resolveConditions(toRawConditions(option.showIf), questionIndex, indexById, this.questionList),
        })),
      });
    }

    const added: { questionIndex: number; count: number }[] = [];
    for (const entry of staged) {
      const q = this.questionList[entry.questionIndex];
      if (!q || entry.options.length === 0) continue;
      const options = [...q.options, ...entry.options];
      const bounds = clampSelectBounds(
        q.minSelectExplicit ? q.minSelect : undefined,
        q.maxSelect === q.options.length ? undefined : q.maxSelect,
        options.length,
      );
      this.questionList[entry.questionIndex] = { ...q, options, ...bounds };
      added.push({ questionIndex: entry.questionIndex, count: entry.options.length });
    }
    return added;
  }

  /**
   * 回滚单条推演记录（先回滚选项追加，再移除插入的题目块）
   * @param record - 待回滚的推演记录
   */
  private rollback(record: ExpansionRecord): void {
    for (const addition of [...record.addedOptions].reverse()) {
      const q = this.questionList[addition.questionIndex];
      if (!q) continue;
      const options = q.options.slice(0, Math.max(0, q.options.length - addition.count));
      const bounds = clampSelectBounds(q.minSelectExplicit ? q.minSelect : undefined, q.maxSelect, options.length);
      this.questionList[addition.questionIndex] = { ...q, options, ...bounds };
      this.dropOptionsFromState(addition.questionIndex, options.length);
    }

    if (record.addedQuestions > 0) {
      const at = record.insertAt;
      this.questionList.splice(at, record.addedQuestions);
      for (let index = at; index < at + record.addedQuestions; index++) this.states.delete(index);
      this.remapQuestionIndices(at, -record.addedQuestions);
    }
  }

  /**
   * 剪除被移除选项上的选中与批注状态
   * @param questionIndex - 题目顺序索引（0-based）
   * @param keptCount - 保留的选项数
   */
  private dropOptionsFromState(questionIndex: number, keptCount: number): void {
    const st = this.states.get(questionIndex);
    if (!st) return;
    for (const index of [...st.selectedIndices]) {
      if (index >= keptCount) st.selectedIndices.delete(index);
    }
    if (st.selectedIndex !== undefined && st.selectedIndex >= keptCount) st.selectedIndex = undefined;
    for (const index of [...st.optionNotes.keys()]) {
      if (index >= keptCount) st.optionNotes.delete(index);
    }
  }

  /**
   * 生成不与既有题目重复的题目 ID
   * @param id - 推演给出的原始 ID（可为自动占位）
   * @param index - 题目顺序索引（0-based）
   * @param used - 已占用的 ID 集合（就地更新）
   * @returns 未占用的题目 ID
   */
  private uniqueQuestionId(id: string, index: number, used: Set<string>): string {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let candidate = TEXTS.fallbacks.autoQuestionId(index + 1);
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${candidate}_${suffix}`;
    used.add(candidate);
    return candidate;
  }

  /**
   * 派生指定题目的选项菜单项
   * 只产出可见预设选项，顺序与声明一致；题目级补充入口与确认推进是选项列表之后的按钮，由 {@link getQuestionActions} 提供文案
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 选项菜单项数组；题目不存在为空数组
   */
  getMenuItems(qIndex: number): MenuItem[] {
    const q = this.getQuestion(qIndex);
    if (!q) return [];
    const items: MenuItem[] = [];
    for (const [optionIndex, opt] of q.options.entries()) {
      if (!this.isOptionVisible(qIndex, optionIndex)) continue;
      items.push({ optionIndex, label: opt.label, description: opt.description, preview: opt.preview });
    }
    return items;
  }

  /**
   * 派生题目底部操作按钮的文案
   * 确认按钮的明细随作答状态派生：多选展示已选数/下限，单选展示已选项标签、自定义方案名或未选
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 补充说明与确认推进按钮文案；题目不存在时为 undefined
   */
  getQuestionActions(qIndex: number): QuestionActions | undefined {
    const q = this.getQuestion(qIndex);
    if (!q) return undefined;
    const noted = this.hasSubmittableNote(qIndex);
    const selectedIndex = this.getSelectedIndex(qIndex);
    const confirmDetail = q.multiSelect
      ? TEXTS.menu.confirmDetailMulti(this.getSelectedIndices(qIndex).length, q.minSelect)
      : selectedIndex !== undefined
        ? (q.options[selectedIndex]?.label ?? TEXTS.fallbacks.unselectedOption)
        : noted
          ? TEXTS.fallbacks.defaultCustomChoiceName
          : TEXTS.fallbacks.unselectedOption;
    return {
      note: q.allowCustom
        ? hasQuestionNote(this.getState(qIndex))
          ? TEXTS.menu.customNoteLabelFilled
          : TEXTS.menu.customNoteLabel
        : undefined,
      confirm: TEXTS.menu.confirmLabel(confirmDetail, noted),
    };
  }

  /**
   * 判定指定题目是否存在会被提交的批注（题目级批注或可见选项上的批注）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 存在非空批注时为 true；状态未创建时为 false
   */
  private hasSubmittableNote(qIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st) return false;
    if (st.customText?.trim()) return true;
    for (const [optionIndex, note] of st.optionNotes) {
      if (note?.trim() && this.isOptionVisible(qIndex, optionIndex)) return true;
    }
    return false;
  }

  /**
   * 判定指定题目是否满足作答下限
   * 单选：已选一项、`allowEmpty`，或 `allowCustom` 且存在非空批注；多选：勾选数达 `minSelect`、`allowEmpty` 下 0 选，或未显式给出下限时 0 选且 `allowCustom` 并存在非空批注
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 题目不存在或当前不可见时恒为 false；状态未加载时按空作答判定，不写入状态
   */
  isQuestionAnswered(qIndex: number): boolean {
    const q = this.questions[qIndex];
    if (!q || !this.isQuestionVisible(qIndex)) return false;

    if (!q.multiSelect) {
      return (
        this.getSelectedIndex(qIndex) !== undefined ||
        q.allowEmpty ||
        (q.allowCustom && this.hasSubmittableNote(qIndex))
      );
    }

    const count = this.getSelectedIndices(qIndex).length;
    if (count >= q.minSelect) return true;
    if (count === 0 && q.allowEmpty) return true;
    // 缺省下限（未显式指定 minSelect）未勾选时，填写批注可直接提交
    if (!q.minSelectExplicit && count === 0 && q.allowCustom && this.hasSubmittableNote(qIndex)) return true;

    return false;
  }

  /**
   * 判定问卷中当前可见的题目是否均已作答完毕（隐藏题目不参与判定）
   * @returns 所有可见题目均满足 {@link isQuestionAnswered} 时为 true；无可见题目时恒为 true
   */
  areAllQuestionsAnswered(): boolean {
    return this.getVisibleQuestionIndices().every((index) => this.isQuestionAnswered(index));
  }

  // ===== 作答状态 mutation API（组件层唯一合法入口，全部自动推进 revision） =====

  /**
   * 切换指定选项勾选状态（空格键主路径；单选再次触发取消，多选达上限拒绝新增）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @returns `selected` / `deselected` / `limit`（题目或选项不存在、多选已达上限且未勾选时返回 `limit` 且不推进 `revision`）
   */
  toggleOption(qIndex: number, optionIndex: number): ToggleResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return "limit";
    const st = this.getState(qIndex);

    if (!q.multiSelect) {
      st.selectedIndex = st.selectedIndex === optionIndex ? undefined : optionIndex;
      this.bumpRevision();
      return st.selectedIndex === undefined ? "deselected" : "selected";
    }

    if (st.selectedIndices.has(optionIndex)) {
      st.selectedIndices.delete(optionIndex);
      this.bumpRevision();
      return "deselected";
    }
    if (this.getSelectedIndices(qIndex).length >= q.maxSelect) return "limit";
    st.selectedIndices.add(optionIndex);
    this.bumpRevision();
    return "selected";
  }

  /**
   * 确认路径下的选项写入（Enter / Ctrl+S 推进确认；单选直接更改选择，多选未达上限时补充勾选，仅真实变更推进 `revision`）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   */
  commitOption(qIndex: number, optionIndex: number): void {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return;
    const st = this.getState(qIndex);

    if (!q.multiSelect) {
      if (st.selectedIndex !== optionIndex) {
        st.selectedIndex = optionIndex;
        this.bumpRevision();
      }
      return;
    }
    if (st.selectedIndices.has(optionIndex) || this.getSelectedIndices(qIndex).length >= q.maxSelect) return;
    st.selectedIndices.add(optionIndex);
    this.bumpRevision();
  }

  /**
   * 多选全选或一键清空（`a` 键）：勾选数达到上限时清空，否则按选项顺序填充至上限（保留既有勾选，恒满足 `size <= maxSelect`）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns `cleared` / `filled`（题目不存在或非多选时返回 `cleared` 且不推进 `revision`）
   */
  selectAllOrClear(qIndex: number): SelectAllResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.multiSelect) return "cleared";
    const st = this.getState(qIndex);

    if (this.getSelectedIndices(qIndex).length >= q.maxSelect) {
      st.selectedIndices.clear();
      this.bumpRevision();
      return "cleared";
    }
    let selectedCount = this.getSelectedIndices(qIndex).length;
    for (const [optionIndex] of q.options.entries()) {
      if (selectedCount >= q.maxSelect) break;
      if (!this.isOptionVisible(qIndex, optionIndex) || st.selectedIndices.has(optionIndex)) continue;
      st.selectedIndices.add(optionIndex);
      selectedCount++;
    }
    this.bumpRevision();
    return "filled";
  }

  /**
   * 保存或清空选项专属批注（空文本视为清除；单选无选中项时随批注勾选，已有其他选中项仅附加批注不更改选择；多选已满且未勾选仅保存批注）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @param text - 批注内容（空视为清除）
   * @returns `saved` / `cleared` / `savedUnselected` / `savedAtLimit`（题目或选项不存在时返回 `cleared` 且不推进 `revision`）
   */
  setOptionNote(qIndex: number, optionIndex: number, text: string): NoteSaveResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return "cleared";
    const st = this.getState(qIndex);
    const cleaned = cleanOptional(text);
    this.bumpRevision();

    if (!cleaned) {
      st.optionNotes.delete(optionIndex);
      return "cleared";
    }
    st.optionNotes.set(optionIndex, cleaned);

    if (q.multiSelect) {
      if (this.getSelectedIndices(qIndex).includes(optionIndex)) return "saved";
      if (this.getSelectedIndices(qIndex).length >= q.maxSelect) return "savedAtLimit";
      st.selectedIndices.add(optionIndex);
      return "saved";
    }
    if (st.selectedIndex === undefined) {
      st.selectedIndex = optionIndex;
      return "saved";
    }
    return st.selectedIndex === optionIndex ? "saved" : "savedUnselected";
  }

  /**
   * 保存或清空题目整体补充说明（空文本视为清空）
   * 不校验题目边界：越界索引同样经 {@link getState} 创建并写入状态
   * @param qIndex - 题目顺序索引（0-based）
   * @param text - 批注内容（经 `cleanOptional` 归一）
   * @returns `saved` / `cleared`；无论是否发生实际变更均推进 `revision`
   */
  setQuestionNote(qIndex: number, text: string): "saved" | "cleared" {
    const st = this.getState(qIndex);
    const cleaned = cleanOptional(text);
    st.customText = cleaned;
    this.bumpRevision();
    return cleaned ? "saved" : "cleared";
  }

  /**
   * 清空指定选项的专属批注（`x` 键路径；不存在时状态不变）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @returns 实际删除到条目时为 true（并推进 `revision`）；否则为 false（状态与 `revision` 均不变）
   */
  clearOptionNote(qIndex: number, optionIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st?.optionNotes.has(optionIndex)) return false;
    st.optionNotes.delete(optionIndex);
    this.bumpRevision();
    return true;
  }

  /**
   * 清空题目整体补充说明（`x` 键路径；不存在时状态不变）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 题目级批注去空白后非空并被清空时为 true（并推进 `revision`）；否则为 false（状态与 `revision` 均不变）
   */
  clearQuestionNote(qIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st?.customText?.trim()) return false;
    st.customText = undefined;
    this.bumpRevision();
    return true;
  }

  /**
   * 保存或清空整卷自由补充（空文本视为清空）
   * @param text - 补充内容（经 `cleanOptional` 归一）
   * @returns `saved` / `cleared`；无论是否发生实际变更均推进 `revision`
   */
  setFormNote(text: string): "saved" | "cleared" {
    const cleaned = cleanOptional(text);
    this.formNoteValue = cleaned;
    this.bumpRevision();
    return cleaned ? "saved" : "cleared";
  }

  /**
   * 清空整卷自由补充（`x` 键路径；不存在时状态不变）
   * @returns 补充去空白后非空并被清空时为 true（并推进 `revision`）；否则为 false（状态与 `revision` 均不变）
   */
  clearFormNote(): boolean {
    if (!this.formNoteValue?.trim()) return false;
    this.formNoteValue = undefined;
    this.bumpRevision();
    return true;
  }

  /**
   * 收集全部非空选项批注（含未选中选项上的孤立批注，跳过不可见选项），键转换为 1-based，与总览页一致
   * @param qIndex - 题目顺序索引（0-based）
   * @param q - 归一化题目对象
   * @param st - 题目作答状态
   * @returns 1-based 选项索引 → 批注内容的映射表
   */
  private collectOptionNotes(
    qIndex: number,
    q: NormalizedQuestion,
    st: QuestionAnswerState | undefined,
  ): Record<number, string> {
    const optNotes: Record<number, string> = {};
    if (!st) return optNotes;
    for (const [idx, note] of st.optionNotes) {
      const cleaned = cleanOptional(note);
      if (cleaned && q.options[idx] && this.isOptionVisible(qIndex, idx)) {
        optNotes[idx + 1] = cleaned;
      }
    }
    return optNotes;
  }

  /**
   * 编译当前可见题目的作答状态为答卷条目列表（隐藏题目不产出条目）
   * 多选题目恒产出条目；单选题目仅在已作答时产出条目（已选一项、`allowEmpty` 主动跳过或仅批注提交）
   * @returns 与题目顺序一致的条目列表；无已作答题目时为空数组
   */
  compileAnswers(): AuthorAnswerItem[] {
    const answers: AuthorAnswerItem[] = [];

    for (const [i, q] of this.questions.entries()) {
      if (!this.isQuestionVisible(i)) continue;
      const st = this.states.get(i);
      const customText = st?.customText?.trim() ? cleanText(st.customText.trim()) : undefined;
      const base = { questionId: q.id, questionTitle: q.title, customText };

      if (q.multiSelect) {
        const selectedIdxs = this.getSelectedIndices(i);
        const optNotes = this.collectOptionNotes(i, q, st);
        const selectedOptions: Array<QuestionOption & { customText?: string }> = [];

        for (const idx of selectedIdxs) {
          const opt = q.options[idx];
          if (!opt) continue;
          selectedOptions.push(toAnswerOption(opt, optNotes[idx + 1]));
        }

        const hasNotes = Object.keys(optNotes).length > 0;
        answers.push({
          ...base,
          multiSelect: true,
          selectedOptions,
          selectedIndices: selectedIdxs.map((idx) => idx + 1),
          optionNotes: hasNotes ? optNotes : undefined,
        });
      } else {
        const selectedIndex = this.getSelectedIndex(i);
        if (selectedIndex !== undefined) {
          const opt = q.options[selectedIndex];
          const optNotes = this.collectOptionNotes(i, q, st);

          answers.push({
            ...base,
            multiSelect: false,
            selectedOption: opt ? toAnswerOption(opt, optNotes[selectedIndex + 1]) : undefined,
            selectedOptionIndex: selectedIndex + 1,
            optionNotes: Object.keys(optNotes).length > 0 ? optNotes : undefined,
          });
        } else if (this.isQuestionAnswered(i)) {
          // 无选项勾选的显式决策（仅批注提交或 allowEmpty 主动跳过）必须产出条目，否则 LLM 无法区分主动跳过与问题未曾提出
          const optNotes = this.collectOptionNotes(i, q, st);
          const hasNotes = Object.keys(optNotes).length > 0;
          answers.push({ ...base, multiSelect: false, optionNotes: hasNotes ? optNotes : undefined });
        }
      }
    }

    return answers;
  }

  /**
   * 编译答案为确定性的 Markdown 封套文本
   * 插值文本经 {@link sanitizeEnvelopeText} 消毒，模板注入的令牌边界不可能被提前闭合或伪造
   * 片段顺序固定为：已选项（升序）→ 未选中选项的孤立批注（整数键升序）→ 题目级批注
   * 整卷补充作为作答行之后、收尾指令之前的独立令牌行输出；无补充时封套字节不变
   * 占位题目与标签经 {@link envelopeQuestionTitle} / {@link envelopeOptionLabel} 替换为英文，其余作者文本原样保留
   * @param answers - 答卷列表（通常来自 {@link compileAnswers}）
   * @returns `envelopePrefix` + 逐题一行（1-based 序号 + 标题 + `; ` 连接的片段）+ 可选的整卷补充行 + `envelopeSuffix`；两者均空时退化为空答卷封套
   */
  formatAnswers(answers: AuthorAnswerItem[]): string {
    const supplementLine = this.formNoteValue?.trim()
      ? TEXTS.markdown.supplementLine(sanitizeEnvelopeText(this.formNoteValue.trim()))
      : undefined;

    if (answers.length === 0 && !supplementLine) {
      return `${TEXTS.markdown.envelopePrefix}\n${TEXTS.markdown.envelopeEmpty}\n${TEXTS.markdown.envelopeSuffix}`;
    }

    /** 包装批注为 `[Author note: …]` 令牌（空串返回空串，先经 `sanitizeEnvelopeText` 消毒） */
    const noteToken = (text: string): string =>
      text ? `${TEXTS.markdown.notePrefix}${sanitizeEnvelopeText(text)}${TEXTS.markdown.noteSuffix}` : "";
    /** 包装已压缩草稿为 `[Draft directive: …]` 令牌（缺省或空串返回空串，先经 `sanitizeEnvelopeText` 消毒） */
    const directiveToken = (draft?: string): string =>
      draft
        ? `${TEXTS.markdown.draftDirectivePrefix}${sanitizeEnvelopeText(draft)}${TEXTS.markdown.draftDirectiveSuffix}`
        : "";

    const questionIndexById = new Map(this.questions.map((q, index) => [q.id, index]));

    const answerLines = answers.map((ans, i) => {
      const questionIndex = questionIndexById.get(ans.questionId);
      const selected = ans.multiSelect ? (ans.selectedOptions ?? []) : ans.selectedOption ? [ans.selectedOption] : [];
      // 封套逐行编号要求单行结构：标签、推演、批注统一折叠换行，避免多行内容破坏封套格式
      const parts = selected.map((o, j) => {
        const compressedDraft = compressDraftPreview(o.preview);
        const optNote = noteToken(cleanOptional(o.customText) ?? "");
        const optionIndex1 = ans.multiSelect ? ans.selectedIndices?.[j] : ans.selectedOptionIndex;
        const label = sanitizeEnvelopeText(envelopeOptionLabel(o.label, optionIndex1));
        const desc = sanitizeEnvelopeText(o.description ?? "");
        return desc
          ? TEXTS.markdown.optionWithDesc(label, desc, directiveToken(compressedDraft), optNote)
          : TEXTS.markdown.optionWithoutDesc(label, directiveToken(compressedDraft), optNote);
      });

      // 附带未选中选项上的孤立批注（与总览页展示一致）
      const q = questionIndex === undefined ? undefined : this.questions[questionIndex];
      if (q && ans.optionNotes) {
        const selectedIdxSet = new Set(
          ans.multiSelect
            ? (ans.selectedIndices ?? [])
            : ans.selectedOptionIndex !== undefined
              ? [ans.selectedOptionIndex]
              : [],
        );
        for (const [idxStr, note] of Object.entries(ans.optionNotes)) {
          const idx1 = Number(idxStr);
          if (selectedIdxSet.has(idx1)) continue;
          const rawLabel = q.options[idx1 - 1]?.label;
          if (rawLabel && note) {
            parts.push(
              TEXTS.markdown.unselectedOptionNote(
                sanitizeEnvelopeText(envelopeOptionLabel(rawLabel, idx1)),
                noteToken(note),
              ),
            );
          }
        }
      }

      if (ans.customText) parts.push(noteToken(ans.customText));
      const body = parts.join(TEXTS.markdown.partSeparator) || TEXTS.markdown.noSelection;
      return TEXTS.markdown.answerLine(
        i + 1,
        sanitizeEnvelopeText(envelopeQuestionTitle(ans.questionTitle, questionIndex)),
        body,
      );
    });

    return [
      TEXTS.markdown.envelopePrefix,
      ...answerLines,
      ...(supplementLine ? [supplementLine] : []),
      TEXTS.markdown.envelopeSuffix,
    ].join("\n");
  }
}
