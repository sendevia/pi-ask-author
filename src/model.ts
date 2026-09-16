/**
 * @file model.ts
 * @description 问卷数据模型与状态机：题目归一化、作答状态流转、答卷编译与封套输出
 *
 * 核心架构特性：
 * - 索引约定：内部作答状态 0-based，对外答卷编号 1-based
 * - 两层清洗：`sanitize.ts` 边界归一化 + 本层对文本字段幂等兜底（绕过 sanitize 直接构造模型时同样安全）
 * - 封套防止击穿：插值文本经由 `sanitizeEnvelopeText` 归一化，定界符不可被作者文本击穿
 * - 封套语言单一：自动生成的占位题目/标签在封套编译期替换为英文占位（`Question N` / `Option N`），作者界面保留中文占位
 * - 答卷完整性：显式跳过与仅批注提交均产出条目，多选题目恒产出条目，问题不在结果中静默消失
 *
 * 依赖方向：model.ts → format.ts / schema.ts / texts.ts（纯函数工具、Schema 单一类型源与文案字典，无回边）；不引用 `Theme` 与 TUI 组件，渲染细节全部上移组件层
 */

import { cleanOptional, cleanText, clamp, compressDraftPreview, toSingleLine } from "./format.js";
import { TEXTS } from "./texts.js";
import type { QuestionInput, QuestionOption, RawParams } from "./schema.js";

/** 归一化后的问题对象（字段已兜底，区间已收敛） */
export interface NormalizedQuestion {
  /** 题目唯一标识符 */
  id: string;
  /** 题目标题 */
  title: string;
  /** 题目背景描述（可选） */
  description?: string;
  /** 是否多选（默认 false，即单选） */
  multiSelect: boolean;
  /** 收敛后的最少勾选数（`0 ~ options.length`） */
  minSelect: number;
  /** 是否显式给出 `minSelect`（显式即强制下限，隐式为缺省下限） */
  minSelectExplicit: boolean;
  /** 收敛后的最多勾选数（`minSelect ~ options.length`） */
  maxSelect: number;
  /** 是否允许 0 勾选提交（默认 false；单选与多选均生效） */
  allowEmpty: boolean;
  /** 归一化后的候选选项列表（至少一项） */
  options: QuestionOption[];
  /** 是否允许自由补充说明（默认 true） */
  allowCustom: boolean;
  /** 补充说明输入框占位提示词 */
  customPlaceholder: string;
}

/** 单题作答状态（内部数据结构，选项索引 0-based） */
export interface QuestionAnswerState {
  /** 单选选中项索引（0-based；未选中时缺省） */
  selectedIndex?: number;
  /** 多选选中项索引集合（0-based） */
  selectedIndices: Set<number>;
  /** 题目级整体补充说明（可选） */
  customText?: string;
  /** 选项批注映射（0-based `optionIndex` → 批注内容） */
  optionNotes: Map<number, string>;
}

/** 单题最终答卷条目（索引 1-based 便于人类阅读） */
export interface AuthorAnswerItem {
  /** 题目唯一标识符 */
  questionId: string;
  /** 题目标题 */
  questionTitle: string;
  /** 是否为多选模式 */
  multiSelect: boolean;
  /** 单选选中项（含专属批注，可选） */
  selectedOption?: QuestionOption & { customText?: string };
  /** 单选选中项序号（1-based；未选中时缺省） */
  selectedOptionIndex?: number;
  /** 多选选中项列表（每项含专属批注，可选） */
  selectedOptions?: Array<QuestionOption & { customText?: string }>;
  /** 多选选中项序号列表（1-based，升序） */
  selectedIndices?: number[];
  /** 题目整体补充说明（可选） */
  customText?: string;
  /** 选项批注映射（1-based `optionIndex` → 批注内容，可选；含未选中选项上的孤立批注） */
  optionNotes?: Record<number, string>;
}

/** 工具执行完成返回的持久化结果结构 */
export interface AskAuthorResult {
  /** 问卷总标题 */
  formTitle: string;
  /** 问卷全局背景描述（可选） */
  formDescription?: string;
  /** 归一化的问题列表 */
  questions: NormalizedQuestion[];
  /** 收集到的答卷条目列表 */
  answers: AuthorAnswerItem[];
  /** 用户是否主动取消了本次请示 */
  cancelled: boolean;
  /** 执行过程中的错误信息（可选） */
  error?: string;
}

/** 批注编辑目标：`question` 题目整体 / `option` 指定选项专属（`optionIndex` 为 0-based，越界不写入状态） */
export type EditTarget = { type: "question" } | { type: "option"; optionIndex: number };

/** 题目视图左侧菜单项的统一抽象模型 */
export interface MenuItem {
  /** 菜单项类型：预设选项 / 题目补充入口 / 确认按钮 */
  type: "option" | "custom_note" | "confirm_btn";
  /** 预设选项索引（0-based，仅 option 类型有效） */
  optionIndex?: number;
  /** 菜单项显示文本 */
  label: string;
  /** 菜单项背景描述推演 */
  description?: string;
  /** 菜单项正文草稿/分镜头预览 */
  preview?: string;
}

/** 勾选 toggle 操作语义（三个操作语义类型均不导出，由组件层消费并映射为状态栏提示） */
type ToggleResult = "selected" | "deselected" | "limit";

/** 全选/清空操作语义 */
type SelectAllResult = "cleared" | "filled";

/** 批注保存操作语义 */
type NoteSaveResult = "saved" | "cleared" | "savedUnselected" | "savedAtLimit";

/**
 * 判定是否存在非空题目级批注
 * @param st - 题目作答状态
 * @returns `customText` 去空白后非空时为 true
 */
export function hasQuestionNote(st: QuestionAnswerState): boolean {
  return Boolean(st.customText?.trim());
}

/**
 * 判定是否存在非空选项批注
 * @param st - 题目作答状态
 * @returns 任一选项批注去空白后非空时为 true
 */
function hasAnyOptionNote(st: QuestionAnswerState): boolean {
  for (const n of st.optionNotes.values()) {
    if (n?.trim()) return true;
  }
  return false;
}

/**
 * 判定是否存在任意非空批注（题目级或选项级）
 * @param st - 题目作答状态
 * @returns 题目级或任一选项级批注非空时为 true
 */
function hasAnyNote(st: QuestionAnswerState): boolean {
  return hasQuestionNote(st) || hasAnyOptionNote(st);
}

/**
 * 只读兜底空作答状态（供 `isQuestionAnswered` 读取尚未懒加载的题目）
 * 约定式只读：本对象的 `selectedIndices` / `optionNotes` 永不写入，可写状态经 `getState` 懒加载
 */
const EMPTY_STATE: QuestionAnswerState = { selectedIndices: new Set<number>(), optionNotes: new Map<number, string>() };

/** 多选区间收敛结构模型 */
interface SelectBounds {
  /** 收敛后的最少勾选数下限 */
  minSelect: number;
  /** 是否显式给出最少勾选数（区分缺省下限与强制下限） */
  minSelectExplicit: boolean;
  /** 收敛后的最多勾选数上限 */
  maxSelect: number;
}

/**
 * 依据选项实际数量收敛 min/max 边界
 * @param minRaw - 原始最少勾选数
 * @param maxRaw - 原始最多勾选数
 * @param optionCount - 题目选项总数
 * @returns 收敛区间：`minSelect` 取值范围为 `[0, optionCount]`、`maxSelect` 取值范围为 `[minSelect, optionCount]`（0 选项题目恒设置为 `0/0`）；`minSelectExplicit` 标记入参是否显式给出下限
 */
function clampSelectBounds(minRaw: number | undefined, maxRaw: number | undefined, optionCount: number): SelectBounds {
  const minSelectExplicit = minRaw !== undefined;
  const minSelect = clamp(minRaw ?? 1, 0, optionCount);
  const maxSelect = clamp(maxRaw ?? optionCount, minSelect, optionCount);
  return { minSelect, minSelectExplicit, maxSelect };
}

/**
 * 规整单个题目为标准数据结构
 * 全程对文本字段应用幂等 `cleanOptional` 兜底，使绕过 sanitize 钩子直接构造模型时同样安全
 * @param q - 原始题目输入（可能未经 sanitize 层清洗）
 * @param index - 题目顺序索引（0-based），仅用于派生缺省 id 与标题
 * @returns id/title/label 为空时回退 `TEXTS.fallbacks`；`minSelect` / `maxSelect` 收敛至 `[0, options.length]` 且保证 `minSelect <= maxSelect`
 */
function buildQuestion(q: QuestionInput, index: number): NormalizedQuestion {
  return {
    id: cleanOptional(q.id) ?? TEXTS.fallbacks.autoQuestionId(index + 1),
    title: cleanOptional(q.title) ?? TEXTS.fallbacks.autoQuestionTitle(index + 1),
    description: cleanOptional(q.description),
    multiSelect: Boolean(q.multiSelect),
    ...clampSelectBounds(q.minSelect, q.maxSelect, q.options.length),
    options: q.options.map((o) => ({
      label: cleanOptional(o.label) ?? TEXTS.fallbacks.unnamedOptionLabel,
      description: cleanOptional(o.description),
      preview: cleanOptional(o.preview),
      customPlaceholder: cleanOptional(o.customPlaceholder),
    })),
    allowEmpty: Boolean(q.allowEmpty),
    allowCustom: q.allowCustom !== false,
    customPlaceholder: cleanOptional(q.customPlaceholder) ?? TEXTS.fallbacks.defaultCustomPlaceholder,
  };
}

/**
 * 去重题目 ID（LLM 跨题重复 id 会导致 `formatAnswers` 按 id 归属查询时错误归题；重复项回退为顺序自动生成 id，仍冲突追加序号后缀）
 * @param questions - 归一化题目列表
 * @returns ID 全局唯一的题目列表
 */
function dedupeQuestionIds(questions: NormalizedQuestion[]): NormalizedQuestion[] {
  const used = new Set<string>();
  return questions.map((q, index) => {
    if (!used.has(q.id)) {
      used.add(q.id);
      return q;
    }
    let candidate = TEXTS.fallbacks.autoQuestionId(index + 1);
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${candidate}_${suffix}`;
    }
    used.add(candidate);
    return { ...q, id: candidate };
  });
}

/**
 * 封套注入消毒：折叠单行并归一化全部可击穿封套定界符的字符（封套以 ASCII 方括号与 `;` 承载结构语义，插值文本须先归一，否则 LLM 无法定位批注边界，亦可能被伪造令牌误导）
 * 替换顺序：折叠单行 → 弯引号族（`“”„‟«»`）转换为 `'` → ASCII 方括号转换为全角 `［］`（`answerLine` 的 `[标题]` 与 `[Author note: …]` / `[Draft directive: …]` 令牌定界符全由模板注入）→ 剥除 `【】`（封套选项标签专属定界符）→ ASCII `;` 转换为全角 `；`（封套以 `; ` 分隔选项片段）
 * @param text - 原始批注/描述/标签文本
 * @returns 归一化后的单行文本；半角 `[` / `]` / `;` 与换行均已消除，令牌边界不可能被插值文本提前闭合或伪造
 */
function sanitizeEnvelopeText(text: string): string {
  return toSingleLine(text)
    .replace(/[“”„‟«»]/g, "'")
    .replace(/[\[\]]/g, (bracket) => (bracket === "[" ? "［" : "］"))
    .replace(/[【】]/g, "")
    .replace(/;/g, "；");
}

/**
 * 把自动生成的占位题目标题替换为英文占位（非占位标题原样返回）
 * 语言归属：占位文案在 `sanitize.ts` / {@link buildQuestion} 阶段即以中文写入题目对象，结构上无法保留身份标记，故按生成函数的返回值比对；作者或模型写出同名字面量时，封套仅替换为英文占位
 * @param title - 答卷条目的题目标题（可能为 `问题 N` 或 `请选择接下来的创作方案`）
 * @param questionIndex - 题目顺序索引（0-based）；缺省表示无法定位，按非占位原样返回
 * @returns 非占位标题保持原样；占位标题替换为 `TEXTS.markdown.fallbackQuestionTitle(questionIndex + 1)`
 */
function envelopeQuestionTitle(title: string, questionIndex: number | undefined): string {
  if (questionIndex === undefined) return title;
  const isPlaceholder =
    title === TEXTS.fallbacks.defaultQuestionTitle || title === TEXTS.fallbacks.autoQuestionTitle(questionIndex + 1);
  return isPlaceholder ? TEXTS.markdown.fallbackQuestionTitle(questionIndex + 1) : title;
}

/**
 * 把自动生成的占位选项标签替换为英文占位（非占位标签原样返回）
 * 占位来源三选一：`sanitize.ts` 的 `选项 N` / `默认方案`，{@link buildQuestion} 的 `未命名方案`；比对理由同 {@link envelopeQuestionTitle}
 * @param label - 选项标签（可能为自动生成的占位）
 * @param optionIndex1 - 选项序号（1-based，与占位标签的编号一致）；缺省表示无法定位，按非占位原样返回
 * @returns 非占位标签保持原样；占位标签替换为 `TEXTS.markdown.fallbackOptionLabel(optionIndex1)`
 */
function envelopeOptionLabel(label: string, optionIndex1: number | undefined): string {
  if (optionIndex1 === undefined) return label;
  const isPlaceholder =
    label === TEXTS.fallbacks.unnamedOptionLabel ||
    label === TEXTS.fallbacks.defaultOptionLabel ||
    label === TEXTS.fallbacks.autoOptionLabel(optionIndex1);
  return isPlaceholder ? TEXTS.markdown.fallbackOptionLabel(optionIndex1) : label;
}

/**
 * 问卷数据模型：题目归一化、作答状态流转与答卷编译；全部状态突变经本类 mutation 方法完成并自动推进 `revision`，组件层只读
 * 只读访问面：`revision` / `questionCount` / `getQuestion` / `getState` / `getSelectedIndices`（0-based 升序，排序不变量唯一实现）/ `getMenuItems` / `isQuestionAnswered` / `areAllQuestionsAnswered` / `compileAnswers` / `formatAnswers`
 */
export class AskAuthorFormModel {
  /** 问卷总标题 */
  readonly formTitle: string;
  /** 问卷全局背景阐述（可选） */
  readonly formDescription?: string;
  /** 归一化后的题目列表 */
  readonly questions: NormalizedQuestion[];

  /** 作答状态版本号：单调递增，作为组件层派生缓存的失效键 */
  private revisionValue = 0;

  /** 各题作答状态映射（题目索引 0-based） */
  private readonly states = new Map<number, QuestionAnswerState>();

  /**
   * 构造问卷数据模型实例（单题平铺与批量问卷两模式归一化）
   * @param rawParams - 经 prepareArguments 规整的入参；`questions` 缺省或为空数组时回退单题平铺模式，`options` 亦为空则题目列表为空
   */
  constructor(rawParams: RawParams) {
    const rawQuestions = rawParams.questions ?? [];
    const isBatch = rawQuestions.length > 0;
    this.formTitle = cleanOptional(rawParams.formTitle) ?? TEXTS.fallbacks.defaultFormTitle;
    this.formDescription = cleanOptional(rawParams.description);

    if (isBatch) {
      this.questions = dedupeQuestionIds(rawQuestions.map((q, i) => buildQuestion(q, i)));
    } else if (rawParams.options?.length) {
      this.questions = [
        buildQuestion(
          {
            title: cleanOptional(rawParams.question) ?? TEXTS.fallbacks.defaultQuestionTitle,
            description: cleanOptional(rawParams.description),
            multiSelect: rawParams.multiSelect,
            minSelect: rawParams.minSelect,
            maxSelect: rawParams.maxSelect,
            allowEmpty: rawParams.allowEmpty,
            options: rawParams.options,
            allowCustom: rawParams.allowCustom,
            customPlaceholder: rawParams.customPlaceholder,
          },
          0,
        ),
      ];
    } else {
      this.questions = [];
    }
  }

  /** 当前作答状态版本号（组件层派生缓存失效键） */
  get revision(): number {
    return this.revisionValue;
  }

  /** 问卷题目总数 */
  get questionCount(): number {
    return this.questions.length;
  }

  /**
   * 获取指定索引的归一化题目
   * @param index - 题目顺序索引（0-based）
   * @returns 归一化题目对象；索引越界时为 undefined
   */
  getQuestion(index: number): NormalizedQuestion | undefined {
    return this.questions[index];
  }

  /**
   * 获取指定题目的作答状态（懒加载单例初始化）
   * 不校验题目边界：越界索引同样创建并缓存一个空状态对象（调用方须先经 {@link getQuestion} 校验）
   * @param index - 题目顺序索引（0-based）
   * @returns 该题目的状态引用，可写入，同一索引恒返回同一对象；首次创建仅初始化内部缓存，不改变任何可观察作答语义、不推进 `revision`
   */
  getState(index: number): QuestionAnswerState {
    let st = this.states.get(index);
    if (!st) {
      st = { selectedIndices: new Set<number>(), optionNotes: new Map<number, string>() };
      this.states.set(index, st);
    }
    return st;
  }

  /**
   * 获取已勾选选项索引（0-based 升序，未作答为空数组；排序不变量唯一实现在此）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 全新数组（调用方可安全持有而不影响内部状态）；题目越界或状态未创建时为空数组
   */
  getSelectedIndices(qIndex: number): number[] {
    const st = this.states.get(qIndex);
    return st ? Array.from(st.selectedIndices).sort((a, b) => a - b) : [];
  }

  /** 推进作答状态版本号（全部 mutation 方法的统一出口） */
  private bumpRevision(): void {
    this.revisionValue++;
  }

  /**
   * 派生指定题目的左侧菜单项列表（预设选项 + 自由补充入口 + 确认推进按钮）
   * 菜单项标签与确认按钮明细随当前作答状态派生：多选展示已选数/下限，单选展示已选项标签、自定义方案名或「未选」
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 顺序固定的菜单项数组（选项按声明顺序在前、补充入口居中、确认按钮殿后）；题目越界为空数组；`allowCustom` 为 false 时省略补充入口
   */
  getMenuItems(qIndex: number): MenuItem[] {
    const q = this.getQuestion(qIndex);
    if (!q) return [];
    const st = this.getState(qIndex);
    const noted = hasAnyNote(st);

    const items: MenuItem[] = q.options.map((opt, optionIndex) => ({
      type: "option",
      optionIndex,
      label: opt.label,
      description: opt.description,
      preview: opt.preview,
    }));

    if (q.allowCustom) {
      items.push({
        type: "custom_note",
        label: hasQuestionNote(st) ? TEXTS.menu.customNoteLabelFilled : TEXTS.menu.customNoteLabel,
      });
    }

    const confirmDetail = q.multiSelect
      ? TEXTS.menu.confirmDetailMulti(st.selectedIndices.size, q.minSelect)
      : st.selectedIndex !== undefined
        ? (q.options[st.selectedIndex]?.label ?? TEXTS.fallbacks.unselectedOption)
        : noted
          ? TEXTS.fallbacks.defaultCustomChoiceName
          : TEXTS.fallbacks.unselectedOption;

    items.push({
      type: "confirm_btn",
      label: TEXTS.menu.confirmLabel(confirmDetail, noted),
      description: TEXTS.menu.confirmDesc,
    });

    return items;
  }

  /**
   * 判定指定题目是否满足作答下限提交要求
   * 单选：已选一项、`allowEmpty`，或 `allowCustom` 开启且存在任意非空批注；多选：勾选数达 `minSelect`、`allowEmpty` 下 0 选，
   * 或缺省下限未勾选（`minSelect` 未显式给出时收敛为 `min(1, 选项数)`，故此时 `count < minSelect` 等价于 `count === 0`）且 `allowCustom` 开启并存在任意非空批注
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 题目越界恒为 false；作答状态尚未懒加载时按只读空状态（{@link EMPTY_STATE}）判定，不写入任何状态
   */
  isQuestionAnswered(qIndex: number): boolean {
    const q = this.questions[qIndex];
    if (!q) return false;
    const st = this.states.get(qIndex) ?? EMPTY_STATE;

    if (!q.multiSelect) {
      return st.selectedIndex !== undefined || q.allowEmpty || (q.allowCustom && hasAnyNote(st));
    }

    const count = st.selectedIndices.size;
    if (count >= q.minSelect) return true;
    if (count === 0 && q.allowEmpty) return true;
    // 缺省下限（未显式指定 minSelect）未勾选时，填写批注可直接提交
    if (!q.minSelectExplicit && count === 0 && q.allowCustom && hasAnyNote(st)) return true;

    return false;
  }

  /**
   * 判定问卷中的全部题目是否均已作答完毕
   * @returns 每题均满足 {@link isQuestionAnswered} 时为 true；题目列表为空时恒为 true（`every` 的空集语义）
   */
  areAllQuestionsAnswered(): boolean {
    return this.questions.every((_, idx) => this.isQuestionAnswered(idx));
  }

  // ===== 作答状态 mutation API（组件层唯一合法入口，全部自动推进 revision） =====

  /**
   * 切换指定选项勾选状态（空格键主路径；单选再次点击取消，多选达上限拒绝新增）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @returns `selected` / `deselected` / `limit`（题目越界、选项不存在、多选已达上限且未勾选时返回 `limit` 且不推进 `revision`）
   */
  toggleOption(qIndex: number, optionIndex: number): ToggleResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return "limit";
    const st = this.getState(qIndex);

    if (!q.multiSelect) {
      st.selectedIndex = st.selectedIndex === optionIndex ? undefined : optionIndex;
      this.bumpRevision();
      return st.selectedIndex === undefined ? "deselected" : "selected";
    }

    if (st.selectedIndices.has(optionIndex)) {
      st.selectedIndices.delete(optionIndex);
      this.bumpRevision();
      return "deselected";
    }
    if (st.selectedIndices.size >= q.maxSelect) return "limit";
    st.selectedIndices.add(optionIndex);
    this.bumpRevision();
    return "selected";
  }

  /**
   * 确认路径下的选项写入（Enter/Ctrl+S 推进确认；单选直接更改选择，多选未达上限时补充勾选，已满未勾选静默保持原状，仅真实变更推进 `revision`）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   */
  commitOption(qIndex: number, optionIndex: number): void {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return;
    const st = this.getState(qIndex);

    if (!q.multiSelect) {
      if (st.selectedIndex !== optionIndex) {
        st.selectedIndex = optionIndex;
        this.bumpRevision();
      }
      return;
    }
    if (st.selectedIndices.has(optionIndex) || st.selectedIndices.size >= q.maxSelect) return;
    st.selectedIndices.add(optionIndex);
    this.bumpRevision();
  }

  /**
   * 多选全选或一键清空（`a` 键）：已满或已全选时清空，否则按选项顺序填充至上限（保留既有勾选，恒保持 `size <= maxSelect`）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns `cleared` / `filled`（题目越界或非多选同样返回 `cleared` 且不推进 `revision`）
   */
  selectAllOrClear(qIndex: number): SelectAllResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.multiSelect) return "cleared";
    const st = this.getState(qIndex);

    if (st.selectedIndices.size >= q.maxSelect) {
      st.selectedIndices.clear();
      this.bumpRevision();
      return "cleared";
    }
    for (let i = 0; i < q.options.length && st.selectedIndices.size < q.maxSelect; i++) {
      st.selectedIndices.add(i);
    }
    this.bumpRevision();
    return "filled";
  }

  /**
   * 保存或清空选项专属批注（空文本视为清除；单选无选中项时随批注勾选，已有其他选中项仅附加批注不更改选择；多选已满且未勾选仅保存批注）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @param text - 批注内容（空视为清除）
   * @returns `saved` / `cleared` / `savedUnselected` / `savedAtLimit`（守卫路径返回 `cleared` 且不推进 `revision`；其余路径即使未实际改变批注集合——如原本无批注时清除——同样推进 `revision`）
   */
  setOptionNote(qIndex: number, optionIndex: number, text: string): NoteSaveResult {
    const q = this.getQuestion(qIndex);
    if (!q || !q.options[optionIndex]) return "cleared";
    const st = this.getState(qIndex);
    const cleaned = cleanOptional(text);
    this.bumpRevision();

    if (!cleaned) {
      st.optionNotes.delete(optionIndex);
      return "cleared";
    }
    st.optionNotes.set(optionIndex, cleaned);

    if (q.multiSelect) {
      if (st.selectedIndices.has(optionIndex)) return "saved";
      if (st.selectedIndices.size >= q.maxSelect) return "savedAtLimit";
      st.selectedIndices.add(optionIndex);
      return "saved";
    }
    if (st.selectedIndex === undefined) {
      st.selectedIndex = optionIndex;
      return "saved";
    }
    return st.selectedIndex === optionIndex ? "saved" : "savedUnselected";
  }

  /**
   * 保存或清空题目整体补充说明（空文本视为清空）
   * 本方法不校验题目边界：越界索引同样经 {@link getState} 创建并写入状态对象
   * @param qIndex - 题目顺序索引（0-based）
   * @param text - 批注内容（经 `cleanOptional` 归一，空串或全空白视为清空）
   * @returns `saved`（存入非空文本）/ `cleared`（清空）；无论是否发生实际变更均推进 `revision`
   */
  setQuestionNote(qIndex: number, text: string): "saved" | "cleared" {
    const st = this.getState(qIndex);
    const cleaned = cleanOptional(text);
    st.customText = cleaned;
    this.bumpRevision();
    return cleaned ? "saved" : "cleared";
  }

  /**
   * 清空指定选项的专属批注（`x` 键路径；不存在时状态不变）
   * @param qIndex - 题目顺序索引（0-based）
   * @param optionIndex - 目标选项索引（0-based）
   * @returns 实际删除到条目时为 true（并推进 `revision`）；题目越界、状态未创建或该选项无批注时为 false（状态与 `revision` 均不变）
   */
  clearOptionNote(qIndex: number, optionIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st?.optionNotes.has(optionIndex)) return false;
    st.optionNotes.delete(optionIndex);
    this.bumpRevision();
    return true;
  }

  /**
   * 清空题目整体补充说明（`x` 键路径；不存在时状态不变）
   * @param qIndex - 题目顺序索引（0-based）
   * @returns 题目级批注存在且去空白后非空并被清空时为 true（并推进 `revision`）；题目越界、状态未创建或批注为空时为 false（状态与 `revision` 均不变）
   */
  clearQuestionNote(qIndex: number): boolean {
    const st = this.states.get(qIndex);
    if (!st?.customText?.trim()) return false;
    st.customText = undefined;
    this.bumpRevision();
    return true;
  }

  /**
   * 收集全部非空选项批注（含未选中选项上的孤立批注），键转换为 1-based；与总览页展示保持一致
   * @param q - 归一化题目对象
   * @param st - 题目作答状态（可选）
   * @returns 1-based 选项索引 → 批注内容的映射表
   */
  private collectOptionNotes(q: NormalizedQuestion, st: QuestionAnswerState | undefined): Record<number, string> {
    const optNotes: Record<number, string> = {};
    if (!st) return optNotes;
    for (const [idx, note] of st.optionNotes) {
      const cleaned = cleanOptional(note);
      if (cleaned && q.options[idx]) {
        optNotes[idx + 1] = cleaned;
      }
    }
    return optNotes;
  }

  /**
   * 编译全部作答状态为结果答案条目列表
   * 产出规则：多选题目恒产出条目（未作答时 `selectedOptions` / `selectedIndices` 为空）；单选题目仅在已作答时才产出条目（已选一项、`allowEmpty` 主动跳过或仅批注提交）
   * 两种模式均杜绝问题在结果封套中静默消失；0-based 内部索引统一转换为 1-based
   * @returns 与题目顺序一致的答卷条目列表（未产出的单选题目不占位）；题干无任何作答且非多选时为空数组
   */
  compileAnswers(): AuthorAnswerItem[] {
    const answers: AuthorAnswerItem[] = [];

    for (const [i, q] of this.questions.entries()) {
      const st = this.states.get(i);
      const customText = st?.customText?.trim() ? cleanText(st.customText.trim()) : undefined;
      const base = { questionId: q.id, questionTitle: q.title, customText };

      if (q.multiSelect) {
        const selectedIdxs = this.getSelectedIndices(i);
        const optNotes = this.collectOptionNotes(q, st);
        const selectedOptions: Array<QuestionOption & { customText?: string }> = [];

        for (const idx of selectedIdxs) {
          const opt = q.options[idx];
          if (!opt) continue;
          selectedOptions.push({ ...opt, customText: optNotes[idx + 1] });
        }

        const hasNotes = Object.keys(optNotes).length > 0;
        answers.push({
          ...base,
          multiSelect: true,
          selectedOptions,
          selectedIndices: selectedIdxs.map((idx) => idx + 1),
          optionNotes: hasNotes ? optNotes : undefined,
        });
      } else if (st?.selectedIndex !== undefined) {
        const opt = q.options[st.selectedIndex];
        const optNotes = this.collectOptionNotes(q, st);

        answers.push({
          ...base,
          multiSelect: false,
          selectedOption: opt ? { ...opt, customText: optNotes[st.selectedIndex + 1] } : undefined,
          selectedOptionIndex: st.selectedIndex + 1,
          optionNotes: Object.keys(optNotes).length > 0 ? optNotes : undefined,
        });
      } else if (this.isQuestionAnswered(i)) {
        // 无选项勾选的显式决策（仅批注提交或 allowEmpty 主动跳过）必须产出条目，否则 LLM 无法区分「作者主动跳过」与「问题未曾提出」
        const optNotes = this.collectOptionNotes(q, st);
        const hasNotes = Object.keys(optNotes).length > 0;
        answers.push({ ...base, multiSelect: false, optionNotes: hasNotes ? optNotes : undefined });
      }
    }

    return answers;
  }

  /**
   * 编译答案为确定性标准 Markdown 封套文本（固定前缀与收尾指令最大化 Prompt Cache 命中率并驱动下游工作流）
   * 全部插值文本经 {@link sanitizeEnvelopeText} 消毒（半角 `[` / `]` / `;` 与换行一并归一，模板注入的令牌边界不可被插值文本提前闭合或伪造）
   * 确定性来源：片段顺序固定为「已选项（`getSelectedIndices` 升序）→ 未选中选项的孤立批注（`Record` 整数键升序）→ 题目级批注」，不依赖哈希序与时间
   * 语言归属：自动生成的占位题目/标签经由 {@link envelopeQuestionTitle} / {@link envelopeOptionLabel} 替换为英文占位，其余插值文本原样保留（作者文本不翻译）
   * @param answers - 答卷列表（通常来自 {@link compileAnswers}）
   * @returns `envelopePrefix` + 逐题一行（1-based 序号 + 标题 + `; ` 连接的片段）+ `envelopeSuffix`；`answers` 为空时退化为空答卷封套
   */
  formatAnswers(answers: AuthorAnswerItem[]): string {
    if (answers.length === 0) {
      return `${TEXTS.markdown.envelopePrefix}\n${TEXTS.markdown.envelopeEmpty}\n${TEXTS.markdown.envelopeSuffix}`;
    }

    /** 包装批注为 `[Author note: …]` 令牌（空串返回空串，先经 `sanitizeEnvelopeText` 消毒） */
    const noteToken = (text: string): string =>
      text ? `${TEXTS.markdown.notePrefix}${sanitizeEnvelopeText(text)}${TEXTS.markdown.noteSuffix}` : "";
    /** 包装已压缩草稿为 `[Draft directive: …]` 令牌（缺省或空串返回空串，先经 `sanitizeEnvelopeText` 消毒） */
    const directiveToken = (draft?: string): string =>
      draft
        ? `${TEXTS.markdown.draftDirectivePrefix}${sanitizeEnvelopeText(draft)}${TEXTS.markdown.draftDirectiveSuffix}`
        : "";

    const questionsById = new Map(this.questions.map((q) => [q.id, q]));
    const questionIndexById = new Map(this.questions.map((q, index) => [q.id, index]));

    const answerLines = answers.map((ans, i) => {
      const questionIndex = questionIndexById.get(ans.questionId);
      const selected = ans.multiSelect ? (ans.selectedOptions ?? []) : ans.selectedOption ? [ans.selectedOption] : [];
      // 封套逐行编号要求单行结构：标签/推演/批注统一折叠换行，杜绝多行内容破坏封套格式
      const parts = selected.map((o, j) => {
        const compressedDraft = compressDraftPreview(o.preview);
        const optNote = noteToken(cleanOptional(o.customText) ?? "");
        const optionIndex1 = ans.multiSelect ? ans.selectedIndices?.[j] : ans.selectedOptionIndex;
        const label = sanitizeEnvelopeText(envelopeOptionLabel(o.label, optionIndex1));
        const desc = sanitizeEnvelopeText(o.description ?? "");
        return desc
          ? TEXTS.markdown.optionWithDesc(label, desc, directiveToken(compressedDraft), optNote)
          : TEXTS.markdown.optionWithoutDesc(label, directiveToken(compressedDraft), optNote);
      });

      // 附带未选中选项上的孤立批注（与总览页展示一致）
      const q = questionsById.get(ans.questionId);
      if (q && ans.optionNotes) {
        const selectedIdxSet = new Set(
          ans.multiSelect
            ? (ans.selectedIndices ?? [])
            : ans.selectedOptionIndex !== undefined
              ? [ans.selectedOptionIndex]
              : [],
        );
        for (const [idxStr, note] of Object.entries(ans.optionNotes)) {
          const idx1 = Number(idxStr);
          if (selectedIdxSet.has(idx1)) continue;
          const rawLabel = q.options[idx1 - 1]?.label;
          if (rawLabel && note) {
            parts.push(
              TEXTS.markdown.unselectedOptionNote(
                sanitizeEnvelopeText(envelopeOptionLabel(rawLabel, idx1)),
                noteToken(note),
              ),
            );
          }
        }
      }

      if (ans.customText) parts.push(noteToken(ans.customText));
      const body = parts.join(TEXTS.markdown.partSeparator) || TEXTS.markdown.noSelection;
      return TEXTS.markdown.answerLine(
        i + 1,
        sanitizeEnvelopeText(envelopeQuestionTitle(ans.questionTitle, questionIndex)),
        body,
      );
    });

    return `${TEXTS.markdown.envelopePrefix}\n${answerLines.join("\n")}\n${TEXTS.markdown.envelopeSuffix}`;
  }
}
