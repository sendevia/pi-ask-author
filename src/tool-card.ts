/**
 * @file tool-card.ts
 * @description 会话回放卡片渲染：`renderCall` 的摘要派生与 `renderResult` 的三态明细
 *
 * 调用摘要与执行路径共用 `sanitizeAskAuthorArgs`；卡片只存与主题无关的派生数据，着色每帧现算
 */

import type { ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AskAuthorResult } from "./model.js";
import type { AskAuthorParams, RawParams } from "./schema.js";
import { sanitizeAskAuthorArgs } from "./sanitize.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { formatAnswerLine, narrowResultDetails, type AskAuthorToolResult } from "./tool-result.js";

/** 调用卡片派生数据（与主题无关；颜色每帧按当前主题现场计算） */
export interface CallCardData {
  /** 卡片标题（已清洗的 `formTitle`） */
  title: string;
  /** 计数标签（多题模式为 `2 题 • 6 选项`，单题模式仅 `6 选项`） */
  countLabel: string;
}

/**
 * `renderCall` 记忆化状态载荷：宿主按工具执行行创建一次、跨帧复用，同一行的 `renderCall` 与 `renderResult` 共享
 * 以 args 对象身份为键，宿主经 `ToolExecutionComponent.updateArgs` 赋入新对象时身份变化即失效
 */
export interface CallRenderState {
  /** 上一次派生所用的 args 对象身份（仅作 `===` 引用比对） */
  cachedArgs?: object;
  /** 与 `cachedArgs` 配对的派生数据；身份命中时直接复用 */
  cachedCard?: CallCardData;
}

/** 卡片渲染上下文（从 `ToolDefinition` 派生，避免依赖未从包入口导出的内部类型） */
type CardRenderContext = Parameters<
  NonNullable<ToolDefinition<typeof AskAuthorParams, AskAuthorResult, CallRenderState>["renderCall"]>
>[2];

/**
 * 派生调用卡片数据（题目数大于 1 时附带题量，否则仅选项数）
 * 不构建表单模型：流式调用期间 `showIf` 可能引用尚未到达的题目，模型构造会抛出
 * @param args - 本次渲染的原始入参（流式期间可能不完整）
 * @param state - 宿主按工具行复用的状态载荷
 * @returns 派生卡片数据（args 身份命中时直接复用）
 */
export function resolveCallCard(args: RawParams, state: CallRenderState): CallCardData {
  if (state.cachedArgs === args && state.cachedCard) return state.cachedCard;

  const params = sanitizeAskAuthorArgs(args);
  const questions = params.questions ?? [];
  const flatOptions = params.options ?? [];
  const questionCount = questions.length > 0 ? questions.length : flatOptions.length > 0 ? 1 : 0;
  const optionCount =
    questions.length > 0 ? questions.reduce((sum, question) => sum + question.options.length, 0) : flatOptions.length;

  const card: CallCardData = {
    title: params.formTitle,
    countLabel:
      questionCount > 1
        ? TEXTS.card.callQuestionAndOptionCount(questionCount, optionCount)
        : TEXTS.card.callOptionCountOnly(optionCount),
  };

  state.cachedArgs = args;
  state.cachedCard = card;
  return card;
}

/**
 * 复用槽位既有 `Text` 就地更新卡片内容
 * @param content - 卡片文本内容
 * @param lastComponent - 该槽位上帧返回的组件（非 `Text` 时新建零边距 `Text`）
 * @returns 复用或新建的 `Text`（已 `setText`）
 */
function containerText(content: string, lastComponent: Component | undefined): Text {
  const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  text.setText(content);
  return text;
}

/**
 * 渲染会话回放的调用卡片（复用槽位 `Text`；摘要按 args 身份记忆化）
 * `args` 由宿主原样透传，流式期间可能不完整，摘要派生统一经 `sanitizeAskAuthorArgs` 收敛
 * @param args - 原始入参（运行时未经清洗）
 * @param theme - 当前 TUI 主题实例
 * @param context - 宿主渲染上下文
 * @returns 调用卡片 `Text`
 */
export function renderCallCard(args: RawParams, theme: Theme, context: CardRenderContext): Component {
  const card = resolveCallCard(args, context.state);
  const label = theme.fg("accent", TEXTS.tool.label);
  const body = `${theme.bold(card.title)} ${theme.fg("muted", `(${card.countLabel})`)}`;
  return containerText(`${label} ${body}`, context.lastComponent);
}

/**
 * 渲染会话回放的结果卡片（错误 / 取消 / 完成三态，展开态追加答卷明细）
 * 错误态优先：`details.error` 为真值时即使 `cancelled` 也为 true 仍按错误呈现
 * @param result - 工具执行结果
 * @param options - 宿主渲染选项（仅使用 `expanded`）
 * @param theme - 当前 TUI 主题实例
 * @param context - 宿主渲染上下文
 * @returns 结果卡片 `Text`
 */
export function renderResultCard(
  result: AskAuthorToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: CardRenderContext,
): Component {
  const details = narrowResultDetails(result.details);
  const { expanded } = options;

  if (details.error) {
    const errorTitle = `${theme.fg("error", theme.bold(TEXTS.card.resultErrorShort))} ${theme.fg("muted", `${TEXTS.common.bulletPrefix}${details.error}`)}`;
    if (!expanded) return containerText(errorTitle, context.lastComponent);
    return containerText(
      `${errorTitle}\n${TEXTS.card.errorBullet(theme.fg("error", details.error))}`,
      context.lastComponent,
    );
  }

  if (details.cancelled) {
    return containerText(theme.fg("warning", TEXTS.card.resultCancelled), context.lastComponent);
  }

  const countLabel = `${theme.fg("success", theme.bold(TEXTS.card.resultCompleted))} ${theme.fg(
    "muted",
    `${TEXTS.common.bulletPrefix}${TEXTS.card.resultCount(details.answers.length)}`,
  )}`;
  if (!expanded) return containerText(countLabel, context.lastComponent);

  const lines: string[] = [
    countLabel,
    ...details.answers.map((ans) =>
      TEXTS.card.optionBullet(theme.bold(ans.questionTitle), theme.fg("accent", formatAnswerLine(ans))),
    ),
    ...(details.supplement
      ? [TEXTS.card.optionBullet(theme.bold(TEXTS.card.supplementLabel), theme.fg("accent", details.supplement))]
      : []),
  ];
  return containerText(lines.join("\n"), context.lastComponent);
}
