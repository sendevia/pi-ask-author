/**
 * @file index.ts
 * @description 插件入口：注册 `ask_author` 工具与 `/ask-author` 命令，并编排工具执行生命周期
 *
 * - 执行流程只做守卫与分支：信号已中止、非 TUI、模型构建失败、无题目、请求推演但无模型，之后进入交互界面
 * - 实时推演的模型调用只在本文件装配（`createExpansionRunner`），请求上下文与主对话同源
 * - 工具声明为 `model-only`，并标注只读、封闭世界
 */

import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { AskAuthorComponent, type ExpansionService } from "./component.js";
import { buildExpansionUserMessage, expansionContext, parseExpansionReply, type ExpansionRunner } from "./expansion.js";
import { cleanOptional } from "./format.js";
import { AdaptiveConditionError, AskAuthorFormModel, type AskAuthorResult } from "./model.js";
import { AskAuthorParams } from "./schema.js";
import { sanitizeAskAuthorArgs } from "./sanitize.js";
import { TEXTS } from "./texts.js";
import { renderCallCard, renderResultCard, type CallRenderState } from "./tool-card.js";
import {
  createCancelledResult,
  createErrorResult,
  createRuntimeErrorResult,
  createSuccessResult,
  type AskAuthorToolResult,
} from "./tool-result.js";

/** 工具结果中携带的用量字段（结构与宿主 `AgentToolResult.usage` 一致） */
type ToolUsage = NonNullable<AgentToolResult<unknown>["usage"]>;

/**
 * 累加两份用量
 * @param total - 已累计用量（缺省表示尚未调用模型）
 * @param usage - 本次调用的用量
 * @returns 逐字段求和后的新对象；`cacheWrite1h` / `reasoning` 仅在两侧都有值时保留
 */
function addUsage(total: ToolUsage | undefined, usage: ToolUsage): ToolUsage {
  if (!total) return usage;
  const sum: ToolUsage = {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
  // 只有每部分都由 provider 上报计费时才标记为 provider 上报，与宿主的合并语义一致
  if (total.cost.totalFromProvider === true && usage.cost.totalFromProvider === true) sum.cost.totalFromProvider = true;
  if (total.cacheWrite1h !== undefined && usage.cacheWrite1h !== undefined)
    sum.cacheWrite1h = total.cacheWrite1h + usage.cacheWrite1h;
  if (total.reasoning !== undefined && usage.reasoning !== undefined) sum.reasoning = total.reasoning + usage.reasoning;
  return sum;
}

/**
 * 组装推演请求的历史消息：取会话投影，并为尚未返回的工具调用补上占位结果
 * @param ctx - 扩展上下文
 * @returns 与主对话同源的 provider 消息序列
 */
function buildSessionHistory(ctx: ExtensionToolContext) {
  // 压缩感知的分支投影就是主对话送给模型的消息，推演与它共享前缀
  const history = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  const answered = new Set(
    history.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
  );
  // 推演发生在 ask_author 的执行期内，本次调用（可能还有并行调用）尚无结果；补齐占位以保持调用与结果相邻
  const pending = history.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "toolCall" && !answered.has(part.id) ? [part] : []))
      : [],
  );
  for (const call of pending) {
    history.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: TEXTS.expansion.pendingToolResult }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  return history;
}

/**
 * 构建实时推演执行器：用当前会话模型为表单追加后续题目与选项
 * @param ctx - 扩展上下文
 * @param onUsage - 用量回调（推演调用不计入主对话用量）
 * @returns 推演执行器；当前会话无模型时为 undefined
 */
function createExpansionRunner(
  ctx: ExtensionToolContext,
  onUsage: (usage: ToolUsage) => void,
): ExpansionRunner | undefined {
  const model = ctx.model;
  if (!model) return undefined;

  return async (request, signal) => {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        // 推演协议接在主对话系统提示词之后，JSON 输出约束仍居末位
        systemPrompt: `${ctx.getSystemPrompt()}\n\n${TEXTS.expansion.systemPrompt}`,
        messages: [
          ...buildSessionHistory(ctx),
          {
            role: "user",
            content: [{ type: "text", text: buildExpansionUserMessage(request) }],
            timestamp: Date.now(),
          },
        ],
      },
      // 会话标识是 provider 侧路由与提示缓存的依据：OpenCode 系 provider 缺它会被服务端拒绝
      { signal, sessionId: ctx.sessionManager.getSessionId() },
    );
    if (response.usage) onUsage(response.usage);
    if (response.stopReason === "aborted") throw new Error(TEXTS.expansion.errors.aborted);
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? TEXTS.expansion.errors.providerFailed);
    }
    const reply = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return parseExpansionReply(reply, expansionContext(request.model.questions));
  };
}

/**
 * `ask-author` 插件主入口工厂（仅完成注册）
 * @param pi - Pi 扩展运行时 API 实例
 */
export default function askAuthorExtension(pi: ExtensionAPI): void {
  // 注册 ask_author 工具：显式实例化 TState
  pi.registerTool<typeof AskAuthorParams, AskAuthorResult, CallRenderState>({
    name: TEXTS.tool.name,
    label: TEXTS.tool.label,
    description: TEXTS.tool.description,
    promptSnippet: TEXTS.tool.promptSnippet,
    // 宿主接口要求可变 `string[]`，故展开 `as const` 只读元组
    promptGuidelines: [...TEXTS.tool.promptGuidelines],
    parameters: AskAuthorParams,
    // 交互式 UI 独占编辑器（`ctx.ui.custom`）：串行执行
    executionMode: "sequential",
    // 交互式 UI 只由模型直接发起，禁止被其他工具或 codemode 脚本嵌套调用
    exposure: "model-only",
    // 只读取对话上下文并收集作者输入，不修改工作区
    annotations: { readOnlyHint: true, openWorldHint: false },
    // 宿主在 Schema 校验前调用：清洗为白名单形状，并兼容别名与包裹入参
    prepareArguments: sanitizeAskAuthorArgs,

    /**
     * 工具执行主流程：归一化标题 → 守卫 → 构建模型 → 启动交互式 TUI → 映射四类结果
     * @param _toolCallId - 宿主工具调用 ID（未使用）
     * @param rawParams - 清洗并经宿主 Schema 校验后的入参
     * @param signal - 宿主取消信号（可缺省；Esc / Ctrl+C 级联终止界面）
     * @param _onUpdate - 流式进度回调（未使用）
     * @param ctx - Pi 扩展上下文（`mode` 守卫与 `ui.custom` 组件挂载）
     * @returns 取消 / 结构化错误 / 运行期异常 / 完成四类结果之一
     */
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const initialFormTitle = cleanOptional(rawParams?.formTitle) ?? TEXTS.fallbacks.defaultFormTitle;

      if (signal?.aborted) {
        return createCancelledResult({ formTitle: initialFormTitle });
      }

      if (ctx.mode !== "tui") {
        return createErrorResult(
          TEXTS.markdown.errorReasons.nonTui,
          TEXTS.markdown.errorGuidances.nonTui,
          TEXTS.status.errorNonTui,
          { formTitle: initialFormTitle },
        );
      }

      let formModel: AskAuthorFormModel;
      try {
        formModel = new AskAuthorFormModel(rawParams);
      } catch (err) {
        if (err instanceof AdaptiveConditionError) {
          return createErrorResult(
            TEXTS.markdown.errorReasons.invalidCondition(err.message),
            TEXTS.markdown.errorGuidances.invalidCondition,
            TEXTS.status.errorInvalidCondition(err.message),
            { formTitle: initialFormTitle },
          );
        }
        return createRuntimeErrorResult(err, { formTitle: initialFormTitle });
      }

      if (formModel.questions.length === 0) {
        return createErrorResult(
          TEXTS.markdown.errorReasons.noQuestions,
          TEXTS.markdown.errorGuidances.noQuestions,
          TEXTS.status.errorNoQuestions,
          { questions: [], formTitle: formModel.formTitle, formDescription: formModel.formDescription },
        );
      }

      // 推演用量回传宿主，供会话成本统计
      let expansionUsage: ToolUsage | undefined;
      const accumulateUsage = (usage: ToolUsage): void => {
        expansionUsage = addUsage(expansionUsage, usage);
      };
      const withUsage = (result: AskAuthorToolResult): AskAuthorToolResult =>
        expansionUsage ? { ...result, usage: expansionUsage } : result;

      const expansionRunner = rawParams.expansion ? createExpansionRunner(ctx, accumulateUsage) : undefined;
      if (rawParams.expansion && !expansionRunner) {
        return createErrorResult(
          TEXTS.markdown.errorReasons.expansionUnavailable,
          TEXTS.markdown.errorGuidances.expansionUnavailable,
          TEXTS.status.expansionFailed(TEXTS.expansion.errors.noModel),
          {
            questions: formModel.questions,
            formTitle: formModel.formTitle,
            formDescription: formModel.formDescription,
          },
        );
      }
      const expansion: ExpansionService | undefined = expansionRunner
        ? { run: expansionRunner, guidance: rawParams.expansion?.guidance }
        : undefined;

      let comp: AskAuthorComponent | undefined;
      try {
        // 宿主回调约定 `(tui, theme, keybindings, done)`：按键分派由组件内部 `matchesKey` 自行持有，
        // 注入的 keybindings 管理器未被消费，故以 `_kb` 标记未使用
        const result = await ctx.ui.custom<AskAuthorResult>(
          (tui, theme, _kb, done) => {
            comp = new AskAuthorComponent(tui, theme, formModel, done, expansion);
            comp.bindAbortSignal(signal);
            return comp;
          },
          // 作答界面是整屏覆盖层：指针在任何位置按下滚轮都由本工具接收，不再滚动会话记录
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
        );

        if (!result || result.cancelled) {
          return withUsage(
            createCancelledResult({
              questions: result?.questions ?? formModel.questions,
              formTitle: result?.formTitle ?? formModel.formTitle,
              formDescription: result?.formDescription ?? formModel.formDescription,
            }),
          );
        }

        return withUsage(createSuccessResult(formModel, result.answers));
      } catch (err) {
        return withUsage(
          createRuntimeErrorResult(err, {
            questions: formModel.questions,
            formTitle: formModel.formTitle,
            formDescription: formModel.formDescription,
          }),
        );
      } finally {
        // dispose() 幂等，宿主亦会卸载组件；此处仅兜住「组件工厂执行后、宿主接管前」的抛出错误路径
        comp?.dispose();
      }
    },

    renderCall: renderCallCard,
    renderResult: renderResultCard,
  });

  // 注册 /ask-author 辅助命令
  pi.registerCommand(TEXTS.command.name, {
    description: TEXTS.command.description,
    /**
     * 命令处理函数：向作者回显使用提示（不解析参数）
     * @param _args - 命令参数（未使用）
     * @param ctx - Pi 扩展上下文
     */
    handler: async (_args, ctx) => {
      ctx.ui.notify(TEXTS.command.notify, "info");
    },
  });
}

// ===== 外部与二次开发具名导出 =====

export { askAuthorExtension };
export {
  AdaptiveConditionError,
  AskAuthorFormModel,
  type AskAuthorResult,
  type AuthorAnswerItem,
  type ExpansionRecord,
  type NormalizedOption,
  type NormalizedQuestion,
  type VisibilityCondition,
} from "./model.js";
export {
  AskAuthorParams,
  ExpansionSchema,
  OptionSchema,
  QuestionExpansionSchema,
  QuestionSchema,
  ShowIfConditionSchema,
  type ExpansionConfig,
  type ExpansionPayload,
  type OptionAddition,
  type QuestionExpansionConfig,
  type RawParams,
} from "./schema.js";
export { sanitizeAskAuthorArgs, sanitizeExpansionPayload, type ExpansionContext } from "./sanitize.js";
export {
  buildExpansionUserMessage,
  expansionContext,
  parseExpansionReply,
  type ExpansionRequest,
  type ExpansionRunner,
} from "./expansion.js";
export { TEXTS } from "./texts.js";
export { ICONS, LAYOUT_CONFIG, MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";
export { ACTIVE_LOCALE, detectLocale } from "./i18n.js";
export { cleanOptional, cleanText, normalizeImeKey, padToVisibleWidth, safeLine } from "./format.js";
export type { AskAuthorToolResult, ResultContext } from "./tool-result.js";
export type { CallCardData, CallRenderState } from "./tool-card.js";
