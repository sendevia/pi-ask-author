/**
 * @file llm-texts.ts
 * @description 面向大语言模型的协议文案：工具元数据、TypeBox 字段描述、实时推演系统提示词与返回封套模板
 *
 * 核心架构特性：
 * - 全部文案恒为英文，不参与语言切换，保证封套与工具声明的前缀缓存稳定
 * - 唯一非英文片段为封套选项标签定界符 `【】`；作者文本在 `model.ts` 编译前已经消毒，无法击穿令牌边界
 * - 新增字段描述或错误路径时只需扩充本文件，作者界面文案仍由 `lang/*.json` 提供
 *
 * 依赖方向：llm-texts.ts → layout.ts（`MAX_OPTIONS` / `MAX_QUESTIONS` 插值）；被 texts.ts 组装进 `TEXTS`
 */

import { MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";

/** 面向大模型的提示词、字段描述与返回封套：作为协议常量固定为英文，提升前缀缓存命中率 */
export const LLM_TEXTS = {
  /** 工具注册元数据（`label` 面向作者，取自语言文件，故在此缺席） */
  tool: {
    /** 工具调用名（LLM 协议标识，注册为 `ask_author`；不出现在作者界面） */
    name: "ask_author",
    /** 工具说明（LLM 端英文；一句话能力概要与适用场景） */
    description:
      "Ask the author to decide between concrete narrative options in an interactive terminal form. Handles a single question or a batch, optional draft previews, author notes, conditional questions, and live follow-up questions generated while the author answers.",
    /** `Available tools` 区块单行条目（LLM 端英文；动词引导，无句末标点，缺省则工具不进入该区块） */
    promptSnippet: "Ask the author to pick narrative directions in a terminal form",
    /**
     * `Guidelines` 区块附加条目（LLM 端英文；分类标签前缀 + 行为要求）
     * 约定：宿主把条目扁平追加进 `Guidelines` 且不加工具名前缀，故每条首词必须显式点名 `ask_author`
     */
    promptGuidelines: [
      "ask_author: Use it when the author must choose a plot branch, character action, scene direction, or setting; do not ask the same question in chat first.",
      "ask_author: Prefer one call over several: flat mode (formTitle + question + options) for a single decision, the questions array for related decisions.",
      "ask_author: Write option labels as concrete actions, put consequences in description, and add preview only when a Markdown draft or storyboard helps the choice.",
      "ask_author: Give a short formTitle and a tabLabel for every long question title; omit fields that use defaults.",
      "ask_author: Add a question id only when a showIf or expansion.insert.after refers to it; showIf may only point at an earlier question's option label or answered.",
      'ask_author: Pass expansion when follow-up decisions depend on the answers: declare only the first question and let the same model add questions and options on each confirmation; expansion.insert picks "follow" (default), "tail", or {"after":"question_id"}.',
      "ask_author: The author can multi-select, add notes, and edit drafts; confirmed drafts return as [Draft directive: ...] lines. Treat [Author Decision Cancelled] as no decision, and [Author Consultation Error] as a request to fix the arguments once.",
    ],
  },

  /** LLM 端 TypeBox 字段描述字典（单句浓缩英文，仅声明语义、必要性与省略规则；数量约束来自 {@link MAX_OPTIONS} / {@link MAX_QUESTIONS} 插值） */
  schema: {
    // ===== 选项字段（OptionSchema） =====
    /** 选项标签（必须填写；要求简明动作导向，禁止占位式命名） */
    optionLabel: "Concrete action or choice label",
    /** 选项情节推演（可选；作者端渲染为「情节设定推演」预览面板） */
    optionDesc: "Consequences or rationale (optional)",
    /** 选项草稿预览（可选；作者端渲染为「正文草稿/分镜头试撰写」预览面板） */
    optionPreview: "Markdown draft or storyboard for this option (optional)",
    /** 选项批注占位符（可选；作者端作为选项补充说明编辑器的输入框占位文本） */
    optionCustomPlaceholder: "Placeholder for the author's note on this option (optional)",
    /** 选项显示条件（可选；条件不成立时该选项不展示） */
    optionShowIf: "Show only if an earlier answer matches; array means all must hold (optional)",

    // ===== 题目字段（QuestionSchema） =====
    /** 题目 ID（可选；仅在后续 showIf 或 `expansion.insert.after` 引用时需要） */
    questionId: "Id referenced by showIf and expansion.insert.after (optional)",
    /** 题目标题（必须填写；作者端呈现为题头与总览页条目） */
    questionTitle: "Question text",
    /** Tab 栏短标签（可选；缺省时 Tab 栏显示 `Q<序号>`，显式给出可让作者在一屏内区分多题） */
    questionTabLabel: "Short tab label (default: Q<index>)",
    /** 题目背景说明（可选；作者端呈现为题头下方的上下文行） */
    questionDesc: "Context shown under the question (optional)",
    /** 多选开关（可选；默认 false，开启后作者端展示多选模式标签与方框勾选指示符） */
    questionMultiSelect: "Allow multiple selections (default false)",
    /** 最小勾选数（可选；默认 1，仅多选生效，作者端据此标注强制下限） */
    questionMinSelect: "Minimum selections, multi-select only (default 1)",
    /** 最大勾选数（可选；默认全部选项，仅多选生效，小于选项总数时作者端追加上限标注） */
    questionMaxSelect: "Maximum selections, multi-select only (default: all options)",
    /** 零勾选提交开关（可选；默认 false，单选与多选均生效） */
    questionAllowEmpty: "Allow submitting without a selection (default false)",
    /** 候选选项列表（必须填写；1~{@link MAX_OPTIONS} 项；建议 2~10 项） */
    questionOptions: `Options (1-${MAX_OPTIONS}, 2-10 recommended)`,
    /** 自由批注开关（可选；默认 true，开启后作者端可额外提交非选项文本） */
    questionAllowCustom: "Allow author notes (default true)",
    /** 作者批注占位符（可选；作者端作为题目补充说明编辑器的输入框占位文本） */
    questionCustomPlaceholder: "Placeholder for the author's note (optional)",
    /** 题目显示条件（可选；条件不成立时该题不展示，也不计入答卷） */
    questionShowIf: "Show only if an earlier answer matches; array means all must hold (optional)",
    /** 显示条件引用的题目 ID（必须为本次表单中更早出现的题目） */
    conditionQuestionId: "Earlier question id",
    /** 显示条件匹配的选项（引用题目的选项标签；作者选中该选项时条件成立） */
    conditionOption: "Option label of that question that activates the condition",
    /** 显示条件的作答存在性（缺省等价于 true；与 option 同时给出时忽略） */
    conditionAnswered: "Any answer (default true) or no answer (false); ignored when option is set",

    // ===== 表单层字段（AskAuthorParams 批量模式） =====
    /** 问卷标题（必须填写；作者端呈现为卡片标题与总览页标题） */
    formTitle: "Short title for the consultation",
    /** 问卷背景（可选；作者端呈现为问卷级上下文） */
    formDesc: "Overall context (optional)",
    /** 批量模式题目数组（可选；1~{@link MAX_QUESTIONS} 题；与平铺单题模式互斥） */
    formQuestions: `Questions (1-${MAX_QUESTIONS}); batch related decisions in one call`,

    // ===== 单题平铺模式 =====
    /** 平铺模式的题目标题（可选；与批量模式的 `questionTitle` 同义） */
    formSingleQuestion: "Question for flat mode",
    /** 平铺单题模式字段描述的统一区分前缀（LLM 端英文，`schema.ts` 逐字段拼接） */
    flatPrefix: "(Flat single-question mode only) ",
    /** 平铺模式候选选项列表（可选；1~{@link MAX_OPTIONS} 项；建议 2~10 项） */
    flatQuestionOptions: `Options for flat mode (1-${MAX_OPTIONS}, 2-10 recommended)`,

    // ===== 实时推演字段（ExpansionSchema） =====
    /** 实时推演开关（可选；开启后作者确认答案时由同一模型追加题目与选项） */
    expansion:
      "Generate follow-up questions and options while the author answers; insert controls where they land (optional)",
    /** 推演题目总量上限（可选；缺省为全部可用题目数） */
    expansionMaxQuestions: `Question cap including declared ones (default ${MAX_QUESTIONS})`,
    /** 推演方向指示（可选；作为长期要求传给推演模型） */
    expansionGuidance: "Standing hint for what the expansion should probe (optional)",
    /** 推演题目插入位置（三选一预设） */
    expansionInsert:
      '"follow" (default, after the answered question), "tail" (end of the form), or {"after":"question_id"} (optional)',
    /** 自定义插入位置的锚点题目 ID */
    expansionInsertAfter: "Declared question id to insert after",
  },

  /**
   * 实时推演协议（作者确认答案后由同一模型追加题目与选项；全英文，输出约束为纯 JSON）
   */
  expansion: {
    /** 推演系统提示词（约束输出结构与新增范围，禁止复述既有内容） */
    systemPrompt: `You extend an interactive author decision form while the author answers it.

Input JSON: formTitle, formDescription, guidance, insert, maxAdditionalQuestions, questions (with ids), answers (selected labels and notes).

Return JSON only:
{"questions":[{"id":"unique_id","title":"...","description":"...","options":[{"label":"...","description":"..."}]}],"options":[{"questionId":"existing_id","options":[{"label":"..."}]}]}

Rules:
- Add at most maxAdditionalQuestions questions; fewer is better.
- New questions may also set multiSelect, minSelect, maxSelect, allowEmpty; every option needs a label.
- Add options to a declared question only when the answers reveal a choice it cannot express; use its id and unused labels.
- Give new questions unique ids and 2-6 concrete options; put consequences in description.
- Never repeat a declared question or a declared label.
- showIf takes {"questionId":"id","option":"label"} or {"questionId":"id","answered":true} and may only reference a question above the insertion point or one of your earlier new questions.
- Reply {"questions":[],"options":[]} when the answers already determine the next step.
- No prose, no code fences, no trailing commas.`,
    /** 推演用户消息前缀（英文单行，后接 JSON 载荷） */
    userPreamble: "Extend this author decision form. Input JSON:",
    /** 推演失败诊断（英文短句；作者界面经 `status.expansionFailed` 呈现，不直接展示原文） */
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
   * LLM 端返回封套与纠正指令模板（全英文确定性结构，提升 Prompt Cache 命中率）
   *
   * 约定：首行方括号封套令牌 `[Author Decision Finalized]` / `[Author Decision Cancelled]` / `[Author Consultation Error]`；行内令牌 `[Author note: …]` / `[Draft directive: …]`；选项标签定界符 `【】`
   * 语言归属：`【】` 是本区段唯一的非英文片段，`model.ts` 的 `sanitizeEnvelopeText` 剥离作者文本中的 `【】` 并把 ASCII `;` 归一为全角 `；`，插值文本无法击穿上述定界符
   */
  markdown: {
    // ===== 封套骨架 =====
    /** 完成封套首行标识（固定英文令牌，恒为返回正文第一行） */
    envelopePrefix: "[Author Decision Finalized]",
    /** 完成封套收尾指令（固定英文单行，驱动后续写作） */
    envelopeSuffix:
      "Proceed with the author decisions and draft directives above without conversational acknowledgment.",
    /** 取消封套（固定两行：标识行 + 禁止沿用被丢弃决策的英文处置指令） */
    envelopeCancelled:
      "[Author Decision Cancelled]\nThe author cancelled. Do not proceed with the discarded decision; propose next steps or ask for clarification.",
    /**
     * 构建错误封套（固定三行：标识行 + 原因行 + 指引行）
     * @param reason - 面向 LLM 的英文失败原因（取自 `errorReasons`）
     * @param guidance - 面向 LLM 的英文纠正指引（取自 `errorGuidances`）
     */
    envelopeError: (reason: string, guidance: string) =>
      `[Author Consultation Error]\nFailed to consult author: ${reason}\nGuidance: ${guidance}`,
    /** 错误封套原因行字典（英文单句，按失败路径枚举） */
    errorReasons: {
      /** 非交互式终端环境无法启动 TUI（对应作者端 `status.errorNonTui`） */
      nonTui: "Interactive TUI is unavailable in the current mode.",
      /** 入参无有效题目或选项（对应作者端 `status.errorNoQuestions`） */
      noQuestions: "No questions or options were provided.",
      /** 构建执行期异常的原因行（`details` 为宿主异常摘要，对应作者端 `status.errorExecutionFailed`） */
      runtimeError: (details: string) => `Consultation UI failed: ${details}`,
      /** 自适应条件引用无效（对应作者端 `status.errorInvalidCondition`） */
      invalidCondition: (details: string) => `Invalid condition or insertion anchor: ${details}`,
      /** 请求了实时推演但当前会话没有可用模型 */
      expansionUnavailable: "Live expansion was requested but no model is available in this session.",
    },
    /** 错误封套纠正指引行字典（英文单句，与 `errorReasons` 一一对应） */
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
    /** 自适应条件引用校验的英文诊断消息（拼入错误封套原因行） */
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
    /** 空答卷封套正文（作者未作答时的英文处置指令，位于首尾标识之间） */
    envelopeEmpty: "The author submitted no answers. Use your defaults, or ask a follow-up if the decision is crucial.",
    /** 单题无任何作答（未勾选且无批注）时的英文占位正文 */
    noSelection: "(No selection; the author skipped this question)",

    // ===== 行内令牌定界符（左右成对，供 `model.ts` 包装作者文本） =====
    /** 行内批注令牌左定界符（尾随 1 空格，与 `noteSuffix` 成对） */
    notePrefix: "[Author note: ",
    /** 行内批注令牌右定界符 */
    noteSuffix: "]",
    /** 分镜头草稿指令令牌左定界符（尾随 1 空格，与 `draftDirectiveSuffix` 成对） */
    draftDirectivePrefix: "[Draft directive: ",
    /** 分镜头草稿指令令牌右定界符 */
    draftDirectiveSuffix: "]",

    // ===== 作答行组装 =====
    /** 构建封套单题作答行（`index` 为 1-based 题号，`title` 为题目标题，`body` 为单行正文） */
    answerLine: (index: number, title: string, body: string) => `${index}. [${title}]: ${body}`,
    /** 同一作答行内多个片段（选项推演 / 批注令牌 / 草稿指令）的分隔符（纯 ASCII；作者文本中的 `;` 已在 `sanitizeEnvelopeText` 归一为全角 `；` 消除歧义） */
    partSeparator: "; ",
    /** 正文草稿 / 分镜头草稿压缩为单行指令时的分镜头片段分隔符（LLM 端纯 ASCII） */
    draftSegmentSeparator: " / ",
    /**
     * 构建带情节推演的选项片段：`【标签】推演 [Author note: …] [Draft directive: …]`
     * @param label - 选项标签原文（调用方已过 `sanitizeEnvelopeText`）
     * @param desc - 选项情节推演 / 设定阐述（调用方已过 `sanitizeEnvelopeText`）
     * @param draftDirective - 已包装的 `[Draft directive: …]` 令牌（可选，非原文）
     * @param note - 已包装的 `[Author note: …]` 令牌（可选，非原文）
     * @returns 输出顺序恒为「标签 → 推演 → 批注 → 草稿指令」，与形参顺序不同处在于批注先于草稿
     */
    optionWithDesc: (label: string, desc: string, draftDirective?: string, note?: string) =>
      `【${label}】${desc}${note ? ` ${note}` : ""}${draftDirective ? ` ${draftDirective}` : ""}`,
    /**
     * 构建无情节推演的选项片段：`【标签】[Author note: …] [Draft directive: …]`
     * @param label - 选项标签原文（调用方已过 `sanitizeEnvelopeText`）
     * @param draftDirective - 已包装的 `[Draft directive: …]` 令牌（可选，非原文）
     * @param note - 已包装的 `[Author note: …]` 令牌（可选，非原文）
     * @returns 输出顺序恒为「标签 → 批注 → 草稿指令」，与形参顺序不同处在于批注先于草稿
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
    /** 生成题目标题的英文占位（`index` 为 1-based 题号；仅封套编译期替换 `fallbacks.autoQuestionTitle` 与 `fallbacks.defaultQuestionTitle`，作者界面保留语言文件中的占位） */
    fallbackQuestionTitle: (index: number) => `Question ${index}`,
    /** 生成选项标签的英文占位（`index` 为 1-based 选项序号；仅封套编译期替换 `fallbacks.autoOptionLabel` / `fallbacks.unnamedOptionLabel` / `fallbacks.defaultOptionLabel`，作者界面保留语言文件中的占位） */
    fallbackOptionLabel: (index: number) => `Option ${index}`,
  },
} as const;
