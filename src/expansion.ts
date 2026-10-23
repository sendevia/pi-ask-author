/**
 * @file expansion.ts
 * @description 实时推演协议：请求载荷构建、模型回复解析与推演结果的不可信边界收敛
 *
 * 核心架构特性：
 * - 请求只携带表单上下文、已声明题目与已确认作答，不携带内部索引等不可见字段
 * - 回复约束为纯 JSON 对象，解析失败即抛出明确异常，由组件层在状态栏报告并保留既有作答
 * - 载荷过滤（未知题目、重复标签、ID 冲突）全部委托 `sanitize.ts`，本模块不重复实现清洗规则
 *
 * 依赖方向：expansion.ts → schema.ts（载荷类型）/ model.ts（只读类型）/ sanitize.ts / texts.ts；被 component.ts（运行器类型）与 index.ts（模型调用装配）消费
 */

import type { AuthorAnswerItem, NormalizedQuestion } from "./model.js";
import { sanitizeExpansionPayload, type ExpansionContext } from "./sanitize.js";
import type { ExpansionPayload } from "./schema.js";
import { TEXTS } from "./texts.js";

/** 一次推演的输入：表单上下文、当前题目与已确认作答 */
export interface ExpansionRequest {
  /** 问卷总标题 */
  readonly formTitle: string;
  /** 问卷全局背景（可选） */
  readonly formDescription?: string;
  /** 调用方给出的长期推演方向指示（可选） */
  readonly guidance?: string;
  /** 推演题目的落点描述（供模型判定哪些题目位于插入点之前） */
  readonly insert: string;
  /** 本次允许新增的题目数量（不含已声明题目） */
  readonly maxAdditionalQuestions: number;
  /** 当前已声明的全部题目（按展示顺序） */
  readonly questions: readonly NormalizedQuestion[];
  /** 当前已确认的作答 */
  readonly answers: readonly AuthorAnswerItem[];
}

/** 推演执行器：由入口层装配模型调用，组件层只等待载荷（取消经 `signal` 级联） */
export type ExpansionRunner = (request: ExpansionRequest, signal: AbortSignal) => Promise<ExpansionPayload>;

/**
 * 构建推演用户消息（前缀说明 + 单行 JSON 载荷）
 * @param request - 推演输入
 * @returns 面向模型的用户消息正文
 */
export function buildExpansionUserMessage(request: ExpansionRequest): string {
  const payload = {
    formTitle: request.formTitle,
    formDescription: request.formDescription,
    guidance: request.guidance,
    insert: request.insert,
    maxAdditionalQuestions: request.maxAdditionalQuestions,
    questions: request.questions.map((question) => ({
      id: question.id,
      title: question.title,
      description: question.description,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
        conditional: option.showIf.length > 0,
      })),
      conditional: question.showIf.length > 0,
    })),
    answers: request.answers.map((answer) => ({
      questionId: answer.questionId,
      selected: (answer.multiSelect
        ? (answer.selectedOptions ?? [])
        : answer.selectedOption
          ? [answer.selectedOption]
          : []
      ).map((option) => option.label),
      note: answer.customText,
    })),
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
