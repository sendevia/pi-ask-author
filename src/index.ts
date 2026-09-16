/**
 * @file index.ts
 * @description 作者请示插件入口：注册 `ask_author` 工具与 `/ask-author` 命令
 *
 * 核心架构特性：
 * - 四类出口（取消 / 结构化错误 / 运行期异常 / 正常完成）由四个结果工厂统一产出；其中取消、结构化错误与运行期异常三类共享 `ResultContext` 的缺省收敛，完成结果由表单模型直接供给
 * - `prepareArguments` 防御性清洗兼容批量问卷与单题平铺双模式；返回文本恒以 `TEXTS.markdown` 的固定封套前缀开头（`[Author Decision Finalized]` / `[Author Decision Cancelled]` / `[Author Consultation Error]`），前缀字节稳定利于 Prompt Cache 命中
 * - 性能与生命周期：调用卡片按 args 身份记忆化派生、结果卡片复用槽位 `lastComponent`；AbortSignal 经组件级联取消；本文件不注册任何监听器与定时器，`AskAuthorComponent.dispose()`（幂等）负责回收定时器、Abort 监听与全部缓存池
 *
 * 依赖方向：index.ts 为 11 模块单向依赖图（theme → texts → {format, schema} → {model, sanitize} → {novel-markdown, view-rows, view-summary} → component → index）的入口；旁支 `sanitize.ts` 仅由本文件装配（`prepareArguments` 与 `renderCall` 两处）
 */

import { keyHint, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { AskAuthorComponent } from "./component.js";
import { cleanOptional } from "./format.js";
import { AskAuthorFormModel, type AskAuthorResult, type AuthorAnswerItem, type NormalizedQuestion } from "./model.js";
import { AskAuthorParams, type RawParams } from "./schema.js";
import { sanitizeAskAuthorArgs } from "./sanitize.js";
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
 * 提取异常对象的用户可读消息（`Error` 取 `message`，其余经 `String` 字符串化）
 * @param err - 未知异常对象
 * @returns `Error` 实例取其 `message`（可为空串），其余类型取 `String(err)`（对象为 `[object Object]`）
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
 * 复用渲染槽位既有 Text 组件就地更新卡片内容（Pi 渲染器 `lastComponent` 复用最佳实践）
 * @param content - 卡片文本内容
 * @param lastComponent - 该槽位上帧返回的组件实例（非 Text 实例时新建零边距 Text）
 * @returns 复用或新建的 `Text`（已 `setText`，其内部行缓存随 `setText` 失效）
 */
function renderCardText(content: string, lastComponent: Component | undefined): Text {
  const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  text.setText(content);
  return text;
}

/**
 * 构造取消结果（智能体封套 `[Author Decision Cancelled]` + `cancelled: true`，`answers` 恒为空数组）
 * @param ctx - 结果构造上下文（题目快照与被取消时的表单快照）
 * @returns 取消结果（`content` 为取消封套单行文本，`details` 不含 `error` 字段）
 */
function createCancelledResult(ctx: ResultContext = {}): AskAuthorToolResult {
  const { formTitle, formDescription, questions } = resolveResultContext(ctx);
  return {
    content: [{ type: "text", text: TEXTS.markdown.envelopeCancelled }],
    details: { formTitle, formDescription, questions, answers: [], cancelled: true },
  };
}

/**
 * 构造错误结果（智能体错误封套 + 用户界面提示）
 * @param reason - 面向智能体的原因
 * @param guidance - 面向智能体的纠正指引
 * @param userFacingError - 面向用户的界面提示
 * @param ctx - 结果构造上下文（缺省值由 `resolveResultContext` 收敛）
 * @returns 错误结果对象（`cancelled: false` + `error` 详情，无作答内容）
 */
function createErrorResult(
  reason: string,
  guidance: string,
  userFacingError: string,
  ctx: ResultContext = {},
): AskAuthorToolResult {
  const { formTitle, formDescription, questions } = resolveResultContext(ctx);
  return {
    content: [{ type: "text", text: TEXTS.markdown.envelopeError(reason, guidance) }],
    details: { formTitle, formDescription, questions, answers: [], cancelled: false, error: userFacingError },
  };
}

/**
 * 构造运行期异常结果（模型构建抛出错误与 `execute` 异常捕获两条路径共用本工厂）
 * @param err - 异常对象或消息（字符串经 {@link toErrorMessage} 原样返回）
 * @param ctx - 结果构造上下文（题目快照与表单快照）
 * @returns 运行期异常结果（封套原因携带 {@link toErrorMessage} 归一后的消息）
 */
function createRuntimeErrorResult(err: unknown, ctx: ResultContext = {}): AskAuthorToolResult {
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
function createSuccessResult(formModel: AskAuthorFormModel, answers: AuthorAnswerItem[]): AskAuthorToolResult {
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

// ===== 宿主边界收窄与结果卡片数据派生 =====

/**
 * 结果卡片宿主边界的**唯一**类型收窄点：把 `renderResult` 的 `details` 从未可信型别提升为 `AskAuthorResult`（工具入参边界另由 `sanitizeAskAuthorArgs` 做运行时守卫，与本函数互不覆盖）
 * 会话回放时 `details` 由转录 JSON 反序列化而来（运行期形状不可信），故先做形状闸门再断言一次；数组元素由本扩展自身写入，不在闸门范围
 * 校验项：普通对象、`cancelled`/`answers`/`questions`/`formTitle` 键存在性、`cancelled` 布尔、`answers`/`questions` 数组、`formTitle` 字符串
 * 可选 `error` / `formDescription` 不设闸门：二者仅参与字符串插值，非字符串至多渲染为退化文本（`fg` 为模板拼接，不抛出错误）
 * @param value - 宿主传入的不可信 `details` 值
 * @returns 通过形状闸门的 `AskAuthorResult`
 * @throws 任一校验项失败时抛出错误（就地崩溃，避免用错误的卡片掩盖结果损坏）
 */
function narrowResultDetails(value: unknown): AskAuthorResult {
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
function formatAnswerLine(ans: AuthorAnswerItem): string {
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

/** 调用卡片派生数据：与主题无关的纯计算结果（颜色合成每帧按当前主题现算） */
export interface CallCardData {
  /** 卡片标题（已清洗的 `formTitle`） */
  title: string;
  /** 计数标签（多题模式为 `2 题 • 6 选项`，单题模式仅 `6 选项`） */
  countLabel: string;
}

/**
 * `renderCall` 记忆化状态载荷：宿主按工具执行行创建一次、跨帧复用的可变对象（`ToolRenderContext.state`，同一行的 `renderCall` 与 `renderResult` 共享该实例）
 * 以 **args 对象身份**为键（`cachedArgs` 记身份、`cachedCard` 记派生数据），依赖宿主「流式补全整体替换 `args` 引用」的不变量（宿主经 `ToolExecutionComponent.updateArgs` 赋入新对象）：身份变化即失效重算；若宿主原地改写同一对象，缓存将滞留旧数据
 */
export interface CallRenderState {
  /** 上一次派生所用的 args 对象身份（仅作 `===` 引用比对，不读取任何属性） */
  cachedArgs?: object;
  /** 与 `cachedArgs` 配对的派生数据；两者身份同时命中时直接复用 */
  cachedCard?: CallCardData;
}

/**
 * 派生调用卡片数据（标题 + 计数标签：题目数 > 1 时附带题量，单题模式仅选项数）
 * 入参清洗、模型构建与计数归约仅在 **args 对象身份变化时**执行一次，同帧后续渲染只做一次引用比对（§2.1）
 * 缓存只存与主题无关的数据——`theme` 是身份稳定的 Proxy，缓存 ANSI 着色结果会在主题切换后滞留
 * @param args - 本次渲染的原始工具入参（未经 `sanitizeAskAuthorArgs` 清洗，流式期间可能为不完整对象）
 * @param state - 宿主按工具行复用、跨帧身份稳定的可变状态载荷
 * @returns 派生卡片数据（`state` 身份命中时直接复用，否则新算并写回 `state.cachedCard`）
 */
function resolveCallCard(args: RawParams, state: CallRenderState): CallCardData {
  if (state.cachedArgs === args && state.cachedCard) return state.cachedCard;

  const model = new AskAuthorFormModel(sanitizeAskAuthorArgs(args));
  const totalOpts = model.questions.reduce((sum, q) => sum + q.options.length, 0);
  const card: CallCardData = {
    title: model.formTitle,
    countLabel:
      model.questions.length > 1
        ? TEXTS.card.callQuestionAndOptionCount(model.questions.length, totalOpts)
        : TEXTS.card.callOptionCountOnly(totalOpts),
  };

  state.cachedArgs = args;
  state.cachedCard = card;
  return card;
}

// ===== 插件入口与生命周期集成 =====

/**
 * `ask-author` 扩展插件主入口工厂（仅完成注册，启动期不执行任何交互）
 * @param pi - Pi 扩展运行时 API 实例
 */
export default function askAuthorExtension(pi: ExtensionAPI): void {
  // 注册 ask_author 工具：显式实例化 TState，避免宿主泛型缺省值把 context.state 退化为 any
  pi.registerTool<typeof AskAuthorParams, AskAuthorResult, CallRenderState>({
    name: TEXTS.tool.name,
    label: TEXTS.tool.label,
    description: TEXTS.tool.description,
    promptSnippet: TEXTS.tool.promptSnippet,
    // 宿主接口要求可变 `string[]`；TEXTS 为 `as const` 只读元组，故展开构造可变副本
    promptGuidelines: [...TEXTS.tool.promptGuidelines],
    parameters: AskAuthorParams,
    // 交互式 UI 独占编辑器（`ctx.ui.custom`）：串行执行避免与其他工具并发挂载组件
    executionMode: "sequential",
    // 宿主在 Schema 校验前调用：清洗为白名单形状，并兼容未按当前 Schema 书写的别名/包裹入参
    prepareArguments: sanitizeAskAuthorArgs,

    /**
     * 工具执行主流程：归一化标题 → 守卫 → 构建模型 → 启动交互式 TUI → 映射四类结果
     * 守卫顺序：信号已中止 → 取消；非 TUI 模式 → 非交互错误；模型构建抛出错误 → 运行期异常；无有效题目 → 空题目错误；`ui.custom` 回传结果映射为取消 / 完成；`finally` 兜底 `dispose()`
     * @param _toolCallId - 宿主工具调用 ID（本实现不使用）
     * @param rawParams - `prepareArguments` 清洗并经宿主 Schema 校验后的入参（宿主 `structuredClone` 副本，与清洗产物非同一引用）
     * @param signal - 宿主取消信号（可缺省；Esc / Ctrl+C 级联终止交互界面）
     * @param _onUpdate - 流式进度回调（本实现不使用；本工具不上报部分结果）
     * @param ctx - Pi 扩展上下文（`mode` 守卫与 `ui.custom` 组件挂载）
     * @returns 取消 / 结构化报错 / 运行期异常 / 完成四类结果之一；模型构建与 `ui.custom` 阶段的异常均被捕获并转为运行期异常结果
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
        // 宿主回调约定 `(tui, theme, keybindings, done)`：按键分派由组件内部 `matchesKey` 自持，
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

    /**
     * 会话回放调用卡片渲染（复用槽位既有 Text；派生按 args 身份记忆化）
     * `args` 由宿主原样透传（流式期间可能不完整，且未经 Schema 校验；此处 `RawParams` 类型只是宿主泛型的静态断言），故必须先经 `sanitizeAskAuthorArgs` 收敛再构建模型
     * @param args - 原始工具入参（运行时未经清洗，可能为不完整对象）
     * @param theme - 当前 TUI 主题实例
     * @param context - 宿主渲染上下文（`state` 记忆化载荷 / `lastComponent` 槽位复用）
     * @returns 调用卡片 `Text`（复用 `context.lastComponent` 就地更新）
     */
    renderCall(args, theme, context) {
      const card = resolveCallCard(args, context.state);
      const label = theme.fg("accent", TEXTS.tool.label);
      const body = `${theme.bold(card.title)} ${theme.fg("muted", `(${card.countLabel})`)}`;
      return renderCardText(`${label} ${body}`, context.lastComponent);
    },

    /**
     * 会话回放结果卡片渲染（错误 / 取消 / 完成三态，展开态追加答卷明细）
     * 错误态优先于取消态判定：`details.error` 为真值时即使 `cancelled` 为 true 也按错误呈现（本扩展产出的 details 中二者互斥：`createErrorResult` 恒置 `cancelled: false`）
     * @param result - 工具执行结果（`details` 须经 {@link narrowResultDetails} 收窄）
     * @param expanded - 是否展开答卷明细（同组的 `isPartial` 未使用：本工具不上报流式部分结果）
     * @param theme - 当前 TUI 主题实例
     * @param context - 宿主渲染上下文（`lastComponent` 槽位复用；`state` 由 `renderCall` 独占使用）
     * @returns 结果卡片 `Text`（复用 `context.lastComponent` 就地更新）
     */
    renderResult(result, { expanded }, theme, context) {
      const details = narrowResultDetails(result.details);

      if (details.error) {
        const errorTitle = `${theme.fg("error", theme.bold(TEXTS.card.resultErrorShort))} ${theme.fg("muted", `${TEXTS.common.bulletPrefix}${details.error}`)}`;
        if (!expanded) {
          return renderCardText(
            `${errorTitle} (${keyHint("app.tools.expand", TEXTS.card.expandHint)})`,
            context.lastComponent,
          );
        }
        return renderCardText(
          `${errorTitle}\n${TEXTS.card.errorBullet(theme.fg("error", details.error))}`,
          context.lastComponent,
        );
      }

      if (details.cancelled) {
        return renderCardText(theme.fg("warning", TEXTS.card.resultCancelled), context.lastComponent);
      }

      const countLabel = `${theme.fg("success", theme.bold(TEXTS.card.resultCompleted))} ${theme.fg(
        "muted",
        `${TEXTS.common.bulletPrefix}${TEXTS.card.resultCount(details.answers.length)}`,
      )}`;
      if (!expanded) {
        return renderCardText(
          `${countLabel} (${keyHint("app.tools.expand", TEXTS.card.expandHint)})`,
          context.lastComponent,
        );
      }

      const lines: string[] = [
        countLabel,
        ...details.answers.map((ans) =>
          TEXTS.card.optionBullet(theme.bold(ans.questionTitle), theme.fg("accent", formatAnswerLine(ans))),
        ),
      ];
      return renderCardText(lines.join("\n"), context.lastComponent);
    },
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
export { AskAuthorFormModel, type AskAuthorResult, type AuthorAnswerItem, type NormalizedQuestion } from "./model.js";
export { AskAuthorParams, type RawParams } from "./schema.js";
export { sanitizeAskAuthorArgs } from "./sanitize.js";
export { TEXTS, LAYOUT_CONFIG, ICONS } from "./texts.js";

