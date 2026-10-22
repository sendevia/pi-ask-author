/**
 * @file texts.ts
 * @description 布局常量、终端图标、小说语法模板表与全局双向文案字典的单一来源，禁止各层直接书写文案字面量
 *
 * 核心架构特性：
 * - 全插件唯一文案来源：任何可见字符串均必须经由本模块获取数值，其余各层只做获取数值、组合与排版
 * - `LAYOUT_CONFIG` / `ICONS` / `MAX_*` 集中声明可调参数与强制上限，便于统一调整参数与验证边界
 * - `NOVEL_TEMPLATES` 以「定界符 → 语义哨兵 → 原生 Markdown 载体 → 主题样式」单表声明小说语法，新增语法只需在表尾追加一项
 * - `TEXTS` 按受众严格分区：LLM 面恒为英文并直接声明于本模块，作者面文案由 `lang/` 语言文件装载，两侧文案不得互相渗透
 *
 * 分区导航（与文件自上而下的顺序一致）：终端呈现常量 → 载荷上限 → 小说语法资产 → LLM 面文案 → 作者面文案装载与组装
 * 受众划分：`tool`（`label` 除外）/ `schema` / `markdown` 面向 LLM，唯一非英文片段为封套定界符 `【】`；`tool.label` / `command` / `common` / `tabs` / `view` / `menu` / `editor` / `status` / `help` / `summary` / `card` / `fallbacks` 面向作者，取自当前系统语言对应的语言文件
 *
 * 依赖方向：texts.ts → theme.ts（仅类型）、i18n.ts（语言资源装载）；作为叶层被 format / schema / model / novel-markdown / view-rows / view-summary / component / index 消费，禁止任何反向导入
 */

import { loadTexts } from "./i18n.js";
import type { Theme } from "./theme.js";

// ===== 终端呈现常量 =====

/** TUI 视图几何、分栏与滚动行为配置（数值项均标注单位 ms / cols / lines；分隔线条目为字符文本，不带单位） */
export const LAYOUT_CONFIG = {
  // ===== 分隔线字符 =====
  /** 双栏中间分隔符文本 */
  dividerChar: " │ ",
  /** 外层框架分割线字符（双横线） */
  dividerThick: "═",
  /** 内部内容分割线字符（单横线） */
  dividerThin: "─",

  // ===== 分栏几何 =====
  /** 中间分隔符可见宽度 (cols) */
  dividerWidth: 3,
  /** 左栏最大可见宽度 (cols) */
  leftColMax: 46,
  /** 左栏最小可见宽度 (cols) */
  leftColMin: 30,
  /** 宽屏双栏下左栏占视口比例 */
  leftColRatio: 0.42,
  /** 触发宽屏双栏的终端最小列宽 (cols) */
  splitViewMinWidth: 72,

  // ===== 滚动与翻页 =====
  /** 预览区单次翻页滚动行数 (lines) */
  previewScrollStep: 3,
  /** 窄屏单栏折叠预览区最大可见行数 (lines) */
  singlePreviewHeight: 7,
  /** 宽屏双栏右侧预览区最大可见行数 (lines) */
  splitPreviewHeight: 14,
  /** 总览页单页最大内容行数 (lines) */
  summaryPageSize: 16,
  /** 总览页单次滚动步长 (lines) */
  summaryScrollStep: 3,
  /** 菜单每页最大可见选项数 (项) */
  visibleOptionCount: 7,

  // ===== 状态提示时长 =====
  /** 底部状态通知停留时长 (ms) */
  statusDurationMs: 3000,
} as const;

/** Nerd Font 状态与操作语义图标字典（按语义分区排列；四个选择指示符自带 1 空格尾随填充以拉开与标签的间距；语言文件通过 `{icon.<键>}` 占位符引用） */
export const ICONS = {
  // ===== 状态与确认徽标 =====
  /** 取消 / 中止 */
  cancel: "󰜺",
  /** 完成与确认（结果卡片与总览页完成态） */
  check: "󰄬",
  /** 题目已完成 */
  checked: "󰐾",
  /** 题目未完成 */
  unchecked: "󰄰",
  /** 失败 */
  error: "󰅚",
  /** 补充说明 */
  note: "󰷬",

  // ===== 光标与滚动 =====
  /** 菜单行首聚焦指示 */
  cursor: "\u{e49c}",
  /** 列表与总览页向上方向提示 */
  scrollUp: "",
  /** 列表与总览页向下方向提示 */
  scrollDown: "",

  // ===== 选择指示符（自带 1 空格尾随填充） =====
  /** 多选已勾选（方括号复选框样式） */
  checkedMulti: "[󰄬] ",
  /** 多选未勾选（方括号复选框样式） */
  uncheckedMulti: "[ ] ",
  /** 单选已选中（圆括号圆钮样式） */
  checkedSingle: "(•) ",
  /** 单选未选中（圆括号圆钮样式） */
  uncheckedSingle: "( ) ",
} as const;

// ===== 载荷上限 =====

/** 单题最大选项数上限（项；同时约束 `schema.ts` 的 `options.maxItems`（批量与平铺两处）与 `sanitize.ts` 的选项截断） */
export const MAX_OPTIONS = 30;

/** 单份问卷最大题目数上限（题；同时约束 `schema.ts` 的 `questions.maxItems` 与 `sanitize.ts` 的题目截断） */
export const MAX_QUESTIONS = 20;

// ===== 小说语法资产 =====

/**
 * 语义哨兵前缀：不可见 NUL 控制字符，仅存在于 transform 产出与 `theme.code` 消费之间的中间态
 * 约定：输入侧已在 `format.ts` 边界剥离，分类时立即剥离，绝不进入终端输出
 */
export const NOVEL_MARKER_PREFIX = "\u0000";

/** 小说语法模板的字段规范（定界符 → 语义哨兵 → 原生 Markdown 载体 → 主题样式） */
export interface NovelSyntaxTemplate {
  /** 开始定界符 */
  readonly opener: string;
  /** 结束定界符 */
  readonly closer: string;
  /** 语义哨兵字符（紧随 {@link NOVEL_MARKER_PREFIX} 之后，`theme.code` 分类依据；`d` = dialogue、`m` = monologue） */
  readonly marker: string;
  /** 单个语义跨距最大字符数（含定界符；超出视为残缺定界符并放弃高亮） */
  readonly maxSpanLength: number;
  /**
   * 依据当前主题绘制语义文本
   * @param theme - 当前 TUI 主题实例（类型定义于叶层 `theme.ts`）
   * @param text - 已剥离哨兵的语义原文（含定界符）
   * @returns 应用语义样式后的富文本
   */
  readonly paint: (theme: Theme, text: string) => string;
}

/** 小说语法模板表（模块内部资产，仅由下方两个派生索引对外服务） */
const NOVEL_TEMPLATES: readonly NovelSyntaxTemplate[] = [
  /** 对话台词（`「」`）：以 accent 强调色着色 */
  { opener: "「", closer: "」", marker: "d", maxSpanLength: 400, paint: (theme, text) => theme.fg("accent", text) },
  /** 内心独白与旁白（`（）`）：muted 柔和色叠加斜体 */
  {
    opener: "（",
    closer: "）",
    marker: "m",
    maxSpanLength: 400,
    paint: (theme, text) => theme.fg("muted", theme.italic(text)),
  },
];

/** 开定界符 → 语法模板 的 `O(1)` 索引（同开定界符按声明顺序后者覆盖前者） */
export const NOVEL_TEMPLATE_BY_OPENER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.opener, template]),
);

/** 语义哨兵字符 → 语法模板 的 `O(1)` 索引（`theme.code` 分类依据） */
export const NOVEL_TEMPLATE_BY_MARKER: ReadonlyMap<string, NovelSyntaxTemplate> = new Map(
  NOVEL_TEMPLATES.map((template) => [template.marker, template]),
);

// ===== LLM 面文案（恒为英文，不参与语言切换） =====

/** 面向大模型的提示词、字段描述与返回封套：作为协议常量固定为英文，提升前缀缓存命中率 */
const LLM_TEXTS = {
  /** 工具注册元数据（`label` 面向作者，取自语言文件，故在此缺席） */
  tool: {
    /** 工具调用名（LLM 协议标识，注册为 `ask_author`；不出现在作者界面） */
    name: "ask_author",
    /** 工具说明（LLM 端英文；业务能力概要与调用场景） */
    description:
      "Consult the author on novel creative decisions, plot branches, scene drafting, or story settings. Supports single and batched questions, including adaptive forms where later questions or options appear only after specific earlier answers.",
    /** `Available tools` 区块单行条目（LLM 端英文；动词引导，无句末标点，缺省则工具不进入该区块） */
    promptSnippet: "Consult author on novel creative decisions, plot branches, scene drafting, or story settings",
    /**
     * `Guidelines` 区块附加条目（LLM 端英文；分类标签前缀 + 行为要求）
     * 约定：宿主把条目扁平追加进 `Guidelines` 且不加工具名前缀，故每条首词必须显式点名 `ask_author`
     */
    promptGuidelines: [
      "Invoke ask_author DIRECTLY without conversational preambles or greetings whenever author confirmation is needed for plot, characters, scenes, branches, or settings.",
      "ask_author modes: Always provide a concise formTitle. Use flat mode (formTitle + question + options) for single decisions, or the questions array for batch consultations. Batch interrelated decisions into one ask_author call; never make consecutive single-question calls.",
      "ask_author adaptive forms: When a later question or option depends on an earlier answer, give the earlier question a stable id and set showIf on the dependent item (questionId plus one of that question's option labels, or answered). Conditions may only reference earlier questions, and every referenced option label must exist.",
      "ask_author payload minimization: Strictly omit optional fields (id, description, minSelect, maxSelect, allowEmpty, allowCustom, customPlaceholder) when using default behavior. Never output auto-generated IDs or default boolean flags.",
      "ask_author option quality: Provide clear, descriptive labels summarizing the core action (never generic placeholders like 'Option A'). Include cause-and-effect plot deductions in description, and draft excerpts or dialogue in preview when helpful.",
      "ask_author multi-select & notes: Set multiSelect: true only when choices are not mutually exclusive. The author can always submit free-form notes alongside choices (both per-question and per-option).",
      "ask_author draft directives: Confirmed draft previews are automatically condensed into single-line directives in the ask_author result to guide subsequent story drafting.",
      "ask_author envelopes: [Author Decision Cancelled] means do not proceed with the discarded decision; [Author Consultation Error] means fix the arguments and retry once, then continue without the confirmation if it fails again.",
    ],
  },

  /** LLM 端 TypeBox 字段描述字典（单句浓缩英文，仅声明语义、必要性与省略规则；数量约束来自 {@link MAX_OPTIONS} / {@link MAX_QUESTIONS} 插值） */
  schema: {
    // ===== 选项字段（OptionSchema） =====
    /** 选项标签（必须填写；要求简明动作导向，禁止占位式命名） */
    optionLabel: "Concise, descriptive label summarizing the action or choice",
    /** 选项情节推演（可选；作者端渲染为「情节设定推演」预览面板） */
    optionDesc: "Plot consequences, rationale, or deduction (optional)",
    /** 选项草稿预览（可选；作者端渲染为「正文草稿/分镜头试撰写」预览面板） */
    optionPreview: "Draft prose excerpt or scene storyboard preview (optional, Markdown)",
    /** 选项批注占位符（可选；作者端作为选项补充说明编辑器的输入框占位文本） */
    optionCustomPlaceholder: "Placeholder text for option note input (optional)",
    /** 选项显示条件（可选；条件不成立时该选项不展示） */
    optionShowIf:
      "Show this option only when the referenced earlier question matches (single condition or array; all conditions must hold)",

    // ===== 题目字段（QuestionSchema） =====
    /** 题目 ID（可选；供批量模式与返回封套稳定引用） */
    questionId: "Question identifier (optional, omit unless needed)",
    /** 题目标题（必须填写；作者端呈现为 Tab 标签与题头） */
    questionTitle: "Question title (e.g., 'Choose the next route')",
    /** 题目背景说明（可选；作者端呈现为题头下方的上下文行） */
    questionDesc: "Context or background for this question (optional)",
    /** 多选开关（可选；默认 false，开启后作者端展示多选模式标签与方框勾选指示符） */
    questionMultiSelect: "Allow multiple selections (default false)",
    /** 最小勾选数（可选；默认 1，仅多选生效，作者端据此标注强制下限） */
    questionMinSelect: "Minimum selections required (default 1)",
    /** 最大勾选数（可选；默认全部选项，仅多选生效，小于选项总数时作者端追加上限标注） */
    questionMaxSelect: "Maximum selections allowed (default: all options)",
    /** 零勾选提交开关（可选；默认 false，仅多选生效，开启后作者端标注可不选） */
    questionAllowEmpty: "Allow submitting with zero selections (default false)",
    /** 候选选项列表（必须填写；1~{@link MAX_OPTIONS} 项；建议 2~10 项） */
    questionOptions: `Candidate options (1-${MAX_OPTIONS}, 2-10 recommended)`,
    /** 自由批注开关（可选；默认 true，开启后作者端可额外提交非选项文本） */
    questionAllowCustom: "Allow author free-form custom notes (default true)",
    /** 作者批注占位符（可选；作者端作为题目补充说明编辑器的输入框占位文本） */
    questionCustomPlaceholder: "Placeholder text for author note input (optional)",
    /** 题目显示条件（可选；条件不成立时该题不展示，也不计入答卷） */
    questionShowIf:
      "Show this question only when the referenced earlier question matches (single condition or array; all conditions must hold)",
    /** 显示条件引用的题目 ID（必须为本次表单中更早出现的题目） */
    conditionQuestionId: "Id of an earlier question in this form",
    /** 显示条件匹配的选项（引用题目的选项标签；作者选中该选项时条件成立） */
    conditionOption: "Option label of that earlier question; the condition holds while that option is selected",
    /** 显示条件的作答存在性（缺省等价于 true；与 option 同时给出时忽略） */
    conditionAnswered:
      "Hold while that question has any answer (default true) or none (false); ignored when option is set",

    // ===== 表单层字段（AskAuthorSchema 批量模式） =====
    /** 问卷标题（必须填写；作者端呈现为卡片标题与总览页标题） */
    formTitle: "Concise title describing the overall consultation task",
    /** 问卷背景（可选；作者端呈现为问卷级上下文） */
    formDesc: "Overall context or background for the consultation (optional)",
    /** 批量模式题目数组（可选；1~{@link MAX_QUESTIONS} 题；与平铺单题模式互斥） */
    formQuestions: `Batched related questions (1-${MAX_QUESTIONS}); batch interrelated decisions into one call instead of consecutive single-question calls`,

    // ===== 单题平铺模式 =====
    /** 平铺模式的题目标题（可选；与批量模式的 `questionTitle` 同义） */
    formSingleQuestion: "Question title for flat single-question mode",
    /** 平铺单题模式字段描述的统一区分前缀（LLM 端英文，`schema.ts` 逐字段拼接） */
    flatPrefix: "(Flat single-question mode only) ",
    /** 平铺模式候选选项列表（可选；1~{@link MAX_OPTIONS} 项；建议 2~10 项） */
    flatQuestionOptions: `Candidate options for flat single-question mode (1-${MAX_OPTIONS}, 2-10 recommended)`,
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
    /** 完成封套收尾指令（固定英文单行，驱动下游正文写作与大纲更新） */
    envelopeSuffix:
      "Execute workflow and writing strictly according to the author decisions and draft directives above without conversational acknowledgments.",
    /** 取消封套（固定两行：标识行 + 禁止沿用被丢弃决策的英文处置指令） */
    envelopeCancelled:
      "[Author Decision Cancelled]\nThe author cancelled the consultation. Do not proceed with the discarded decision; propose next steps or ask for clarification in chat.",
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
      nonTui: "Interactive TUI is unavailable in the current execution mode.",
      /** 入参无有效题目或选项（对应作者端 `status.errorNoQuestions`） */
      noQuestions: "No valid questions or options were provided in arguments.",
      /** 构建执行期异常的原因行（`details` 为宿主异常摘要，对应作者端 `status.errorExecutionFailed`） */
      runtimeError: (details: string) => `Runtime error during consultation UI execution: ${details}`,
      /** 自适应条件引用无效（对应作者端 `status.errorInvalidCondition`） */
      invalidCondition: (details: string) => `Invalid adaptive condition in arguments: ${details}`,
    },
    /** 错误封套纠正指引行字典（英文单句，与 `errorReasons` 一一对应） */
    errorGuidances: {
      /** `nonTui` 的纠正指引 */
      nonTui: "Proceed using defaults or ask user via standard chat/message if crucial.",
      /** `noQuestions` 的纠正指引 */
      noQuestions: "Provide at least one question with concrete options.",
      /** `runtimeError` 的纠正指引 */
      runtimeError: "Check arguments format and retry with valid questions and options.",
      /** `invalidCondition` 的纠正指引 */
      invalidCondition:
        "Point showIf at an earlier question id plus one of its option labels, or use answered, then retry.",
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
    },
    /** 空答卷封套正文（作者未作答时的英文处置指令，位于首尾标识之间） */
    envelopeEmpty:
      "Author submitted the form without any answers. Proceed with your defaults, or ask a follow-up question in chat if the decision is crucial.",
    /** 单题无任何作答（未勾选且无批注）时的英文占位正文 */
    noSelection: "(No selection; author skipped this question)",

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

// ===== 作者面文案装载 =====

/** 语言资源占位符 `{icon.<键>}` 的解析器；非图标占位符返回 undefined 交由模板形参处理 */
const resolveTemplateConstant = (name: string): string | undefined =>
  name.startsWith("icon.") ? (ICONS as Readonly<Record<string, string>>)[name.slice(5)] : undefined;

/** 当前系统语言对应的作者面文案字典（结构以 `lang/en_US.json` 为规范） */
const LOCALE_TEXTS = loadTexts(resolveTemplateConstant);

/**
 * 渲染多选模式标签（形如 `[多选 可不选 至多3项]` / `[Multi, optional, up to 3]`）
 * @param min - 模型收敛后的最小勾选数（区间 `0 ~ optionCount`）
 * @param max - 模型收敛后的最大勾选数（区间 `min ~ optionCount`）
 * @param optionCount - 本题候选选项数
 * @param allowEmpty - 是否允许零勾选提交
 * @returns `min > 1` 时标注强制下限；`min === 0` 或 `allowEmpty` 时标注可不选；`max` 小于选项总数时追加上限标注，等于总数则视为无额外上限而省略
 */
const modeMultiLabel = (min: number, max: number, optionCount: number, allowEmpty: boolean): string => {
  const maxPart = max < optionCount ? LOCALE_TEXTS.view.modeMultiMaxPart(max) : "";
  if (min > 1) return LOCALE_TEXTS.view.modeMultiAtLeast(min, maxPart);
  if (min === 0 || allowEmpty) return LOCALE_TEXTS.view.modeMultiOptional(maxPart);
  return LOCALE_TEXTS.view.modeMultiUnconstrained(maxPart);
};

/**
 * 渲染多选确认按钮的已选计数明细
 * @param selectedCount - 已选数
 * @param minSelect - 本题下限
 * @returns 未达下限时呈现为 `已选 n/min 项`，否则呈现为 `已选 n 项`
 */
const confirmDetailMulti = (selectedCount: number, minSelect: number): string =>
  selectedCount < minSelect
    ? LOCALE_TEXTS.menu.confirmDetailMultiBelowMin(selectedCount, minSelect)
    : LOCALE_TEXTS.menu.confirmDetailMulti(selectedCount, minSelect);

/**
 * 渲染确认本题按钮标签
 * @param detail - 已选计数明细（取自 `confirmDetailMulti`）
 * @param hasNote - 是否已填写题目补充说明
 * @returns 形如 `󰄬 确认本题 (已选 2 项 + 补充说明)`
 */
const confirmLabel = (detail: string, hasNote: boolean): string =>
  LOCALE_TEXTS.menu.confirmLabel(detail, hasNote ? LOCALE_TEXTS.menu.confirmNoteSuffix : "");

// ===== 文案字典 =====

/** 全局双向文案字典：LLM 面固定英文协议常量，作者面取自当前系统语言对应的语言文件 */
export const TEXTS = {
  // ===== LLM 面（恒为英文） =====

  /** 工具注册元数据：`name` / `description` / `promptSnippet` / `promptGuidelines` 面向 LLM（英文高信噪比），`label` 面向作者（TUI 工具行标题） */
  tool: { ...LLM_TEXTS.tool, label: LOCALE_TEXTS.tool.label },
  /** LLM 端 TypeBox 字段描述字典 */
  schema: LLM_TEXTS.schema,
  /** LLM 端返回封套与纠正指令模板 */
  markdown: LLM_TEXTS.markdown,

  // ===== 作者面（取自语言文件，按界面交互流程排列） =====

  /** `/ask-author` 辅助命令的注册元数据与作者可见提示文案 */
  command: LOCALE_TEXTS.command,
  /** 跨视图共享的通用排版片段（枚举分隔符、列表条目前缀与按键帮助分隔符） */
  common: LOCALE_TEXTS.common,
  /** Tab 导航栏标签文案（各题目页与答卷提交页） */
  tabs: LOCALE_TEXTS.tabs,
  /** 作答视图与预览面板的结构化文案（`modeMulti` 由多选模式片段组合而成） */
  view: { ...LOCALE_TEXTS.view, modeMulti: modeMultiLabel },
  /** 题目菜单条目文案（`confirmDetailMulti` / `confirmLabel` 由已选数片段组合而成） */
  menu: { ...LOCALE_TEXTS.menu, confirmDetailMulti, confirmLabel },
  /** 全屏补充说明编辑器的标题与页脚按键帮助文案 */
  editor: LOCALE_TEXTS.editor,
  /** 底部临时状态栏通知（操作结果、阻断原因与阻断后的纠正操作路径） */
  status: LOCALE_TEXTS.status,
  /** 底部按键帮助行片段（经 `common.helpSeparator` 拼接；条目按按键字母序排列） */
  help: LOCALE_TEXTS.help,
  /** 答卷总览确认页文案（完成状态徽标、已选项标签、选项批注角标与滚动提示） */
  summary: LOCALE_TEXTS.summary,
  /** 会话回放卡片文案（调用态摘要、结果态徽标与展开态明细） */
  card: LOCALE_TEXTS.card,
  /** 兜底文案与自动命名派生：任一缺失 / 越界输入的最终回退，保证界面与封套永不空白 */
  fallbacks: LOCALE_TEXTS.fallbacks,
} as const;
