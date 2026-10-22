import assert from "node:assert/strict";
import {
  ACTIVE_LOCALE,
  AdaptiveConditionError,
  AskAuthorFormModel,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  TEXTS,
  cleanOptional,
  detectLocale,
  padToVisibleWidth,
  safeLine,
  sanitizeAskAuthorArgs,
} from "../dist/index.js";
import { visibleWidth } from "@earendil-works/pi-tui";

// 1. 纯函数排版与格式化工具验证
{
  const ansiInput = "\x1b[31mhello\x1b[0m \x1b[1mworld\x1b[22m";
  const cleaned = cleanOptional(ansiInput);
  assert.equal(cleaned, "hello world", "cleanOptional 应通过原生工具剥离终端控制序列");

  const c0Input = "test\x00\x07string\nwith\rnewline";
  const c0Cleaned = cleanOptional(c0Input);
  assert.equal(c0Cleaned, "teststring\nwithnewline", "cleanOptional 应去除 C0 控制字符并保留有效换行");

  const line = "测试文本";
  const padded = padToVisibleWidth(line, 20);
  assert.equal(visibleWidth(padded), 20, "padToVisibleWidth 应填充至指定可见列宽");

  const longLine = "这是一段非常非常长的测试文本用于验证截断行为";
  const truncated = safeLine(longLine, 10);
  assert.ok(visibleWidth(truncated) <= 10, "safeLine 截断后可见宽度不超过指定上限");
}

// 2. 表单模型与参数清洗验证
{
  const raw = {
    formTitle: "创作方案请示",
    question: "选择后续剧情走向",
    options: [
      { label: "主角前往昆仑", description: "开启仙侠主线" },
      { label: "主角留在京城", description: "开启朝堂权谋线" },
    ],
  };

  const sanitized = sanitizeAskAuthorArgs(raw);
  assert.equal(sanitized.formTitle, "创作方案请示");
  assert.equal(sanitized.options?.length, 2);

  const model = new AskAuthorFormModel(sanitized);
  assert.equal(model.questionCount, 1);
  assert.equal(model.isQuestionAnswered(0), false);

  const toggleResult = model.toggleOption(0, 0);
  assert.equal(toggleResult, "selected");
  assert.equal(model.isQuestionAnswered(0), true);

  const answers = model.compileAnswers();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].selectedOption?.label, "主角前往昆仑");

  const markdown = model.formatAnswers(answers);
  assert.ok(markdown.includes("[Author Decision Finalized]"));
  assert.ok(markdown.includes("【主角前往昆仑】开启仙侠主线"));
}

// 3. 多选数量约束与批注流转验证
{
  const rawBatch = {
    formTitle: "多题请示",
    questions: [
      {
        title: "选择出战人员",
        multiSelect: true,
        minSelect: 1,
        maxSelect: 2,
        options: [
          { label: "剑客", preview: "剑出如龙" },
          { label: "法师", preview: "烈焰焚天" },
          { label: "刺客", preview: "一击必杀" },
        ],
      },
    ],
  };

  const sanitized = sanitizeAskAuthorArgs(rawBatch);
  const model = new AskAuthorFormModel(sanitized);

  model.toggleOption(0, 0);
  model.toggleOption(0, 1);
  const limitResult = model.toggleOption(0, 2);
  assert.equal(limitResult, "limit", "超过最大勾选数上限时应返回 limit");

  model.setOptionNote(0, 0, "使用配剑「霜华」");
  const answers = model.compileAnswers();
  const markdown = model.formatAnswers(answers);
  assert.ok(markdown.includes("[Author note: 使用配剑「霜华」]"));
  assert.ok(markdown.includes("[Draft directive: 剑出如龙]"), "选中选项的草稿预览应压缩为单行指令");
  assert.ok(markdown.includes("[Draft directive: 烈焰焚天]"), "多个选中选项的草稿指令均应保留");
}

// 4. 结果卡片折叠与展开隐式支持验证
{
  let registeredToolDef;
  const mockPi = {
    registerTool(def) {
      registeredToolDef = def;
    },
    registerCommand() {},
  };
  const { askAuthorExtension } = await import("../dist/index.js");
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();
  askAuthorExtension(mockPi);

  const dummyTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

  const collapsedComponent = registeredToolDef.renderResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        formTitle: "测试",
        questions: [],
        answers: [{ questionId: "1", questionTitle: "测试题", multiSelect: false, customText: "备注" }],
        cancelled: false,
      },
    },
    { expanded: false },
    dummyTheme,
    {},
  );

  const collapsedText = collapsedComponent.render(80).join("\n");
  assert.ok(collapsedText.includes(TEXTS.card.resultCompleted), "折叠态应包含完成状态");
  assert.ok(!collapsedText.includes("展开查看明细"), "折叠态不应包含显式展开快捷键提示");

  const expandedComponent = registeredToolDef.renderResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        formTitle: "测试",
        questions: [],
        answers: [{ questionId: "1", questionTitle: "测试题", multiSelect: false, customText: "备注" }],
        cancelled: false,
      },
    },
    { expanded: true },
    dummyTheme,
    {},
  );

  const expandedText = expandedComponent.render(80).join("\n");
  assert.ok(expandedText.includes("测试题"), "展开态应展示题目详细作答明细");
}

// 5. 语言探测与文案装载验证
{
  assert.equal(detectLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh_CN", "LC_ALL 应优先于 LANG");
  assert.equal(detectLocale({ LANG: "en_GB.UTF-8" }), "en_US", "应回退到同族语言 en_US");
  assert.equal(detectLocale({ LANGUAGE: "zh_TW:en_GB" }), "zh_CN", "LANGUAGE 冒号列表应按顺序探测并回退同族语言");
  assert.equal(detectLocale({ LANG: "ja_JP.UTF-8" }), "en_US", "无同族语言时应回退规范语言");
  assert.equal(detectLocale({ LANG: "C" }, "en-US"), "en_US", "C locale 应跳过并采用系统语言");
  assert.equal(detectLocale({}, "zh-Hans-CN"), "zh_CN", "系统语言应作为最后一位候选");
  assert.ok(["en_US", "zh_CN"].includes(ACTIVE_LOCALE), "当前界面语言应为已注册语言");
  assert.ok(TEXTS.tabs.questionTab(2).includes("2"), "语言模板应按形参插值");
  assert.throws(() => TEXTS.tabs.questionTab(), /形参数量不匹配/, "语言模板形参不足时应立即抛出");
  assert.ok(TEXTS.view.customNotePanelTips.length > 0, "文案列表应完整装载");
}

// 6. 自适应显示条件验证
{
  const buildBranching = () =>
    new AskAuthorFormModel(
      sanitizeAskAuthorArgs({
        formTitle: "自适应问卷",
        questions: [
          { id: "route", title: "选择路线", options: [{ label: "昆仑" }, { label: "京城" }] },
          {
            id: "kunlun",
            title: "昆仑细节",
            showIf: { questionId: "route", option: "昆仑" },
            options: [{ label: "雪山" }, { label: "地下河" }],
          },
          {
            id: "capital",
            title: "京城细节",
            showIf: [{ questionId: "route", option: "京城" }],
            options: [{ label: "朝堂" }, { label: "巷战", showIf: { questionId: "route", option: "昆仑" } }],
          },
        ],
      }),
    );

  const model = buildBranching();
  assert.deepEqual(model.getVisibleQuestionIndices(), [0], "初次进入只显示无条件的题目");
  assert.equal(model.isQuestionVisible(1), false);

  model.toggleOption(0, 1);
  assert.deepEqual(model.getVisibleQuestionIndices(), [0, 2], "选择京城后展开对应题目");
  assert.equal(model.isOptionVisible(2, 0), true);
  assert.equal(model.isOptionVisible(2, 1), false, "选项条件不成立时应隐藏");

  const branchOptions = model.getMenuItems(2).filter((item) => item.type === "option");
  assert.deepEqual(
    branchOptions.map((item) => item.label),
    ["朝堂"],
    "菜单不应包含条件不成立的选项",
  );

  model.toggleOption(2, 0);
  const capitalAnswers = model.compileAnswers();
  assert.equal(capitalAnswers.length, 2);
  assert.equal(capitalAnswers[1].questionTitle, "京城细节");

  model.toggleOption(0, 0);
  assert.deepEqual(model.getVisibleQuestionIndices(), [0, 1], "改选昆仑后京城分支收起");
  assert.equal(model.compileAnswers().length, 1, "隐藏题目的作答不计入答卷");

  // 选项隐藏后其既有选中态不再计入作答与答卷
  const gate = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({
      formTitle: "选项联动",
      questions: [
        { id: "gate", title: "门", options: [{ label: "开" }, { label: "关" }] },
        {
          id: "inner",
          title: "内",
          options: [{ label: "甲" }, { label: "乙", showIf: { questionId: "gate", option: "关" } }],
        },
      ],
    }),
  );
  gate.toggleOption(0, 1);
  gate.toggleOption(1, 1);
  assert.equal(gate.getSelectedIndex(1), 1);
  gate.toggleOption(0, 0);
  assert.equal(gate.getSelectedIndex(1), undefined, "选项隐藏后选中态不参与判定");
  assert.equal(gate.compileAnswers().length, 1, "隐藏选项所属题目没有可见作答时不产出条目");

  // answered 条件
  const answered = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({
      formTitle: "作答存在性",
      questions: [
        { id: "q1", title: "一", options: [{ label: "甲" }] },
        { id: "q2", title: "二", showIf: { questionId: "q1", answered: true }, options: [{ label: "乙" }] },
        { id: "q3", title: "三", showIf: { questionId: "q1", answered: false }, options: [{ label: "丙" }] },
      ],
    }),
  );
  assert.deepEqual(answered.getVisibleQuestionIndices(), [0, 2]);
  answered.setQuestionNote(0, "补充");
  assert.deepEqual(answered.getVisibleQuestionIndices(), [0, 1]);

  // 非法引用在构建期即抛出，由入口层转换为结构化错误结果
  assert.throws(
    () =>
      new AskAuthorFormModel(
        sanitizeAskAuthorArgs({
          formTitle: "非法选项",
          questions: [
            { id: "a", title: "A", options: [{ label: "x" }] },
            { id: "b", title: "B", showIf: { questionId: "a", option: "不存在" }, options: [{ label: "y" }] },
          ],
        }),
      ),
    (err) => err instanceof AdaptiveConditionError,
    "引用不存在的选项应抛出 AdaptiveConditionError",
  );
  assert.throws(
    () =>
      new AskAuthorFormModel(
        sanitizeAskAuthorArgs({
          formTitle: "后置引用",
          questions: [
            { id: "a", title: "A", showIf: { questionId: "b" }, options: [{ label: "x" }] },
            { id: "b", title: "B", options: [{ label: "y" }] },
          ],
        }),
      ),
    (err) => err instanceof AdaptiveConditionError,
    "引用后置题目应抛出 AdaptiveConditionError",
  );
}

// 7. 工具注册元数据、错误结果与调用卡片摘要验证
{
  let registeredToolDef;
  const mockPi = {
    registerTool(def) {
      registeredToolDef = def;
    },
    registerCommand() {},
  };
  const { askAuthorExtension } = await import("../dist/index.js");
  askAuthorExtension(mockPi);

  assert.equal(registeredToolDef.exposure, "model-only", "交互式工具应只由模型直接发起");
  assert.equal(registeredToolDef.annotations.readOnlyHint, true, "工具应标注只读");
  assert.equal(registeredToolDef.annotations.openWorldHint, false, "工具不应标注开放世界");
  assert.equal(registeredToolDef.executionMode, "sequential", "交互式工具应串行执行");
  assert.equal(MAX_OPTIONS, 30, "单题选项上限应由公共常量导出");
  assert.equal(MAX_QUESTIONS, 20, "问卷题目上限应由公共常量导出");

  const errorResult = await registeredToolDef.execute(
    "call-error",
    { formTitle: "错误路径" },
    undefined,
    undefined,
    { mode: "json" },
  );
  assert.equal(errorResult.isError, true, "非交互模式应作为工具错误结果返回");
  assert.ok(errorResult.content[0].text.startsWith("[Author Consultation Error]"), "错误封套前缀应保持稳定");

  const cancelledResult = await registeredToolDef.execute(
    "call-cancel",
    { formTitle: "取消路径" },
    { aborted: true },
    undefined,
    { mode: "tui" },
  );
  assert.equal(cancelledResult.isError, undefined, "取消不是工具错误");
  assert.ok(cancelledResult.content[0].text.startsWith("[Author Decision Cancelled]"), "取消封套前缀应保持稳定");

  const dummyTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
  };
  const overflowQuestions = MAX_QUESTIONS + 5;
  const streamArgs = {
    formTitle: "\u001b[31m流式摘要\u001b[0m",
    questions: Array.from({ length: overflowQuestions }, (_, index) => ({
      title: `题目 ${index + 1}`,
      options: [{ label: "甲" }, { label: "乙" }],
    })),
  };
  const state = {};
  const streaming = registeredToolDef.renderCall(streamArgs, dummyTheme, {
    state,
    lastComponent: undefined,
    argsComplete: false,
  });
  const streamingText = streaming.render(200).join("\n");
  assert.ok(!streamingText.includes("\u001b"), "调用卡片应剥离终端控制序列");
  assert.ok(streamingText.includes("流式摘要"), "调用卡片应保留清洗后的标题");
  assert.ok(
    streamingText.includes(TEXTS.card.callQuestionAndOptionCount(MAX_QUESTIONS, MAX_QUESTIONS * 2)),
    "流式渲染同样按清洗与截断后的数量计数",
  );

  const complete = registeredToolDef.renderCall(streamArgs, dummyTheme, {
    state,
    lastComponent: streaming,
    argsComplete: true,
  });
  assert.ok(
    complete.render(200).join("\n").includes(TEXTS.card.callQuestionAndOptionCount(MAX_QUESTIONS, MAX_QUESTIONS * 2)),
    "参数补全后的摘要应命中同一清洗路径",
  );

  const errorCard = registeredToolDef.renderResult(errorResult, { expanded: false }, dummyTheme, {
    state,
    lastComponent: undefined,
    argsComplete: true,
  });
  assert.ok(errorCard.render(120).join("\n").includes(TEXTS.card.resultErrorShort), "错误详情应渲染为错误结果卡片");
}

// 8. 视图渲染冒烟验证
{
  let registeredToolDef;
  const { askAuthorExtension } = await import("../dist/index.js");
  askAuthorExtension({
    registerTool(def) {
      registeredToolDef = def;
    },
    registerCommand() {},
  });

  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();

  const dummyTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
  };
  const fakeTui = { terminal: { rows: 40 }, requestRender() {} };
  const widths = [120, 40];
  const assertWidths = (component, stage) => {
    for (const width of widths) {
      const lines = component.render(width);
      assert.ok(lines.length > 0, `${stage} 在 ${width} 列应输出内容`);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `${stage} 在 ${width} 列存在超宽行：${JSON.stringify(line)}`,
        );
      }
    }
  };

  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) => {
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        assertWidths(component, "题目页");
        assert.ok(
          component.render(120).join("\n").includes("选择接下来的方向"),
          "题目页应显示题干",
        );

        component.handleInput("\t");
        assertWidths(component, "总览页");
        assert.ok(component.render(120).join("\n").includes(TEXTS.summary.title), "总览页应显示标题");

        component.handleInput("h");
        component.handleInput("n");
        assertWidths(component, "编辑器页");
        assert.ok(
          component.render(120).join("\n").includes("选择接下来的方向"),
          "编辑器页应显示题目上下文",
        );

        component.dispose();
        return { formTitle: "渲染冒烟", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const result = await registeredToolDef.execute(
    "call-render",
    {
      formTitle: "渲染冒烟",
      question: "选择接下来的方向",
      options: [{ label: "甲" }, { label: "乙" }],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.cancelled, true, "取消结果应原样返回");
}

console.log("全部功能自检顺利通过。");
