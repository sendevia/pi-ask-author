/**
 * @file schema.ts
 * @description `ask_author` 工具参数 Schema 与类型的单一源头（Single Source of Truth）
 *
 * 核心架构特性：
 * - 字段名称、可选性与区间约束（`minItems` / `maxItems` / `minimum`）仅在 TypeBox 定义一次，运行时类型经 `Static<typeof>` 派生
 * - 默认值不写入 Schema：题目内字段由 `sanitize.ts` 规整时填入（`multiSelect`→false、`allowCustom`→true），模型层再按同一语义兜底
 * - LLM 端字段描述保持单句浓缩英文（取自 `TEXTS.schema`）
 *
 * 依赖方向：schema.ts → typebox / texts.ts（上限常量与字段描述）；被 sanitize / model / index 消费
 */

import { Type, type Static } from "typebox";
import { MAX_OPTIONS, MAX_QUESTIONS, TEXTS } from "./texts.js";

/** 单个候选选项的参数 Schema */
const OptionSchema = Type.Object({
  /** 选项简短标题/行动标签（必须填写；缺失时经 `sanitize.ts` → `model.ts` 两级兜底为自动占位标签） */
  label: Type.String({ description: TEXTS.schema.optionLabel }),
  /** 情节推演后果或设定阐述（可选） */
  description: Type.Optional(Type.String({ description: TEXTS.schema.optionDesc })),
  /** Markdown 正文草稿或分镜头试撰写（可选） */
  preview: Type.Optional(Type.String({ description: TEXTS.schema.optionPreview })),
  /** 该选项专属补充说明的占位引导文案（可选） */
  customPlaceholder: Type.Optional(Type.String({ description: TEXTS.schema.optionCustomPlaceholder })),
});

/** 单个问题的参数 Schema（批量问卷与平铺模式共用） */
const QuestionSchema = Type.Object({
  /** 题目唯一标识符（可选；缺省由模型层按顺序生成，跨题重复由模型层去重） */
  id: Type.Optional(Type.String({ description: TEXTS.schema.questionId })),
  /** 题目标题（必须填写；缺失时两级兜底为自动占位标题） */
  title: Type.String({ description: TEXTS.schema.questionTitle }),
  /** 题目背景与语境（可选） */
  description: Type.Optional(Type.String({ description: TEXTS.schema.questionDesc })),
  /** 是否允许多选（可选；默认 false，即单选） */
  multiSelect: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionMultiSelect })),
  /** 最小勾选数下限（可选；仅多选有效，默认 1） */
  minSelect: Type.Optional(Type.Integer({ description: TEXTS.schema.questionMinSelect, minimum: 0 })),
  /** 最大勾选数上限（可选；仅多选有效，默认全部选项数） */
  maxSelect: Type.Optional(Type.Integer({ description: TEXTS.schema.questionMaxSelect, minimum: 1 })),
  /** 是否允许零勾选直接提交（可选；默认 false） */
  allowEmpty: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionAllowEmpty })),
  /** 候选选项列表（必须填写；1 项起、上限 `MAX_OPTIONS`，建议 2~10 项） */
  options: Type.Array(OptionSchema, { description: TEXTS.schema.questionOptions, minItems: 1, maxItems: MAX_OPTIONS }),
  /** 是否允许自由补充说明（可选；默认 true） */
  allowCustom: Type.Optional(Type.Boolean({ description: TEXTS.schema.questionAllowCustom })),
  /** 题目整体补充说明的占位引导词（可选） */
  customPlaceholder: Type.Optional(Type.String({ description: TEXTS.schema.questionCustomPlaceholder })),
});

/** `ask_author` 工具完整参数 Schema（必须填写 `formTitle`；批量问卷传递 `questions`，单题平铺传递顶层 `question` + `options`） */
export const AskAuthorParams = Type.Object({
  /** 问卷总任务标题（必须填写；简明概括请示主题） */
  formTitle: Type.String({ description: TEXTS.schema.formTitle }),
  /** 问卷全局背景或前述情境（可选；平铺单题模式下同时充当该题描述） */
  description: Type.Optional(Type.String({ description: TEXTS.schema.formDesc })),

  // ===== 批量问卷模式 =====
  /** 关联多题批量问卷列表（可选；批量模式使用，上限 `MAX_QUESTIONS` 题） */
  questions: Type.Optional(
    Type.Array(QuestionSchema, { description: TEXTS.schema.formQuestions, minItems: 1, maxItems: MAX_QUESTIONS }),
  ),

  // ===== 单题平铺模式（描述统一带 flat-mode 区分前缀） =====
  /** 单题平铺模式题目标题（可选；仅在携带非空 `options` 时参与选题，缺省回退 `TEXTS.fallbacks.defaultQuestionTitle`） */
  question: Type.Optional(Type.String({ description: TEXTS.schema.formSingleQuestion })),
  /** 单题平铺模式是否允许多选（可选；默认 false） */
  multiSelect: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMultiSelect}` }),
  ),
  /** 单题平铺模式最少勾选数下限（可选；默认 1） */
  minSelect: Type.Optional(
    Type.Integer({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMinSelect}`, minimum: 0 }),
  ),
  /** 单题平铺模式最多勾选数上限（可选；默认全部选项数） */
  maxSelect: Type.Optional(
    Type.Integer({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionMaxSelect}`, minimum: 1 }),
  ),
  /** 单题平铺模式是否允许零勾选提交（可选；默认 false） */
  allowEmpty: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionAllowEmpty}` }),
  ),
  /** 单题平铺模式候选选项列表（可选；1~`MAX_OPTIONS` 项） */
  options: Type.Optional(
    Type.Array(OptionSchema, { description: TEXTS.schema.flatQuestionOptions, minItems: 1, maxItems: MAX_OPTIONS }),
  ),
  /** 单题平铺模式是否允许自由补充说明（可选；默认 true） */
  allowCustom: Type.Optional(
    Type.Boolean({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionAllowCustom}` }),
  ),
  /** 单题平铺模式补充说明的占位引导词（可选） */
  customPlaceholder: Type.Optional(
    Type.String({ description: `${TEXTS.schema.flatPrefix}${TEXTS.schema.questionCustomPlaceholder}` }),
  ),
});

/**
 * `ask_author` 工具的运行时参数类型（`prepareArguments` 清洗后的白名单形状）
 * 由 {@link AskAuthorParams} 经 `Static<typeof>` 单一源头派生，可选性与区间约束以 Schema 为准
 */
export type RawParams = Static<typeof AskAuthorParams>;

/** 单个候选选项的运行时类型（由 `OptionSchema` 经 `Static<typeof>` 派生） */
export type QuestionOption = Static<typeof OptionSchema>;

/** 单个问题的运行时类型（由 `QuestionSchema` 经 `Static<typeof>` 派生，批量与平铺共用） */
export type QuestionInput = Static<typeof QuestionSchema>;
