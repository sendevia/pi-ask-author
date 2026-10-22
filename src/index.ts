/**
 * @file index.ts
 * @description 作者请示插件入口：注册 `ask_author` 工具与 `/ask-author` 命令，并编排工具执行生命周期
 *
 * 核心架构特性：
 * - 执行流程只做守卫与分支：信号已中止 → 取消；非 TUI → 结构化错误；模型构建失败 → 条件错误或运行期异常；无题目 → 空题目错误；UI 返回 → 取消或完成
 * - 结果构造、卡片渲染与执行编排分属 `tool-result.ts` / `tool-card.ts` / 本文件，宿主边界代码保持可独立测试
 * - 工具声明为 `model-only`（交互式 UI 只由模型直接发起），并标注只读、封闭世界，供权限扩展判断
 * - 本文件不注册监听器与定时器；组件级 AbortSignal 级联取消与 `dispose()` 幂等回收由 `AskAuthorComponent` 负责
 *
 * 依赖方向：index.ts 为模块依赖图的入口；`component` / `model` / `schema` / `sanitize` / `texts` / `tool-card` / `tool-result` 均为其直接依赖
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AskAuthorComponent } from "./component.js";
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
} from "./tool-result.js";

/**
 * `ask-author` 扩展插件主入口工厂（仅完成注册，启动期不执行任何交互）
 * @param pi - Pi 扩展运行时 API 实例
 */
export default function askAuthorExtension(pi: ExtensionAPI): void {
  // 注册 ask_author 工具：显式实例化 TState
  pi.registerTool<typeof AskAuthorParams, AskAuthorResult, CallRenderState>({
    name: TEXTS.tool.name,
    label: TEXTS.tool.label,
    description: TEXTS.tool.description,
    promptSnippet: TEXTS.tool.promptSnippet,
    // 宿主接口要求可变 `string[]`；TEXTS 为 `as const` 只读元组，故展开构造可变副本
    promptGuidelines: [...TEXTS.tool.promptGuidelines],
    parameters: AskAuthorParams,
    // 交互式 UI 独占编辑器（`ctx.ui.custom`）：串行执行
    executionMode: "sequential",
    // 交互式 UI 只由模型直接发起，禁止被其他工具或 codemode 脚本嵌套调用
    exposure: "model-only",
    // 只读取对话上下文并收集作者输入，不修改工作区
    annotations: { readOnlyHint: true, openWorldHint: false },
    // 宿主在 Schema 校验前调用：清洗为白名单形状，并兼容未按当前 Schema 书写的别名/包裹入参
    prepareArguments: sanitizeAskAuthorArgs,

    /**
     * 工具执行主流程：归一化标题 → 守卫 → 构建模型 → 启动交互式 TUI → 映射四类结果
     * @param _toolCallId - 宿主工具调用 ID（本实现不使用）
     * @param rawParams - `prepareArguments` 清洗并经宿主 Schema 校验后的入参
     * @param signal - 宿主取消信号（可缺省；Esc / Ctrl+C 级联终止交互界面）
     * @param _onUpdate - 流式进度回调（本实现不使用；本工具不上报部分结果）
     * @param ctx - Pi 扩展上下文（`mode` 守卫与 `ui.custom` 组件挂载）
     * @returns 取消 / 结构化报错 / 运行期异常 / 完成四类结果之一
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

      let comp: AskAuthorComponent | undefined;
      try {
        // 宿主回调约定 `(tui, theme, keybindings, done)`：按键分派由组件内部 `matchesKey` 自行持有，
        // 注入的 keybindings 管理器未被消费，故以 `_kb` 标记未使用
        const result = await ctx.ui.custom<AskAuthorResult>((tui, theme, _kb, done) => {
          comp = new AskAuthorComponent(tui, theme, formModel, done);
          comp.bindAbortSignal(signal);
          return comp;
        });

        if (!result || result.cancelled) {
          return createCancelledResult({
            questions: result?.questions ?? formModel.questions,
            formTitle: result?.formTitle ?? formModel.formTitle,
            formDescription: result?.formDescription ?? formModel.formDescription,
          });
        }

        return createSuccessResult(formModel, result.answers);
      } catch (err) {
        return createRuntimeErrorResult(err, {
          questions: formModel.questions,
          formTitle: formModel.formTitle,
          formDescription: formModel.formDescription,
        });
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
     * 命令处理函数：向作者回显 ask_author 使用提示（不解析参数，通知后立即完成）
     * @param _args - 命令参数（本命令不接收参数，不使用）
     * @param ctx - Pi 扩展上下文（经 `ui.notify` 投递 info 级通知）
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
  type NormalizedOption,
  type NormalizedQuestion,
  type VisibilityCondition,
} from "./model.js";
export { AskAuthorParams, OptionSchema, QuestionSchema, ShowIfConditionSchema, type RawParams } from "./schema.js";
export { sanitizeAskAuthorArgs } from "./sanitize.js";
export { TEXTS } from "./texts.js";
export { ICONS, LAYOUT_CONFIG, MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";
export { ACTIVE_LOCALE, detectLocale } from "./i18n.js";
export { cleanOptional, cleanText, normalizeImeKey, padToVisibleWidth, safeLine } from "./format.js";
export type { AskAuthorToolResult, ResultContext } from "./tool-result.js";
export type { CallCardData, CallRenderState } from "./tool-card.js";
