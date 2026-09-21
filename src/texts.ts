/**
 * @file texts.ts
 * @description 布局常量、终端图标、小说语法模板表与全局双向文案字典的单一来源，禁止各层直接书写文案字面量
 *
 * 核心架构特性：
 * - 全插件唯一文案来源：任何可见字符串均必须经由本模块获取数值，其余各层只做获取数值、组合与排版
 * - `LAYOUT_CONFIG` / `ICONS` / `MAX_*` 集中声明可调参数与强制上限，便于统一调整参数与验证边界
 * - `NOVEL_TEMPLATES` 以「定界符 → 语义哨兵 → 原生 Markdown 载体 → 主题样式」单表声明小说语法，新增语法只需在表尾追加一项
 * - `TEXTS` 按受众严格分区，LLM 面恒为英文，作者面恒为中文，两侧文案不得互相渗透
 *
 * 分区导航（与文件自上而下的顺序一致）：终端呈现常量 → 载荷上限 → 小说语法资产 → 共享排版字面量 → 文案字典 `TEXTS`
 * 受众划分：`tool`（`label` 除外）/ `schema` / `markdown` 面向 LLM，唯一非英文片段为封套定界符 `【】`；`tool.label` / `command` / `common` / `tabs` / `view` / `menu` / `editor` / `status` / `help` / `summary` / `card` / `fallbacks` 面向作者
 *
 * 依赖方向：texts.ts → theme.ts（仅类型）；作为叶层被 format / schema / model / novel-markdown / view-rows / view-summary / component / index 消费，禁止任何反向导入
 */

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

/** Nerd Font 状态与操作语义图标字典（按语义分区排列；四个选择指示符自带 1 空格尾随填充以拉开与标签的间距） */
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
  cursor: "",
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

// ===== 共享排版字面量 =====

/** 列表条目统一圆点前缀（`TEXTS.common.bulletPrefix` 与各预览面板提示行的唯一字面量来源） */
const BULLET_PREFIX = "• ";

// ===== 文案字典 =====

/** 全局双向文案字典：统一定义面向大模型 (LLM) 的提示词规范与面向用户 (TUI) 的界面文案 */
export const TEXTS = {
  // ===== LLM 面（恒为英文） =====

  /** 工具注册元数据：`name` / `description` / `promptSnippet` / `promptGuidelines` 面向 LLM（英文高信噪比），`label` 面向作者（TUI 工具行中文名） */
  tool: {
    /** 工具调用名（LLM 协议标识，注册为 `ask_author`；不出现在作者界面） */
    name: "ask_author",
    /** 工具展示名（作者端中文，经 `index.ts` 渲染为会话调用卡片标题） */
    label: "向作者请示",
    /** 工具说明（LLM 端英文；业务能力概要与调用场景） */
    description:
      "Consult the author on novel creative decisions, plot branches, scene drafting, or story settings. Supports single and batched questions with plot deductions and draft previews.",
    /** `Available tools` 区块单行条目（LLM 端英文；动词引导，无句末标点，缺省则工具不进入该区块） */
    promptSnippet: "Consult author on novel creative decisions, plot branches, scene drafting, or story settings",
    /**
     * `Guidelines` 区块附加条目（LLM 端英文；分类标签前缀 + 行为要求）
     * 约定：宿主把条目扁平追加进 `Guidelines` 且不加工具名前缀，故每条首词必须显式点名 `ask_author`
     */
    promptGuidelines: [
      "Invoke ask_author DIRECTLY without conversational preambles or greetings whenever author confirmation is needed for plot, characters, scenes, branches, or settings.",
      "ask_author modes: Always provide a concise formTitle. Use flat mode (formTitle + question + options) for single decisions, or the questions array for batch consultations. Batch interrelated decisions into one ask_author call; never make consecutive single-question calls.",
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
      /** 非交互式终端环境无法启动 TUI（对应作者端 {@link TEXTS.status.errorNonTui}） */
      nonTui: "Interactive TUI is unavailable in the current execution mode.",
      /** 入参无有效题目或选项（对应作者端 {@link TEXTS.status.errorNoQuestions}） */
      noQuestions: "No valid questions or options were provided in arguments.",
      /** 构建执行期异常的原因行（`details` 为宿主异常摘要，对应作者端 {@link TEXTS.status.errorExecutionFailed}） */
      runtimeError: (details: string) => `Runtime error during consultation UI execution: ${details}`,
    },
    /** 错误封套纠正指引行字典（英文单句，与 `errorReasons` 一一对应） */
    errorGuidances: {
      /** `nonTui` 的纠正指引 */
      nonTui: "Proceed using defaults or ask user via standard chat/message if crucial.",
      /** `noQuestions` 的纠正指引 */
      noQuestions: "Provide at least one question with concrete options.",
      /** `runtimeError` 的纠正指引 */
      runtimeError: "Check arguments format and retry with valid questions and options.",
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

    // ===== 封套编译期英文替换（覆盖作者端中文占位） =====
    /** 生成题目标题的英文占位（`index` 为 1-based 题号；仅封套编译期替换 `fallbacks.autoQuestionTitle` 与 `fallbacks.defaultQuestionTitle`，作者界面保留中文占位） */
    fallbackQuestionTitle: (index: number) => `Question ${index}`,
    /** 生成选项标签的英文占位（`index` 为 1-based 选项序号；仅封套编译期替换 `fallbacks.autoOptionLabel` / `fallbacks.unnamedOptionLabel` / `fallbacks.defaultOptionLabel`，作者界面保留中文占位） */
    fallbackOptionLabel: (index: number) => `Option ${index}`,
  },

  // ===== 作者面（恒为中文，按界面交互流程排列） =====

  /** `/ask-author` 辅助命令的注册元数据与作者可见提示文案 */
  command: {
    /** 命令名（注册为 `ask-author`，作者输入 `/ask-author` 触发） */
    name: "ask-author",
    /** 命令说明（命令面板与补全列表展示） */
    description: "查看 ask_author 创作请示工具说明",
    /** 命令执行后的提示通知（引导作者改用自然语言指示 AI 调用工具） */
    notify: "在提示词中指示 AI 调用 ask_author，即可向您请示创作决策",
  },

  /** 跨视图共享的通用排版片段（枚举分隔符、列表条目前缀与按键帮助分隔符） */
  common: {
    /** 选项标签并列展示时的中文枚举分隔符（总览页与结果卡片共用） */
    optionSeparator: "、",
    /** 列表条目统一前缀（作者端圆点标记；卡片行与预览面板提示行的唯一字面量来源） */
    bulletPrefix: BULLET_PREFIX,
    /** 底部按键帮助行各片段之间的分隔符 */
    helpSeparator: " • ",
  },

  /** Tab 导航栏标签文案（各题目页与答卷提交页） */
  tabs: {
    /** 渲染题目页标签（`index` 为 1-based 题号） */
    questionTab: (index: number) => `第${index}题`,
    /** 答卷提交页标签（末尾固定页，前面附带完成徽标） */
    submitTab: `${ICONS.check} 提交答卷`,
  },

  /** 作答视图与预览面板的结构化文案（题目标签、补充横幅、滚动信息与 Markdown 区块构建器，按界面渲染顺序排列） */
  view: {
    // ===== 题目头与模式标签 =====
    /** 单选模式标签 */
    modeSingle: "[单选]",
    /**
     * 按勾选数量上下限渲染多选模式标签（形如 `[多选 可不选 至多3项]`）
     * @param min - 模型收敛后的最小勾选数（区间 `0 ~ optionCount`）
     * @param max - 模型收敛后的最大勾选数（区间 `min ~ optionCount`）
     * @param optionCount - 本题候选选项数
     * @param allowEmpty - 是否允许零勾选提交
     * @returns `min > 1` 时标注强制下限；`min === 0` 或 `allowEmpty` 时标注可不选；`max` 小于选项总数时追加上限标注，等于总数则视为无额外上限而省略
     */
    modeMulti: (min: number, max: number, optionCount: number, allowEmpty: boolean) => {
      let tag = "[多选";
      if (min > 1) tag += ` 至少${min}项`;
      else if (min === 0 || allowEmpty) tag += " 可不选";
      if (max < optionCount) tag += ` 至多${max}项`;
      return `${tag}]`;
    },
    /** 渲染题目级补充说明横幅（`text` 为补充说明原文，位于题头下方） */
    attachedNoteBanner: (text: string) => `${ICONS.note} 题目补充说明：${text}`,
    /** 渲染选项级补充说明横幅（`label` 为选项标签，位于对应选项行下方） */
    optionAttachedNoteBanner: (label: string, text: string) => `${ICONS.note} [${label}] 选项补充说明：${text}`,

    // ===== 选项列表滚动提示 =====
    /** 渲染列表上方剩余项数提示（`count` 为剩余项数） */
    listTopMore: (count: number) => `  ${ICONS.scrollUp} 向上还有 ${count} 项`,
    /** 渲染列表下方剩余项数提示（`count` 为剩余项数） */
    listBottomMore: (count: number) => `  ${ICONS.scrollDown} 向下还有 ${count} 项`,

    // ===== 预览面板标题（按面板渲染顺序排列） =====
    /** 选项补充说明面板标题 */
    optionNotePanelTitle: "选项补充说明",
    /** 选项情节推演面板标题 */
    storyDescriptionPanelTitle: "情节设定推演",
    /** 选项正文草稿 / 分镜头面板标题 */
    storyDraftPanelTitle: "正文草稿/分镜头试撰写",
    /** 题目补充说明面板标题 */
    customNotePanelTitle: "题目补充说明",
    /** 确认入口的按键说明面板标题 */
    confirmPanelTitle: "操作说明",

    // ===== 预览面板正文片段 =====
    /** 已填写的题目补充说明字段标签（下方接说明原文） */
    customNotePanelCurrent: "当前填写内容：",
    /** 渲染草稿预览的行区间与滚动提示（`start` / `end` / `total` 均为 1-based 行号与总行数） */
    previewScrollInfo: (start: number, end: number, total: number) => `(行 ${start}-${end}/${total}，PgUp/PgDn 滚动)`,
    /** 草稿预览缺省占位（无内容可预览时） */
    previewNoDraft: "(无内容预览)",
    /** 题目补充说明面板的按键提示行集合 */
    customNotePanelTips: [
      `${BULLET_PREFIX}随时按「N」或选择此项按「Enter」填写/修改本题补充说明`,
      `${BULLET_PREFIX}按「x」清空本题补充说明`,
      `${BULLET_PREFIX}补充说明将随所选选项及选项专属补充说明一并提交给 AI 助手`,
    ],
    /** 确认面板的按键提示行集合 */
    confirmPanelTips: [
      `${BULLET_PREFIX}按 \`Enter\` 确认本题并前往下一题`,
      `${BULLET_PREFIX}最后一题确认后自动进入总览提交页`,
    ],

    // ===== Markdown 构建器 =====
    /** 构建预览面板 Markdown 三级小节标题（`title` 为小节标题原文） */
    sectionTitle: (title: string) => `### ${title}`,
    /** 构建预览面板 Markdown bold 字段标签（`label` 为字段标签原文） */
    fieldLabel: (label: string) => `**${label}**`,
    /** 构建预览面板 Markdown 斜体提示行（`text` 为提示行原文） */
    italicLine: (text: string) => `_${text}_`,
  },

  /** 题目菜单条目文案（补充说明入口与确认推进按钮） */
  menu: {
    // ===== 补充说明入口 =====
    /** 补充说明入口标签（未填写态） */
    customNoteLabel: `${ICONS.note} 题目补充说明`,
    /** 补充说明入口标签（已填写态） */
    customNoteLabelFilled: `${ICONS.note} 题目补充说明 (已填写)`,

    // ===== 确认按钮 =====
    /** 渲染多选确认按钮的已选计数明细（`selectedCount` 为已选数，`minSelect` 为下限；未达下限时呈现为 `已选 n/min`） */
    confirmDetailMulti: (selectedCount: number, minSelect: number) =>
      `已选 ${selectedCount}${selectedCount < minSelect ? `/${minSelect}` : ""} 项`,
    /** 渲染确认本题按钮标签（`detail` 取自 `confirmDetailMulti`，空串时不显示括号；`hasNote` 为真时追加补充标记） */
    confirmLabel: (detail: string, hasNote: boolean) =>
      `${ICONS.check} 确认本题 (${detail}${hasNote ? " + 补充说明" : ""})`,
    /** 确认按钮的下方说明（声明确认后的跳转目标） */
    confirmDesc: "确认并前往下一题或总览页",
  },

  /** 全屏补充说明编辑器的标题与页脚按键帮助文案 */
  editor: {
    /** 渲染题目补充说明编辑器标题（`questionTitle` 为题目标题） */
    title: (questionTitle: string) => ` ${ICONS.note} 填写题目补充说明（${questionTitle}）`,
    /** 渲染选项补充说明编辑器标题（`optionLabel` 为选项标签，`questionTitle` 为题目标题） */
    optionTitle: (questionTitle: string, optionLabel: string) =>
      ` ${ICONS.note} 填写选项补充说明（${optionLabel} - ${questionTitle}）`,
    /** 编辑器页脚按键帮助（保存与取消） */
    footerHelp: " [Enter] 保存并返回 • [Esc/Ctrl+C] 取消",
  },

  /** 底部临时状态栏通知（操作结果、阻断原因与阻断后的纠正操作路径） */
  status: {
    // ===== 补充说明的保存与清空反馈 =====
    /** 题目补充说明已保存 */
    questionNoteSaved: "已保存本题补充说明",
    /** 题目补充说明已清空 */
    noteCleared: "已清空本题补充说明",
    /** 提示选项批注已保存（`label` 为选项标签；该选项已勾选） */
    optionNoteSaved: (label: string) => `已保存「${label}」补充说明`,
    /** 提示选项批注已保存但该选项未勾选（`label` 为选项标签；批注仅作批注提交） */
    optionNoteSavedUnselected: (label: string) => `已保存「${label}」批注（该选项未勾选，仅作批注提交）`,
    /** 提示已达批注选项数量上限（`max` 为上限值，批注保留但该选项不再勾选） */
    optionNoteSavedAtLimit: (max: number) => `已达上限（至多 ${max} 项）：批注已保存，但该选项未勾选`,
    /** 提示选项批注已清空（`label` 为选项标签） */
    optionNoteCleared: (label: string) => `已清空「${label}」补充说明`,

    // ===== 勾选数量约束与未完成阻断 =====
    /** 提示单选已达上限（`limit` 为本题勾选上限；再次勾选被拒） */
    selectedUpToLimit: (limit: number) => `已达选择上限（至多 ${limit} 项）`,
    /** 提示多选已达上限（`max` 为本题勾选上限；引导取消已选项后重选） */
    maxSelectExceeded: (max: number) => `已达上限（至多 ${max} 项）：请按「空格」取消已选项后重选`,
    /** 提示多选未达下限（`min` 为本题勾选下限；引导继续勾选或改用补充说明） */
    minSelectRequired: (min: number) => `未达下限（至少需 ${min} 项）：请按「空格」继续勾选，或按「n/N」填写说明`,
    /** 提交时本题仍无任何作答：并列给出两条通过路径 */
    pleaseAnswerBeforeSubmit: "本题未完成：请按「空格/Enter」选定选项，或按「n/N」填写补充说明",

    // ===== 编辑器与执行期异常 =====
    /** 编辑器放弃修改的二次确认（首次 Esc/Ctrl+C 触发） */
    editorDiscardConfirm: "再次按 Esc/Ctrl+C 放弃修改（未保存内容将丢失），继续输入可撤销",
    /** 非交互式终端环境无法启动交互界面（与 `markdown.errorReasons.nonTui` 对应） */
    errorNonTui: "当前为非交互式终端环境，无法启动交互界面，请在交互式 TUI 会话中重试",
    /** 入参无有效题目或选项（与 `markdown.errorReasons.noQuestions` 对应） */
    errorNoQuestions: "未提供有效的问题或选项，请提供至少一个带选项的问题",
    /** 生成组件执行期异常通知（`reason` 为宿主异常摘要，与 `markdown.errorReasons.runtimeError` 对应） */
    errorExecutionFailed: (reason: string) => `组件执行异常：${reason}（可修正参数后重试）`,
  },

  /** 底部按键帮助行片段（标准键名 + 动宾结构，经 {@link TEXTS.common.helpSeparator} 拼接；条目按按键字母序排列） */
  help: {
    /** Esc / Ctrl+C：取消并关闭当前界面 */
    cancel: "Esc/Ctrl+C 取消",
    /** x：清空光标所在位置的补充说明 */
    clearNote: "x 清空补充说明",
    /** Enter：多选模式下确认本题并推进 */
    confirmQuestion: "Enter 确认",
    /** Enter：总览页提交整份答卷 */
    confirmSubmit: "Enter 提交",
    /** n：编辑题目补充说明（光标位于题目补充说明菜单项时） */
    editNote: "n 补充说明",
    /** n：编辑当前选项的专属批注（光标位于选项行时） */
    editOptionNote: "n 选项补充说明",
    /** N：直接编辑题目补充说明（光标位于选项行时的大写入口） */
    editQuestionNote: "N 题目补充说明",
    /** 1~9：按题号直接跳转题目（题目数大于 1 时展示） */
    jumpQuestion: "1~9 跳转题目",
    /** ↑↓ / jk：上下移动光标 */
    moveCursor: "↑↓/jk 移动",
    /** PgUp / PgDn：作答页滚动草稿预览（存在预览内容时展示） */
    scrollDraft: "PgUp/PgDn 滚动草稿",
    /** ↑↓ / PgUp / PgDn：总览页滚动内容 */
    scrollSummary: "↑↓/PgUp/PgDn 滚动",
    /** 空格 / Enter：单选模式下选定当前项 */
    selectOptionSingle: "空格/Enter 选定",
    /** Tab / ←→ / hl：切换题目或总览页 */
    switchQuestion: "Tab/←→/hl 切换题目",
    /** a：多选模式下全选或清空 */
    toggleAll: "a 全选/清空",
    /** 空格：多选模式下勾选或取消当前项 */
    toggleCheckMulti: "空格 勾选",
  },

  /** 答卷总览确认页文案（完成状态徽标、已选项标签、选项批注角标与滚动提示，按页面自上而下的渲染顺序排列） */
  summary: {
    /** 页标题 */
    title: "【答卷总览与确认】",
    /** 单题完成徽标 */
    statusDone: "[已完成]",
    /** 单题未完成徽标 */
    statusPending: "[未完成]",
    /** 渲染题目块标题（`index` 为 1-based 题号，`title` 为题目标题） */
    questionPrefix: (index: number, title: string) => `第${index}题：${title}`,
    /** 已选选项行标签 */
    selectedLabel: "已选：",
    /** 已选选项行尾的批注存在角标 */
    optionNoteBadge: `(${ICONS.note} 批注)`,
    /** 渲染选项级批注行标签（`optLabel` 为所属选项标签） */
    optionNotePrefix: (optLabel: string) => `${ICONS.note} 选项补充说明（${optLabel}）：`,
    /** 题目级补充说明行标签 */
    customNoteLabel: `${ICONS.note} 题目补充说明：`,
    /** 全部完成时的提交引导行 */
    allDonePrompt: ` ${ICONS.check} 全部完成，按 Enter/Ctrl+S 提交答卷，Tab/hl/1-9 返回修改`,
    /** 存在未完成题目时的阻断提示行 */
    pendingWarning: ` ${ICONS.unchecked} 尚有题目未完成，按 Enter 前往作答，Tab/hl/1-9 切换修改`,
    /** 渲染总览页上方剩余行数提示（`count` 为剩余行数） */
    topMore: (count: number) => `  ${ICONS.scrollUp} 向上还有 ${count} 行`,
    /** 渲染总览页下方剩余行数提示（`count` 为剩余行数） */
    bottomMore: (count: number) => `  ${ICONS.scrollDown} 向下还有 ${count} 行`,
  },

  /** 会话回放卡片文案（调用态摘要、结果态徽标与展开态明细） */
  card: {
    // ===== 调用态摘要 =====
    /** 渲染调用态多题摘要（`qCount` 为题数，`optCount` 为选项总数；形如 `3 题 • 8 选项`） */
    callQuestionAndOptionCount: (qCount: number, optCount: number) => `${qCount} 题 • ${optCount} 选项`,
    /** 渲染调用态平铺单题摘要（`optCount` 为选项数；形如 `4 选项`） */
    callOptionCountOnly: (optCount: number) => `${optCount} 选项`,

    // ===== 结果态徽标 =====
    /** 作者取消（warning 配色） */
    resultCancelled: `${ICONS.cancel} 已取消`,
    /** 执行失败（error 配色；展开态另附错误原因） */
    resultErrorShort: `${ICONS.error} 执行失败`,
    /** 正常完成（success 配色） */
    resultCompleted: `${ICONS.check} 已完成`,
    /** 渲染结果态已作答题目数（`n` 为题目数；形如 `3 项`，经 `common.bulletPrefix` 拼接） */
    resultCount: (n: number) => `${n} 项`,

    // ===== 展开态明细 =====
    /** 渲染展开态单条作答行（`title` 为题目标题，`content` 为明细正文） */
    optionBullet: (title: string, content: string) => `${BULLET_PREFIX}${title}：${content}`,
    /** 渲染带专属批注的选项标签角标（`label` 为选项标签，`note` 为批注原文；形如 `选项 [note 批注]`） */
    optionWithNote: (label: string, note: string) => `${label} [${ICONS.note} ${note}]`,
    /** 渲染题目补充说明角标（`text` 为补充说明原文，追加于作答行行尾） */
    questionNoteTag: (text: string) => ` (${ICONS.note} 题目补充说明: ${text})`,
    /** 渲染展开态错误原因行（`err` 为宿主异常摘要） */
    errorBullet: (err: string) => `${BULLET_PREFIX}错误原因：${err}`,
  },

  /**
   * 兜底文案与自动命名派生：任一缺失 / 越界输入的最终回退，保证界面与封套永不空白
   * 语言归属：本组为作者端中文占位，作者界面始终呈现中文
   * 约定：`model.ts` 在封套编译期把 `autoQuestionTitle` / `defaultQuestionTitle` / `autoOptionLabel` / `unnamedOptionLabel` / `defaultOptionLabel` 替换为 `markdown.fallbackQuestionTitle` / `markdown.fallbackOptionLabel` 的英文占位
   */
  fallbacks: {
    // ===== 缺省填充 =====
    /** 问卷标题缺省（模型未提供 `formTitle` 时） */
    defaultFormTitle: "创作决策",
    /** 题目标题缺省（模型未提供标题时的作者端中文占位，封套编译期替换为英文） */
    defaultQuestionTitle: "请选择接下来的创作方案",
    /** 题目补充说明编辑器的缺省占位文本 */
    defaultCustomPlaceholder: "输入本题整体补充要求、伏笔细节或修改意见...",
    /** 选项补充说明编辑器的缺省占位文本 */
    defaultOptionCustomPlaceholder: "输入针对该选项的具体补充要求或修改细节...",
    /** 自由文本作答的选项名（作者填写自定义内容时占位） */
    defaultCustomChoiceName: "自定义方案",
    /** 选项标签缺省（模型未提供标签时的作者端中文占位，封套编译期替换为英文） */
    defaultOptionLabel: "默认方案",
    /** 选项标签缺失且无序号信息时的占位（封套编译期替换为英文） */
    unnamedOptionLabel: "未命名方案",

    // ===== 空答占位 =====
    /** 未勾选且无补充说明时的展示占位（总览页与结果卡片共用；封套中由 `markdown.noSelection` 承担同义英文） */
    unselectedOption: "未选",

    // ===== 自动命名派生 =====
    /** 生成自动题目 ID（`n` 为 1-based 序号） */
    autoQuestionId: (n: number) => `q_${n}`,
    /** 生成自动题目标题（`n` 为 1-based 序号，作者端中文占位，封套编译期替换为英文） */
    autoQuestionTitle: (n: number) => `问题 ${n}`,
    /** 生成自动选项标签（`n` 为 1-based 序号，作者端中文占位，封套编译期替换为英文） */
    autoOptionLabel: (n: number) => `选项 ${n}`,
  },
} as const;
