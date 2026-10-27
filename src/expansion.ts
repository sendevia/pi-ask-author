/**
 * @file expansion.ts
 * @description 实时推演协议：请求载荷构建、模型回复解析与推演结果的不可信边界收敛
 *
 * 核心架构特性：
 * - 请求载荷把表单当前进度完整交给模型：每题的类型、区间、显示条件、推演配置、显隐、作答状态、选中项与批注
 * - 回复约束为纯 JSON 对象，解析失败即抛出明确异常，由组件层在状态栏报告并保留既有作答
 * - 载荷过滤（未知题目、重复标签、ID 冲突）全部委托 `sanitize.ts`，本模块不重复实现清洗规则
 *
 * 依赖方向：expansion.ts → schema.ts（载荷类型）/ model.ts（只读模型）/ sanitize.ts / texts.ts；被 component.ts（运行器类型）与 index.ts（模型调用装配）消费
 */

import type { AskAuthorFormModel, NormalizedQuestion, VisibilityCondition } from "./model.js";
import { sanitizeExpansionPayload, type ExpansionContext } from "./sanitize.js";
import type { ExpansionPayload } from "./schema.js";
import { TEXTS } from "./texts.js";

/** 一次推演的输入：表单模型、触发题目与本次新增上限 */
export interface ExpansionRequest {
  /** 表单模型（只读；推演在途期间作者输入被锁定，模型不会变化） */
  readonly model: AskAuthorFormModel;
  /** 触发本次推演的题目索引（0-based） */
  readonly questionIndex: number;
  /** 生效的插入位置可读描述（题目级设置优先，缺省为表单级） */
  readonly insert: string;
  /** 生效的推演方向指示（题目级设置优先，缺省为表单级） */
  readonly guidance?: string;
  /** 本次允许新增的题目数量（不含已声明题目） */
  readonly maxAdditionalQuestions: number;
}

/** 推演执行器：由入口层装配模型调用，组件层只等待载荷（取消经 `signal` 级联） */
export type ExpansionRunner = (request: ExpansionRequest, signal: AbortSignal) => Promise<ExpansionPayload>;

/** 显示条件的协议形状（与 `showIf` 入参同构：引用题目 ID 加选项标签或作答存在性） */
type ConditionPayload = { questionId: string; option: string } | { questionId: string; answered: boolean };

/**
 * 把显示条件翻译为可回传的协议形状（引用题目 ID 与选项标签，与 `showIf` 入参同构）
 * @param model - 表单模型（用于把条件引用的索引换回题目 ID 与标签）
 * @param conditions - 已解析的显示条件
 * @returns 条件数组；无条件时为 undefined
 */
function describeConditions(
  model: AskAuthorFormModel,
  conditions: readonly VisibilityCondition[],
): ConditionPayload[] | undefined {
  if (conditions.length === 0) return undefined;
  const described: ConditionPayload[] = [];
  for (const condition of conditions) {
    const referenced = model.getQuestion(condition.questionIndex);
    if (!referenced) continue;
    if (condition.kind === "answered") {
      described.push({ questionId: referenced.id, answered: condition.answered });
      continue;
    }
    const option = referenced.options[condition.optionIndex];
    if (option) described.push({ questionId: referenced.id, option: option.label });
  }
  return described;
}

/**
 * 构建单题的进度载荷（属性、显隐、作答状态、选中项、批注与推演配置）
 * @param model - 表单模型
 * @param index - 题目顺序索引（0-based）
 * @returns 面向推演模型的单题载荷；索引越界时为 undefined
 */
function buildQuestionPayload(model: AskAuthorFormModel, index: number) {
  const question = model.getQuestion(index);
  if (!question) return undefined;
  const state = model.getState(index);
  const selectedIndices = model.getSelectedIndices(index);
  const selected = new Set(selectedIndices);
  const note = state.customText?.trim();
  const visible = model.isQuestionVisible(index);
  const answered = visible && model.isQuestionAnswered(index);
  const records = model.getExpansions().filter((record) => record.questionIndex === index);
  const config = model.expansionConfigFor(index);

  return {
    index: index + 1,
    id: question.id,
    title: question.title,
    tabLabel: question.tabLabel,
    description: question.description,
    multiSelect: question.multiSelect,
    minSelect: question.minSelect,
    maxSelect: question.maxSelect,
    allowEmpty: question.allowEmpty,
    allowCustom: question.allowCustom,
    showIf: describeConditions(model, question.showIf),
    expansion: {
      enabled: config !== undefined,
      guidance: config?.guidance,
      insert: config?.insertLabel,
      addedQuestions: records.reduce((total, record) => total + record.addedQuestions, 0),
      addedOptions: records.reduce(
        (total, record) => total + record.addedOptions.reduce((sum, addition) => sum + addition.count, 0),
        0,
      ),
    },
    visible,
    status: !visible
      ? "hidden"
      : !answered
        ? "unanswered"
        : selectedIndices.length > 0 || model.hasAnyResponse(index)
          ? "answered"
          : "skipped",
    selected: selectedIndices.flatMap((optionIndex) => question.options[optionIndex]?.label ?? []),
    note,
    options: question.options.map((option, optionIndex) => ({
      label: option.label,
      description: option.description,
      hasPreview: Boolean(option.preview),
      showIf: describeConditions(model, option.showIf),
      visible: model.isOptionVisible(index, optionIndex),
      selected: selected.has(optionIndex),
      note: state.optionNotes.get(optionIndex)?.trim(),
    })),
  };
}

/**
 * 构建推演用户消息（前缀说明 + 单行 JSON 载荷）
 * @param request - 推演输入
 * @returns 面向模型的用户消息正文
 */
export function buildExpansionUserMessage(request: ExpansionRequest): string {
  const model = request.model;
  const trigger = model.getQuestion(request.questionIndex);
  const payload = {
    formTitle: model.formTitle,
    formDescription: model.formDescription,
    guidance: request.guidance,
    insert: request.insert,
    maxAdditionalQuestions: request.maxAdditionalQuestions,
    trigger: trigger ? { index: request.questionIndex + 1, id: trigger.id, title: trigger.title } : undefined,
    questions: model.questions.flatMap((_question, index) => buildQuestionPayload(model, index) ?? []),
  };
  return `${TEXTS.expansion.userPreamble}\n${JSON.stringify(payload)}`;
}

/**
 * 从回复文本中提取并校验 JSON 对象
 * @param reply - 模型回复原文（可能包含代码围栏或前后说明）
 * @returns 已过滤的推演载荷
 * @throws Error 回复中不存在 JSON 对象、JSON 解析失败时抛出（由组件层在状态栏报告）
 */
export function parseExpansionReply(reply: string, context: ExpansionContext): ExpansionPayload {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(TEXTS.expansion.errors.invalidReply);

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error(TEXTS.expansion.errors.invalidReply);
  }
  return sanitizeExpansionPayload(parsed, context);
}

/**
 * 归集推演载荷的过滤上下文
 * @param questions - 当前已声明的题目
 * @returns 题目 ID 列表与各题已有选项标签
 */
export function expansionContext(questions: readonly NormalizedQuestion[]): ExpansionContext {
  return {
    questionIds: questions.map((question) => question.id),
    optionLabels: new Map(questions.map((question) => [question.id, question.options.map((option) => option.label)])),
  };
}
