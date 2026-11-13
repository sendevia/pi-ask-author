/**
 * @file texts.ts
 * @description 全局文案字典的组装点：LLM 面协议常量与当前语言的作者面文案在此汇合
 *
 * 作者面文案一律取自 `lang/*.json`，本文件只做装载、组合与派生，不新增字面量
 */

import { loadTexts } from "./i18n.js";
import { ICONS } from "./layout.js";
import { LLM_TEXTS } from "./llm-texts.js";

/** `{icon.<键>}` 占位符的解析器；非图标占位符返回 undefined，交由模板形参处理 */
const resolveTemplateConstant = (name: string): string | undefined =>
  name.startsWith("icon.") ? (ICONS as Readonly<Record<string, string>>)[name.slice(5)] : undefined;

/** 当前系统语言对应的作者面文案字典（结构以 `lang/en_US.json` 为规范） */
const LOCALE_TEXTS = loadTexts(resolveTemplateConstant);

/**
 * 渲染确认本题按钮标签
 * @param detail - 已选数与边界的计数片段（形如 `2/4`）；本题不受上下限约束时为空串
 * @returns 空片段时为 `󰄬 确认本题`，否则为 `󰄬 确认本题 (2/4)`
 */
const confirmLabel = (detail: string): string =>
  detail ? LOCALE_TEXTS.menu.confirmLabelWithDetail(detail) : LOCALE_TEXTS.menu.confirmLabel;

// ===== 文案字典 =====

/** 全局文案字典：LLM 面固定英文协议常量，作者面取自当前系统语言的语言文件 */
export const TEXTS = {
  // ===== LLM 面（恒为英文） =====

  /** 工具注册元数据：前四项面向 LLM，`label` 面向作者（工具行标题） */
  tool: { ...LLM_TEXTS.tool, label: LOCALE_TEXTS.tool.label },
  /** LLM 端 TypeBox 字段描述字典 */
  schema: LLM_TEXTS.schema,
  /** 实时推演协议（系统提示词、用户消息前缀与诊断文案） */
  expansion: LLM_TEXTS.expansion,
  /** LLM 端返回封套与纠正指令模板 */
  markdown: LLM_TEXTS.markdown,

  // ===== 作者面（取自语言文件，按界面流程排列） =====

  /** `/ask-author` 辅助命令元数据与作者可见提示 */
  command: LOCALE_TEXTS.command,
  /** 跨视图共用的排版片段（枚举分隔符、列表条目前缀与按键帮助分隔符） */
  common: LOCALE_TEXTS.common,
  /** Tab 导航栏标签文案（含题目类型短标记） */
  tabs: LOCALE_TEXTS.tabs,
  /** 题目标题区的面包屑片段（分隔符与补充说明面板名称） */
  titleArea: LOCALE_TEXTS.titleArea,
  /** 作答视图与预览区文案 */
  view: LOCALE_TEXTS.view,
  /** 题目菜单条目文案（`confirmLabel` 由已选计数片段组合而成） */
  menu: { ...LOCALE_TEXTS.menu, confirmLabel },
  /** 全屏补充说明编辑页的提示区按键帮助 */
  editor: LOCALE_TEXTS.editor,
  /** 底部临时状态栏通知（操作结果、阻断原因与纠正路径） */
  status: LOCALE_TEXTS.status,
  /** 底部按键帮助行片段（经 `common.helpSeparator` 拼接，条目按按键字母序排列） */
  help: LOCALE_TEXTS.help,
  /** 答卷总览确认页文案 */
  summary: LOCALE_TEXTS.summary,
  /** 会话回放卡片文案（调用态摘要、结果态徽标与展开态明细） */
  card: LOCALE_TEXTS.card,
  /** 兜底文案与自动命名派生：越界输入的最终回退，保证界面与封套永不空白 */
  fallbacks: LOCALE_TEXTS.fallbacks,
} as const;
