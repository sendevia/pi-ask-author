/**
 * @file tool-card.ts
 * @description 会话回放卡片渲染：`renderCall` 的摘要派生与 `renderResult` 的三态明细
 *
 * 核心架构特性：
 * - 调用摘要与执行路径共用 `sanitizeAskAuthorArgs`，别名、包装键、终端转义清洗与数量上限只有一条规则
 * - 渲染器只读取宿主传入的入参与详情，不持有组件实例；槽位既有 `Text` 复用由 `lastComponent` 提供
 * - 缓存只存与主题无关的派生数据，按 args 对象身份失效；主题着色每帧现场计算
 *
 * 依赖方向：tool-card.ts → model.ts（类型）/ sanitize.ts / schema.ts（类型）/ texts.ts / theme.ts / tool-result.ts；被 index.ts 注册
 */

import type { ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { AskAuthorResult } from "./model.js";
import type { AskAuthorParams, RawParams } from "./schema.js";
import { sanitizeAskAuthorArgs } from "./sanitize.js";
import { TEXTS } from "./texts.js";
import type { Theme } from "./theme.js";
import { formatAnswerLine, narrowResultDetails, type AskAuthorToolResult } from "./tool-result.js";

/** 调用卡片派生数据：与主题无关的纯计算结果（颜色合成每帧按当前主题现场计算） */
export interface CallCardData {
  /** 卡片标题（已清洗的 `formTitle`） */
  title: string;
  /** 计数标签（多题模式为 `2 题 • 6 选项`，单题模式仅 `6 选项`） */
  countLabel: string;
}

/**
 * `renderCall` 记忆化状态载荷：宿主按工具执行行创建一次、跨帧复用的可变对象（`ToolRenderContext.state`，同一行的 `renderCall` 与 `renderResult` 共享该实例）
 * 以 **args 对象身份** 为键；宿主经 `ToolExecutionComponent.updateArgs` 赋入新对象，身份变化即失效重新计算
 */
export interface CallRenderState {
  /** 上一次派生所用的 args 对象身份（仅作 `===` 引用比对，不读取任何属性） */
  cachedArgs?: object;
  /** 与 `cachedArgs` 配对的派生数据；身份命中时直接复用 */
  cachedCard?: CallCardData;
}

/** 卡片渲染上下文（从宿主公开的 `ToolDefinition` 派生，避免依赖未从包入口导出的内部类型） */
type CardRenderContext = Parameters<
  NonNullable<ToolDefinition<typeof AskAuthorParams, AskAuthorResult, CallRenderState>["renderCall"]>
>[2];

/**
 * 派生调用卡片数据（标题 + 计数标签：题目数 > 1 时附带题量，单题模式仅选项数）
 * 本函数不构建表单模型：流式调用期间 `showIf` 可能引用尚未到达的题目，模型构造会因条件非法而抛出
 * @param args - 本次渲染的原始工具入参（流式期间可能为不完整对象）
 * @param state - 宿主按工具行复用、跨帧身份稳定的可变状态载荷
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
 * 复用渲染槽位既有 Text 组件就地更新卡片内容（Pi 渲染器 `lastComponent` 复用最佳实践）
 * @param content - 卡片文本内容
 * @param lastComponent - 该槽位上帧返回的组件实例（非 Text 实例时新建零边距 Text）
 * @returns 复用或新建的 `Text`（已 `setText`，其内部行缓存随 `setText` 失效）
 */
function containerText(content: string, lastComponent: Component | undefined): Text {
  const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  text.setText(content);
  return text;
}

/**
 * 会话回放调用卡片渲染（复用槽位既有 Text；摘要按 args 身份记忆化）
 * `args` 由宿主原样透传（流式期间可能不完整且未经 Schema 校验），摘要派生统一经 `sanitizeAskAuthorArgs` 收敛
 * @param args - 原始工具入参（运行时未经清洗，可能为不完整对象）
 * @param theme - 当前 TUI 主题实例
 * @param context - 宿主渲染上下文（`state` 记忆化载荷 / `lastComponent` 槽位复用）
 * @returns 调用卡片 `Text`（复用 `context.lastComponent` 就地更新）
 */
export function renderCallCard(args: RawParams, theme: Theme, context: CardRenderContext): Component {
  const card = resolveCallCard(args, context.state);
  const label = theme.fg("accent", TEXTS.tool.label);
  const body = `${theme.bold(card.title)} ${theme.fg("muted", `(${card.countLabel})`)}`;
  return containerText(`${label} ${body}`, context.lastComponent);
}

/**
 * 会话回放结果卡片渲染（错误 / 取消 / 完成三态，展开态追加答卷明细）
 * 错误态优先于取消态判定：`details.error` 为真值时即使 `cancelled` 为 true 也按错误呈现
 * @param result - 工具执行结果（`details` 必须经由 {@link narrowResultDetails} 收窄）
 * @param options - 宿主渲染选项（仅使用 `expanded`；本工具不上报流式部分结果）
 * @param theme - 当前 TUI 主题实例
 * @param context - 宿主渲染上下文（`lastComponent` 槽位复用）
 * @returns 结果卡片 `Text`（复用 `context.lastComponent` 就地更新）
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
  ];
  return containerText(lines.join("\n"), context.lastComponent);
}
