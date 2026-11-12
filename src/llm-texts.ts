/**
 * @file llm-texts.ts
 * @description 面向大语言模型的协议文案：工具元数据、字段描述、推演提示词与返回封套模板
 *
 * 全部恒为英文，不参与语言切换；唯一非英文片段是封套的选项标签定界符 `【】`
 */

import { MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";

/** 面向大模型的提示词、字段描述与返回封套：固定英文，提升前缀缓存命中率 */
export const LLM_TEXTS = {
  /** 工具注册元数据（`label` 面向作者，取自语言文件） */
  tool: {
    /** 工具调用名 */
    name: "ask_author",
    /** 工具说明：能力概要与适用场景 */
    description:
      "Ask the author to decide between concrete narrative options in an interactive terminal form. Handles a single question or a batch, optional draft previews, author notes, conditional questions, and live follow-up questions generated while the author answers.",
    /** `Available tools` 区块的单行条目（动词引导，无句末标点） */
    promptSnippet: "Ask the author to pick narrative directions in a terminal form",
    /**
     * `Guidelines` 区块附加条目
     * 宿主扁平追加且不加工具名前缀，故每条首词显式点名 `ask_author`
     */
    promptGuidelines: [
      "ask_author: Use it when the author must choose a plot branch, character action, scene direction, or setting; do not ask the same question in chat first.",
      "ask_author: Prefer one call over several: flat mode (formTitle + question + options) for a single decision, the questions array for related decisions.",
      "ask_author: Write option labels as concrete actions, put consequences in description, and add preview only when a Markdown draft or storyboard helps the choice.",
      "ask_author: Give a short formTitle and a tabLabel for every long question title; omit fields that use defaults.",
      "ask_author: Add a question id only when a showIf or expansion.insert.after refers to it; showIf may only point at an earlier question's option label or answered.",
      'ask_author: Pass expansion when follow-up decisions depend on the answers: declare only the first question and let the same model add questions and options on each confirmation; expansion.insert picks "follow" (default), "tail", or {"after":"question_id"}.',
      "ask_author: Set question.expansion per question: false keeps that question static, {guidance, insert} gives it its own follow-up direction; questions without it inherit the form-level expansion.",
      "ask_author: The author can multi-select, add notes, and edit drafts; confirmed drafts return as [Draft directive: ...] lines. Treat [Author Decision Cancelled] as no decision, and [Author Consultation Error] as a request to fix the arguments once.",
    ],
  },

  /** TypeBox 字段描述字典（单句英文；数量约束经 {@link MAX_OPTIONS} / {@link MAX_QUESTIONS} 插值） */
  schema: {
    // ===== 选项字段（OptionSchema） =====
    /** 选项标签：简明动作导向 */
    optionLabel: "Concrete action or choice label",
    /** 选项情节推演（作者端呈现于预览面板） */
    optionDesc: "Consequences or rationale (optional)",
    /** 选项草稿预览（作者端呈现于预览面板） */
    optionPreview: "Markdown draft or storyboard for this option (optional)",
    /** 选项批注占位符（作为选项补充说明编辑器的输入框占位文本） */
    optionCustomPlaceholder: "Placeholder for the author's note on this option (optional)",
    /** 选项显示条件（不成立时不展示该选项） */
    optionShowIf: "Show only if an earlier answer matches; array means all must hold (optional)",

    // ===== 题目字段（QuestionSchema） =====
    /** 题目 ID（仅供 `showIf` 与 `expansion.insert.after` 引用） */
    questionId: "Id referenced by showIf and expansion.insert.after (optional)",
    /** 题目标题（呈现为题头与总览页条目） */
    questionTitle: "Question text",
    /** Tab 短标签（缺省时显示 `Q<序号>`） */
    questionTabLabel: "Short tab label (default: Q<index>)",
    /** 题目背景说明（呈现为题头下方的上下文行） */
    questionDesc: "Context shown under the question (optional)",
    /** 多选开关（默认 false） */
    questionMultiSelect: "Allow multiple selections (default false)",
    /** 最小勾选数（默认 1，仅多选生效） */
    questionMinSelect: "Minimum selections, multi-select only (default 1)",
    /** 最大勾选数（默认全部选项，仅多选生效） */
    questionMaxSelect: "Maximum selections, multi-select only (default: all options)",
    /** 零勾选提交开关（默认 false，单选与多选均生效） */
    questionAllowEmpty: "Allow submitting without a selection (default false)",
    /** 候选选项列表 */
    questionOptions: `Options (1-${MAX_OPTIONS}, 2-10 recommended)`,
    /** 自由批注开关（默认 true，开启后作者可提交非选项文本） */
    questionAllowCustom: "Allow author notes (default true)",
    /** 作者批注占位符（作为题目补充说明编辑器的输入框占位文本） */
    questionCustomPlaceholder: "Placeholder for the author's note (optional)",
    /** 题目显示条件（不成立时该题不展示，也不计入答卷） */
    questionShowIf: "Show only if an earlier answer matches; array means all must hold (optional)",
    /** 题目级推演配置（缺省继承表单级 `expansion`） */
    questionExpansion:
      'Follow-up for this question only: false skips it, {"guidance":"...","insert":"follow"|"tail"|{"after":"question_id"}} overrides the form-level expansion (optional)',
    /** 显示条件引用的题目 ID（必须为更早出现的题目） */
    conditionQuestionId: "Earlier question id",
    /** 显示条件匹配的选项（选中该选项时条件成立） */
    conditionOption: "Option label of that question that activates the condition",
    /** 显示条件的作答存在性（缺省等价于 true，给出 `option` 时忽略） */
    conditionAnswered: "Any answer (default true) or no answer (false); ignored when option is set",

    // ===== 表单层字段（AskAuthorParams 批量模式） =====
    /** 问卷标题（呈现为卡片标题与总览页标题） */
    formTitle: "Short title for the consultation",
    /** 问卷背景（呈现为问卷级上下文） */
    formDesc: "Overall context (optional)",
    /** 批量模式题目数组（与平铺单题模式互斥） */
    formQuestions: `Questions (1-${MAX_QUESTIONS}); batch related decisions in one call`,

    // ===== 单题平铺模式 =====
    /** 平铺模式的题目标题（与批量模式的 `questionTitle` 同义） */
    formSingleQuestion: "Question for flat mode",
    /** 平铺单题模式字段描述的统一前缀（`schema.ts` 逐字段拼接） */
    flatPrefix: "(Flat single-question mode only) ",
    /** 平铺模式候选选项列表 */
    flatQuestionOptions: `Options for flat mode (1-${MAX_OPTIONS}, 2-10 recommended)`,

    // ===== 实时推演字段（ExpansionSchema） =====
    /** 实时推演开关（`guidance` / `insert` 作为全部题目的缺省值） */
    expansion:
      "Generate follow-up questions and options while the author answers; guidance and insert are defaults for every question (optional)",
    /** 推演题目总量上限（含已声明题目） */
    expansionMaxQuestions: `Question cap including declared ones (default ${MAX_QUESTIONS})`,
    /** 推演方向指示（作为长期要求传给推演模型） */
    expansionGuidance: "Standing hint for what the expansion should probe (optional)",
    /** 推演题目插入位置（三选一预设或锚点） */
    expansionInsert:
      '"follow" (default, after the answered question), "tail" (end of the form), or {"after":"question_id"} (optional)',
    /** 自定义插入位置的锚点题目 ID */
    expansionInsertAfter: "Declared question id to insert after",
  },

  /** 实时推演协议（系统提示词、用户消息前缀与诊断文案） */
  expansion: {
    /** 推演系统提示词（约束输出结构与新增范围） */
    systemPrompt: `You extend an interactive author decision form while the author answers it.

The conversation above is the author's live writing session: take story facts, character names, established tone, and standing requests from it instead of inventing them.

Input JSON: formTitle, formDescription, guidance, insert, maxAdditionalQuestions, trigger {index, id, title}, questions[].
Each question carries index (1-based), id, title, tabLabel, description, multiSelect, minSelect, maxSelect, allowEmpty, allowCustom, showIf, expansion {enabled, guidance, insert, addedQuestions, addedOptions}, visible, status ("answered" | "skipped" | "unanswered" | "hidden"), selected (option labels), note, and options[] with label, description, hasPreview, showIf, visible, selected, note.
trigger is the question the author just confirmed; answered questions are settled, unanswered and hidden ones are still open.

Return JSON only:
{"questions":[{"id":"unique_id","title":"...","description":"...","options":[{"label":"...","description":"..."}]}],"options":[{"questionId":"existing_id","options":[{"label":"..."}]}]}

Rules:
- Add at most maxAdditionalQuestions questions; fewer is better, and {"questions":[],"options":[]} is valid when the answers already determine the next step.
- Give new questions unique ids and 2-6 concrete options; put consequences in description.
- Every new question sets its own mode: multiSelect, minSelect, maxSelect, allowEmpty, allowCustom, showIf, and expansion, independently of the other questions.
- Set expansion of a new question to false when confirming it needs no follow-up; give {"guidance":"...","insert":"follow"|"tail"|{"after":"question_id"}} when it needs its own.
- showIf takes {"questionId":"id","option":"label"} or {"questionId":"id","answered":true} and may only reference a question above the insertion point or one of your earlier new questions.
- Continue from the shown progress: never repeat a declared question, never repeat a declared label, never contradict a selection or note the author already made.
- Add options to a declared question only when its answers reveal a choice it cannot express; use its id and unused labels.
- No prose, no code fences, no trailing commas.`,
    /** 推演用户消息前缀（后接 JSON 载荷） */
    userPreamble: "Extend this author decision form. Input JSON:",
    /** 在途工具调用的占位结果正文（结果待表单提交后返回） */
    pendingToolResult: "The author is answering this form in the terminal; this call's result arrives once the form is submitted.",
    /** 推演失败诊断（作者界面经 `status.expansionFailed` 呈现，不直接展示原文） */
    errors: {
      /** 当前会话没有可用模型 */
      noModel: "no model is available for live expansion",
      /** 推演请求被中止 */
      aborted: "live expansion was aborted",
      /** 供应商返回错误终止 */
      providerFailed: "the expansion request failed",
      /** 回复不是可解析的 JSON 对象 */
      invalidReply: "the expansion reply was not a JSON object",
    },
  },

  /**
   * 返回封套与纠正指令模板（全英文固定结构）
   *
   * 首行令牌 `[Author Decision Finalized]` / `[Author Decision Cancelled]` / `[Author Consultation Error]`；行内令牌 `[Author note: …]` / `[Draft directive: …]`；`【】` 是本区段唯一的非英文片段
   */
  markdown: {
    // ===== 封套骨架 =====
    /** 完成封套首行标识 */
    envelopePrefix: "[Author Decision Finalized]",
    /** 完成封套收尾指令（驱动后续写作） */
    envelopeSuffix:
      "Proceed with the author decisions and draft directives above without conversational acknowledgment.",
    /** 取消封套（标识行 + 禁止沿用被丢弃决策的处置指令） */
    envelopeCancelled:
      "[Author Decision Cancelled]\nThe author cancelled. Do not proceed with the discarded decision; propose next steps or ask for clarification.",
    /**
     * 构建错误封套（标识行 + 原因行 + 指引行）
     * @param reason - 失败原因（取自 `errorReasons`）
     * @param guidance - 纠正指引（取自 `errorGuidances`）
     */
    envelopeError: (reason: string, guidance: string) =>
      `[Author Consultation Error]\nFailed to consult author: ${reason}\nGuidance: ${guidance}`,
    /** 错误封套原因行字典（按失败路径枚举） */
    errorReasons: {
      /** 非交互式终端环境无法启动 TUI（对应作者端 `status.errorNonTui`） */
      nonTui: "Interactive TUI is unavailable in the current mode.",
      /** 入参无有效题目或选项（对应作者端 `status.errorNoQuestions`） */
      noQuestions: "No questions or options were provided.",
      /** 构建执行期异常的原因行（`details` 为宿主异常摘要） */
      runtimeError: (details: string) => `Consultation UI failed: ${details}`,
      /** 自适应条件引用无效（对应作者端 `status.errorInvalidCondition`） */
      invalidCondition: (details: string) => `Invalid condition or insertion anchor: ${details}`,
      /** 请求了实时推演但当前会话没有可用模型 */
      expansionUnavailable: "Live expansion was requested but no model is available in this session.",
    },
    /** 错误封套纠正指引行字典（与 `errorReasons` 一一对应） */
    errorGuidances: {
      /** `nonTui` 的纠正指引 */
      nonTui: "Use defaults, or ask the user in chat if the decision is crucial.",
      /** `noQuestions` 的纠正指引 */
      noQuestions: "Provide at least one question with concrete options.",
      /** `runtimeError` 的纠正指引 */
      runtimeError: "Check the arguments and retry with valid questions and options.",
      /** `invalidCondition` 的纠正指引 */
      invalidCondition:
        "Reference an earlier question id plus one of its option labels, use answered, or point expansion.insert.after at a declared question id.",
      /** `expansionUnavailable` 的纠正指引 */
      expansionUnavailable:
        "Drop the expansion field and declare the questions directly, or retry in a session with a model selected.",
    },
    /** 自适应条件校验的英文诊断消息（拼入错误封套原因行） */
    adaptiveErrors: {
      /** 条件引用的题目 ID 不存在 */
      unknownQuestion: (questionId: string) => `showIf references unknown question id "${questionId}"`,
      /** 条件引用的题目不在该条件所属题目之前 */
      forwardQuestion: (questionId: string) => `showIf may only reference an earlier question, got "${questionId}"`,
      /** 条件引用的选项标签在目标题目中不存在 */
      unknownOption: (questionId: string, option: string) =>
        `showIf option "${option}" does not exist in question "${questionId}"`,
      /** 推演插入锚点引用的题目 ID 不存在 */
      unknownInsertAnchor: (questionId: string) =>
        `expansion.insert.after references unknown question id "${questionId}"`,
    },
    /** 空答卷封套正文（位于首尾标识之间） */
    envelopeEmpty: "The author submitted no answers. Use your defaults, or ask a follow-up if the decision is crucial.",
    /** 单题无任何作答（未勾选且无批注）时的占位正文 */
    noSelection: "(No selection; the author skipped this question)",
    /** 整卷补充行：独占一行，位于作答行之后、收尾指令之前（`text` 已过 `sanitizeEnvelopeText`） */
    supplementLine: (text: string) => `[Author supplement: ${text}]`,

    // ===== 行内令牌定界符（供 `model.ts` 包装作者文本） =====
    /** 行内批注令牌左定界符（尾随 1 空格，与 `noteSuffix` 成对） */
    notePrefix: "[Author note: ",
    /** 行内批注令牌右定界符 */
    noteSuffix: "]",
    /** 分镜头草稿指令令牌左定界符（尾随 1 空格，与 `draftDirectiveSuffix` 成对） */
    draftDirectivePrefix: "[Draft directive: ",
    /** 分镜头草稿指令令牌右定界符 */
    draftDirectiveSuffix: "]",

    // ===== 作答行组装 =====
    /** 构建封套单题作答行（`index` 为 1-based 题号） */
    answerLine: (index: number, title: string, body: string) => `${index}. [${title}]: ${body}`,
    /** 作答行内多个片段（选项推演、批注令牌、草稿指令）的分隔符（纯 ASCII；作者文本中的 `;` 已在 `sanitizeEnvelopeText` 归一为全角 `；`） */
    partSeparator: "; ",
    /** 草稿压缩为单行指令时的分镜头片段分隔符（纯 ASCII） */
    draftSegmentSeparator: " / ",
    /**
     * 构建带情节推演的选项片段：`【标签】推演 [Author note: …] [Draft directive: …]`
     * @param label - 选项标签原文（调用方已过 `sanitizeEnvelopeText`）
     * @param desc - 选项情节推演 / 设定阐述（调用方已过 `sanitizeEnvelopeText`）
     * @param draftDirective - 已包装的 `[Draft directive: …]` 令牌（非原文）
     * @param note - 已包装的 `[Author note: …]` 令牌（非原文）
     * @returns 输出顺序为标签 → 推演 → 批注 → 草稿指令
     */
    optionWithDesc: (label: string, desc: string, draftDirective?: string, note?: string) =>
      `【${label}】${desc}${note ? ` ${note}` : ""}${draftDirective ? ` ${draftDirective}` : ""}`,
    /**
     * 构建无情节推演的选项片段：`【标签】[Author note: …] [Draft directive: …]`
     * @param label - 选项标签原文（调用方已过 `sanitizeEnvelopeText`）
     * @param draftDirective - 已包装的 `[Draft directive: …]` 令牌（非原文）
     * @param note - 已包装的 `[Author note: …]` 令牌（非原文）
     * @returns 输出顺序为标签 → 批注 → 草稿指令
     */
    optionWithoutDesc: (label: string, draftDirective?: string, note?: string) =>
      `【${label}】${note ? ` ${note}` : ""}${draftDirective ? ` ${draftDirective}` : ""}`,
    /**
     * 构建未选中选项上的孤立批注片段（英文前缀 + 标签 + 批注令牌）
     * @param label - 选项标签原文（调用方已过 `sanitizeEnvelopeText`）
     * @param note - 已包装的 `[Author note: …]` 令牌（非原文）
     */
    unselectedOptionNote: (label: string, note: string) => `[Author note on unselected option 【${label}】] ${note}`,

    // ===== 封套编译期英文替换（覆盖作者端占位） =====
    /** 生成题目标题的英文占位（`index` 为 1-based 题号；仅封套编译期替换 `fallbacks` 中的作者占位） */
    fallbackQuestionTitle: (index: number) => `Question ${index}`,
    /** 生成选项标签的英文占位（`index` 为 1-based 选项序号；仅封套编译期替换 `fallbacks` 中的作者占位） */
    fallbackOptionLabel: (index: number) => `Option ${index}`,
  },
} as const;
