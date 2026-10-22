/**
 * @file tool-result.ts
 * @description `ask_author` 的四类结果工厂与结果详情的宿主边界收窄
 *
 * 核心架构特性：
 * - 完成 / 取消 / 结构化错误 / 运行期异常四类出口集中在此，封套前缀保持字节稳定以提升 Prompt Cache 命中率
 * - 失败类结果同时设置 `isError: true`，让宿主按错误结果处理；`content` 仍携带面向 LLM 的封套与纠正指引
 * - `narrowResultDetails` 是 `renderResult` 收到的不可信 `details` 的唯一类型收窄点
 *
 * 依赖方向：tool-result.ts → model.ts / texts.ts（类型与文案）；被 index.ts 与 tool-card.ts 消费
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  type AskAuthorFormModel,
  type AskAuthorResult,
  type AuthorAnswerItem,
  type NormalizedQuestion,
} from "./model.js";
import { TEXTS } from "./texts.js";

/** `ask_author` 工具执行结果结构（基于 Pi 官方 `AgentToolResult` 结构特化） */
export type AskAuthorToolResult = AgentToolResult<AskAuthorResult>;

/** 结果构造上下文：题目快照与标题/描述的可选覆盖（缺省值统一由 {@link resolveResultContext} 收敛） */
export interface ResultContext {
  /** 题目快照（缺省空数组：取消/错误可能发生在模型构建前） */
  questions?: NormalizedQuestion[];
  /** 问卷总标题（缺省 `TEXTS.fallbacks.defaultFormTitle`） */
  formTitle?: string;
  /** 问卷全局描述（缺省 undefined，不携带该字段内容） */
  formDescription?: string;
}

/**
 * 提取异常对象的用户可读消息（`Error` 取自 `message`，其余经 `String` 字符串化）
 * @param err - 未知异常对象
 * @returns `Error` 实例读取其 `message`（可为空串），其余类型取自 `String(err)`（对象为 `[object Object]`）
 */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 收敛结果构造上下文的缺省值（唯一兜底点：`formTitle` 恒非空、`questions` 恒为数组，`formDescription` 保留 undefined 语义）
 * @param ctx - 结果构造上下文（可为空对象或省略）
 * @returns 收敛后的 `formTitle` / `formDescription` / `questions` 三元组（`formTitle` 缺省为 `TEXTS.fallbacks.defaultFormTitle`）
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
 * 构造取消结果（智能体封套 `[Author Decision Cancelled]` + `cancelled: true`，`answers` 恒为空数组）
 * @param ctx - 结果构造上下文（题目快照与被取消时的表单快照）
 * @returns 取消结果（`content` 为取消封套单行文本，`details` 不含 `error` 字段）
 */
export function createCancelledResult(ctx: ResultContext = {}): AskAuthorToolResult {
  const { formTitle, formDescription, questions } = resolveResultContext(ctx);
  return {
    content: [{ type: "text", text: TEXTS.markdown.envelopeCancelled }],
    details: { formTitle, formDescription, questions, answers: [], cancelled: true },
  };
}

/**
 * 构造错误结果（智能体错误封套 + 用户界面提示；作为工具错误结果返回，`details` 仍可用于渲染）
 * @param reason - 面向智能体的原因
 * @param guidance - 面向智能体的纠正指引
 * @param userFacingError - 面向用户的界面提示
 * @param ctx - 结果构造上下文（缺省值由 `resolveResultContext` 收敛）
 * @returns 错误结果对象（`isError: true`、`cancelled: false` + `error` 详情，无作答内容）
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
 * 构造运行期异常结果（模型构建抛出错误与 `execute` 异常捕获两条路径共用本工厂）
 * @param err - 异常对象或消息（字符串经 {@link toErrorMessage} 原样返回）
 * @param ctx - 结果构造上下文（题目快照与表单快照）
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
 * 构造完成结果（`[Author Decision Finalized]` 封套正文由模型编译，空答卷渲染为空答卷提示）
 * @param formModel - 本次请示的表单模型（详情表单快照来源，与组件回传结果同源）
 * @param answers - 组件编译完成的答卷条目（封套正文与详情 `answers` 共用同一数组）
 * @returns 完成结果（`cancelled: false`、无 `error` 字段；`answers` 为空数组时正文为 `TEXTS.markdown.envelopeEmpty`）
 */
export function createSuccessResult(formModel: AskAuthorFormModel, answers: AuthorAnswerItem[]): AskAuthorToolResult {
  return {
    content: [{ type: "text", text: formModel.formatAnswers(answers) }],
    details: {
      formTitle: formModel.formTitle,
      formDescription: formModel.formDescription,
      questions: formModel.questions,
      answers,
      cancelled: false,
    },
  };
}

/**
 * 结果卡片宿主边界的**唯一**类型收窄点：把 `renderResult` 的 `details` 从不可信类型提升为 `AskAuthorResult`
 * 会话回放时 `details` 由转录 JSON 反序列化而来（运行期形状不可信），故先做形状闸门再断言一次；数组元素由本扩展自身写入，不在闸门范围
 * 校验项：普通对象、`cancelled`/`answers`/`questions`/`formTitle` 键存在性、`cancelled` 布尔、`answers`/`questions` 数组、`formTitle` 字符串
 * 可选 `error` / `formDescription` 不设闸门：二者仅参与字符串插值，非字符串至多渲染为退化文本
 * @param value - 宿主传入的不可信 `details` 值
 * @returns 通过形状闸门的 `AskAuthorResult`
 * @throws 任一校验项失败时抛出错误（就地崩溃）
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
 * 将单条答案展开为明细内容行（多选以 `TEXTS.common.optionSeparator` 连接并附选项批注角标，零勾选回退 `未选`；单选无选中项时回退题目补充说明，两者皆空再回退 `未选`）
 * @param ans - 答卷条目
 * @returns 单行明细文本（不含换行；题目级补充说明以 `TEXTS.card.questionNoteTag` 角标追加）
 */
export function formatAnswerLine(ans: AuthorAnswerItem): string {
  const questionNoteStr = ans.customText ? TEXTS.card.questionNoteTag(ans.customText) : "";
  /**
   * 把带专属批注的选项标签追加为卡片角标形式（`note` 缺省或空串时原样返回 `label`）
   * @param label - 选项标签
   * @param note - 选项专属批注（可选）
   * @returns 携带角标的标签；无批注时即原 `label`
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
