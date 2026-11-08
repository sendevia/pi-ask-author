/**
 * @file schema.ts
 * @description `ask_author` 工具参数 Schema 与类型的单一源头
 *
 * - 字段名、可选性与区间约束仅在 TypeBox 定义一次，运行时类型经 `Static<typeof>` 派生
 * - 默认值不写入 Schema：题目内字段由 `sanitize.ts` 规整时填入，模型层再按同一语义兜底
 * - 推演配置双层：表单级 `expansion` 提供缺省方向与插入位置，题目级逐题开关或覆盖
 */

import { Type, type Static } from "typebox";
import { MAX_OPTIONS, MAX_QUESTIONS } from "./layout.js";
import { TEXTS } from "./texts.js";

/** 显示条件：引用更早题目的作答状态，决定本题或本选项是否出现 */
export const ShowIfConditionSchema = Type.Object({
  /** 被引用的题目 ID（必须为本次表单中更早出现的题目） */
  questionId: Type.String({ description: TEXTS.schema.conditionQuestionId }),
  /** 匹配的选项标签（可选；给出时条件等价于「该选项被选中」） */
  option: Type.Optional(Type.String({ description: TEXTS.schema.conditionOption })),
  /** 作答存在性（缺省等价于 true；给出 `option` 时忽略） */
  answered: Type.Optional(Type.Boolean({ description: TEXTS.schema.conditionAnswered })),
});

/**
 * 构建 `showIf` 字段：单个条件对象或条件数组，数组语义为全部成立
 * @param description - 字段描述
 * @returns 可选的条件字段 Schema
 */
function showIfField(description: string) {
  return Type.Optional(Type.Union([ShowIfConditionSchema, Type.Array(ShowIfConditionSchema)], { description }));
}

/** 单个候选选项的参数 Schema */
export const OptionSchema = Type.Object({
  /** 选项简短标题与行动标签（缺失时经 sanitize / model 两级兜底为自动占位标签） */
  label: Type.String({ description: TEXTS.schema.optionLabel }),
  /** 情节推演后果或设定阐述 */
  description: Type.Optional(Type.String({ description: TEXTS.schema.optionDesc })),
  /** Markdown 正文草稿或分镜头试撰写 */
  preview: Type.Optional(Type.String({ description: TEXTS.schema.optionPreview })),
  /** 该选项专属补充说明的占位引导文案 */
  customPlaceholder: Type.Optional(Type.String({ description: TEXTS.schema.optionCustomPlaceholder })),
  /** 该选项的显示条件（不成立时不展示，选中态也不计入答卷） */
  showIf: showIfField(TEXTS.schema.optionShowIf),
});

/** 推演题目插入位置：跟随触发题目 / 排到队尾 / 指定题目之后 */
export const InsertPositionSchema = Type.Union(
  [
    Type.Literal("follow"),
    Type.Literal("tail"),
    Type.Object({ after: Type.String({ description: TEXTS.schema.expansionInsertAfter }) }),
  ],
  { description: TEXTS.schema.expansionInsert },
);

/** 题目级推演配置：布尔开关，或本题专属的推演方向与插入位置 */
export const QuestionExpansionSchema = Type.Union(
  [
    Type.Boolean(),
    Type.Object({
      /** 本题专属的推演方向 */
      guidance: Type.Optional(Type.String({ description: TEXTS.schema.expansionGuidance })),
      /** 本题推演题目的插入位置 */
      insert: Type.Optional(InsertPositionSchema),
    }),
  ],
  { description: TEXTS.schema.questionExpansion },
);

/** 单个问题的参数 Schema（批量问卷与平铺模式共用） */
export const QuestionSchema = Type.Object({
  /** 题目唯一标识符（缺省由模型层按顺序生成并去重） */
  id: Type.Optional(Type.String({ description: TEXTS.schema.questionId })),
  /** 题目标题（缺失时两级兜底为自动占位标题） */
  title: Type.String({ description: TEXTS.schema.questionTitle }),
  /** Tab 短标签（缺省时 Tab 栏显示题号） */
  tabLabel: Type.Optional(Type.String({ description: TEXTS.schema.questionTabLabel })),
  /** 题目背景与语境 */
  description: Type.Optional(Type.String({ description: TEXTS.schema.questionDesc })),
  /** 是否允许多选（默认 false） */
  multiSelect: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionMultiSelect })),
  /** 最小勾选数（仅多选有效，默认 1） */
  minSelect: Type.Optional(Type.Integer({ description: TEXTS.schema.questionMinSelect, minimum: 0 })),
  /** 最大勾选数（仅多选有效，默认全部选项数） */
  maxSelect: Type.Optional(Type.Integer({ description: TEXTS.schema.questionMaxSelect, minimum: 1 })),
  /** 是否允许零勾选直接提交（默认 false） */
  allowEmpty: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionAllowEmpty })),
  /** 候选选项列表（1 项起，上限 `MAX_OPTIONS`，建议 2~10 项） */
  options: Type.Array(OptionSchema, { description: TEXTS.schema.questionOptions, minItems: 1, maxItems: MAX_OPTIONS }),
  /** 是否允许自由补充说明（默认 true） */
  allowCustom: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionAllowCustom })),
  /** 题目整体补充说明的占位引导词 */
  customPlaceholder: Type.Optional(Type.String({ description: TEXTS.schema.questionCustomPlaceholder })),
  /** 该题目的显示条件（不成立时不展示，也不计入答卷） */
  showIf: showIfField(TEXTS.schema.questionShowIf),
  /** 该题目的实时推演配置（缺省继承表单级 `expansion`） */
  expansion: Type.Optional(QuestionExpansionSchema),
});

/** 实时推演参数：作者确认答案后由同一模型追加题目与选项 */
export const ExpansionSchema = Type.Object({
  /** 推演后的题目总量上限（含已声明的题目） */
  maxQuestions: Type.Optional(
    Type.Integer({ description: TEXTS.schema.expansionMaxQuestions, minimum: 1, maximum: MAX_QUESTIONS }),
  ),
  /** 长期生效的推演方向指示 */
  guidance: Type.Optional(Type.String({ description: TEXTS.schema.expansionGuidance })),
  /** 推演题目的插入位置（缺省为跟随触发题目） */
  insert: Type.Optional(InsertPositionSchema),
});

/** 全部参数 Schema（必须填写 `formTitle`；批量问卷传 `questions`，单题平铺传顶层 `question` + `options`） */
export const AskAuthorParams = Type.Object({
  /** 问卷总任务标题（简明概括请示主题） */
  formTitle: Type.String({ description: TEXTS.schema.formTitle }),
  /** 问卷全局背景或前述情境（平铺单题模式下同时充当该题描述） */
  description: Type.Optional(Type.String({ description: TEXTS.schema.formDesc })),
  /** 实时推演开关（开启后作者每次确认答案都追加后续题目与选项） */
  expansion: Type.Optional(ExpansionSchema),

  // ===== 批量问卷模式 =====
  /** 关联多题批量问卷列表（批量模式使用，上限 `MAX_QUESTIONS` 题） */
  questions: Type.Optional(
    Type.Array(QuestionSchema, { description: TEXTS.schema.formQuestions, minItems: 1, maxItems: MAX_QUESTIONS }),
  ),

  // ===== 单题平铺模式（描述统一带 flat-mode 区分前缀） =====
  /** 单题平铺模式题目标题（仅在携带非空 `options` 时参与选题，缺省回退 `TEXTS.fallbacks`） */
  question: Type.Optional(Type.String({ description: TEXTS.schema.formSingleQuestion })),
  /** 单题平铺模式是否允许多选（默认 false） */
  multiSelect: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMultiSelect}` }),
  ),
  /** 单题平铺模式最小勾选数（默认 1） */
  minSelect: Type.Optional(
    Type.Integer({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMinSelect}`, minimum: 0 }),
  ),
  /** 单题平铺模式最大勾选数（默认全部选项数） */
  maxSelect: Type.Optional(
    Type.Integer({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMaxSelect}`, minimum: 1 }),
  ),
  /** 单题平铺模式是否允许零勾选提交（默认 false） */
  allowEmpty: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionAllowEmpty}` }),
  ),
  /** 单题平铺模式候选选项列表（1~`MAX_OPTIONS` 项） */
  options: Type.Optional(
    Type.Array(OptionSchema, { description: TEXTS.schema.flatQuestionOptions, minItems: 1, maxItems: MAX_OPTIONS }),
  ),
  /** 单题平铺模式是否允许自由补充说明（默认 true） */
  allowCustom: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionAllowCustom}` }),
  ),
  /** 单题平铺模式补充说明的占位引导词 */
  customPlaceholder: Type.Optional(
    Type.String({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionCustomPlaceholder}` }),
  ),
});

/**
 * 工具的运行时参数类型（`prepareArguments` 清洗后的白名单形状），由 {@link AskAuthorParams} 派生
 */
export type RawParams = Static<typeof AskAuthorParams>;

/** 单个候选选项的运行时类型 */
export type QuestionOption = Static<typeof OptionSchema>;

/** 单个问题的运行时类型（批量与平铺共用） */
export type QuestionInput = Static<typeof QuestionSchema>;

/** 单个显示条件的运行时类型 */
export type VisibilityConditionInput = Static<typeof ShowIfConditionSchema>;

/** 题目级推演配置的运行时类型 */
export type QuestionExpansionConfig = Static<typeof QuestionExpansionSchema>;

/** `showIf` 字段的运行时类型：单个条件或条件数组 */
export type ShowIfInput = VisibilityConditionInput | VisibilityConditionInput[];

/** 实时推演配置的运行时类型 */
export type ExpansionConfig = Static<typeof ExpansionSchema>;

/** 推演题目插入位置的运行时类型 */
export type InsertPosition = Static<typeof InsertPositionSchema>;

/** 推演向既有题目追加的一组选项 */
export interface OptionAddition {
  /** 目标题目的 ID（必须是表单中已存在的题目） */
  readonly questionId: string;
  /** 待追加的选项（标签与既有选项不重复） */
  readonly options: QuestionOption[];
}

/** 一次推演的产出：待追加的新题目与向既有题目追加的选项 */
export interface ExpansionPayload {
  /** 追加到题目列表末尾的新题目 */
  readonly questions: QuestionInput[];
  /** 向既有题目追加的选项 */
  readonly optionAdditions: OptionAddition[];
}
