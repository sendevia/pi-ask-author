/**
 * @file tool-result.ts
 * @description `ask_author` 的四类结果工厂与结果详情的宿主边界收窄
 *
 * 封套前缀保持字节稳定；失败类结果同时设置 `isError: true`
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  type AskAuthorFormModel,
  type AskAuthorResult,
  type AuthorAnswerItem,
  type NormalizedQuestion,
} from "./model.js";
import { TEXTS } from "./texts.js";

/** `ask_author` 工具执行结果结构（基于 Pi 官方 `AgentToolResult` 特化） */
export type AskAuthorToolResult = AgentToolResult<AskAuthorResult>;

/** 结果构造上下文：题目快照与标题/描述的可选覆盖 */
export interface ResultContext {
  /** 题目快照（缺省空数组：取消/错误可能发生在模型构建前） */
  questions?: NormalizedQuestion[];
  /** 问卷总标题（缺省 `TEXTS.fallbacks.defaultFormTitle`） */
  formTitle?: string;
  /** 问卷全局描述 */
  formDescription?: string;
}

/**
 * 提取异常对象的可读消息
 * @param err - 未知异常对象
 * @returns `Error` 实例取其 `message`，其余类型取自 `String(err)`
 */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 收敛结果构造上下文的缺省值（唯一兜底点）
 * @param ctx - 结果构造上下文
 * @returns `formTitle` 恒非空、`questions` 恒为数组，`formDescription` 保留 undefined
 */
function resolveResultContext(ctx: ResultContext = {}): {
  formTitle: string;
  formDescription: string | undefined;
  questions: NormalizedQuestion[];
} {
  return {
    formTitle: ctx.formTitle ?? TEXTS.fallbacks.defaultFormTitle,
    formDescription: ctx.formDescription,
    questions: ctx.questions ?? [],
  };
}

/**
 * 构造取消结果（取消封套 + `cancelled: true`，`answers` 恒为空）
 * @param ctx - 结果构造上下文
 * @returns 取消结果（`details` 不含 `error` 字段）
 */
export function createCancelledResult(ctx: ResultContext = {}): AskAuthorToolResult {
  const { formTitle, formDescription, questions } = resolveResultContext(ctx);
  return {
    content: [{ type: "text", text: TEXTS.markdown.envelopeCancelled }],
    details: { formTitle, formDescription, questions, answers: [], cancelled: true },
  };
}

/**
 * 构造错误结果（错误封套 + 界面提示，并标记为工具错误）
 * @param reason - 面向智能体的原因
 * @param guidance - 面向智能体的纠正指引
 * @param userFacingError - 面向用户的界面提示
 * @param ctx - 结果构造上下文
 * @returns 错误结果（`isError: true`、`cancelled: false`，无作答内容）
 */
export function createErrorResult(
  reason: string,
  guidance: string,
  userFacingError: string,
  ctx: ResultContext = {},
): AskAuthorToolResult {
  const { formTitle, formDescription, questions } = resolveResultContext(ctx);
  return {
    content: [{ type: "text", text: TEXTS.markdown.envelopeError(reason, guidance) }],
    details: { formTitle, formDescription, questions, answers: [], cancelled: false, error: userFacingError },
    isError: true,
  };
}

/**
 * 构造运行期异常结果（模型构建抛出与 `execute` 异常两条路径共用）
 * @param err - 异常对象或消息
 * @param ctx - 结果构造上下文
 * @returns 运行期异常结果（封套原因携带 {@link toErrorMessage} 归一后的消息）
 */
export function createRuntimeErrorResult(err: unknown, ctx: ResultContext = {}): AskAuthorToolResult {
  const errorMsg = toErrorMessage(err);
  return createErrorResult(
    TEXTS.markdown.errorReasons.runtimeError(errorMsg),
    TEXTS.markdown.errorGuidances.runtimeError,
    TEXTS.status.errorExecutionFailed(errorMsg),
    ctx,
  );
}

/**
 * 构造完成结果（封套正文由模型编译，空答卷渲染为空答卷提示）
 * @param formModel - 本次请示的表单模型（详情表单快照来源）
 * @param answers - 组件编译完成的答卷条目（封套正文与详情共用同一数组）
 * @returns 完成结果（`cancelled: false`、无 `error` 字段）
 */
export function createSuccessResult(formModel: AskAuthorFormModel, answers: AuthorAnswerItem[]): AskAuthorToolResult {
  return {
    content: [{ type: "text", text: formModel.formatAnswers(answers) }],
    details: {
      formTitle: formModel.formTitle,
      formDescription: formModel.formDescription,
      questions: formModel.questions,
      answers,
      supplement: formModel.formNote,
      cancelled: false,
    },
  };
}

/**
 * 结果卡片宿主边界的唯一类型收窄点：把 `renderResult` 的 `details` 提升为 `AskAuthorResult`
 * 会话回放的 `details` 由转录 JSON 反序列化而来，故先做形状闸门再断言一次；数组元素不设闸门
 * 校验项：普通对象、四个字段存在性、`cancelled` 布尔、`answers` / `questions` 数组、`formTitle` 字符串
 * `error` / `formDescription` 不设闸门：仅参与字符串插值
 * @param value - 宿主传入的不可信 `details`
 * @returns 通过形状闸门的 `AskAuthorResult`
 * @throws Error 任一校验项失败时抛出
 */
export function narrowResultDetails(value: unknown): AskAuthorResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ask_author 结果详情应为普通对象，实际收到 ${JSON.stringify(value)}`);
  }
  if (!("cancelled" in value) || !("answers" in value) || !("questions" in value) || !("formTitle" in value)) {
    throw new Error("ask_author 结果详情缺少 cancelled/answers/questions/formTitle 字段");
  }
  if (typeof value.cancelled !== "boolean") throw new Error("ask_author 结果详情的 cancelled 字段应为布尔值");
  if (!Array.isArray(value.answers) || !Array.isArray(value.questions)) {
    throw new Error("ask_author 结果详情的 answers/questions 字段应为数组");
  }
  if (typeof value.formTitle !== "string") throw new Error("ask_author 结果详情的 formTitle 字段应为字符串");
  return value as AskAuthorResult;
}

/**
 * 将单条答案展开为明细单行（多选以 `optionSeparator` 连接并附批注角标；单选无选中项时回退题目补充说明，再回退未选）
 * @param ans - 答卷条目
 * @returns 单行明细文本（题目级补充说明以 `questionNoteTag` 角标追加）
 */
export function formatAnswerLine(ans: AuthorAnswerItem): string {
  const questionNoteStr = ans.customText ? TEXTS.card.questionNoteTag(ans.customText) : "";
  /**
   * 把带专属批注的选项标签追加为卡片角标（无批注时原样返回）
   * @param label - 选项标签
   * @param note - 选项专属批注
   * @returns 携带角标的标签
   */
  const withNote = (label: string, note?: string): string => (note ? TEXTS.card.optionWithNote(label, note) : label);

  if (ans.multiSelect) {
    const optItems = (ans.selectedOptions ?? []).map((o) => withNote(o.label, o.customText));
    return (optItems.join(TEXTS.common.optionSeparator) || TEXTS.fallbacks.unselectedOption) + questionNoteStr;
  }
  if (ans.selectedOption) {
    return withNote(ans.selectedOption.label, ans.selectedOption.customText) + questionNoteStr;
  }
  return ans.customText || TEXTS.fallbacks.unselectedOption;
}
