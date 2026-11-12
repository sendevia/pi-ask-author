import assert from "node:assert/strict";
import enUS from "../lang/en_US.json" with { type: "json" };
import jaJP from "../lang/ja_JP.json" with { type: "json" };
import koKR from "../lang/ko_KR.json" with { type: "json" };
import zhCN from "../lang/zh_CN.json" with { type: "json" };
import {
  ACTIVE_LOCALE,
  AdaptiveConditionError,
  AskAuthorFormModel,
  ICONS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  TEXTS,
  askAuthorExtension,
  cleanOptional,
  detectLocale,
  normalizeImeKey,
  padToVisibleWidth,
  parseExpansionReply,
  safeLine,
  sanitizeAskAuthorArgs,
  sanitizeExpansionPayload,
} from "../dist/index.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

// 交互组件共享装载：注册工具与初始化主题只执行一次，各用例只构造自己的上下文
let registeredToolDef;
askAuthorExtension({
  registerTool(def) {
    registeredToolDef = def;
  },
  registerCommand() {},
});
initTheme();

/** 纯文本主题：去掉着色并保留全部文本 */
const dummyTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};
/** 固定终端尺寸的渲染宿主 */
const fakeTui = { terminal: { rows: 40 }, requestRender() {} };

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

  // 输入法全角字符收敛：`【`/`】` 与全角 ASCII 区映射为半角，转义序列与粘贴文本原样保留
  const imeCases = [
    ["【", "["],
    ["】", "]"],
    ["［", "["],
    ["］", "]"],
    ["１", "1"],
    ["ｈ", "h"],
    ["Ｎ", "N"],
    ["\u3000", " "],
    ["\[", "["],
    ["h", "h"],
    ["\x1b[5~", "\x1b[5~"],
    ["\x1b[A", "\x1b[A"],
    ["【】", "【】"],
  ];
  for (const [input, expected] of imeCases) {
    assert.equal(
      normalizeImeKey(input),
      expected,
      `normalizeImeKey 应把 ${JSON.stringify(input)} 收敛为 ${JSON.stringify(expected)}`,
    );
  }
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
  const result = {
    content: [{ type: "text", text: "ok" }],
    details: {
      formTitle: "测试",
      questions: [],
      answers: [{ questionId: "1", questionTitle: "测试题", multiSelect: false, customText: "备注" }],
      cancelled: false,
    },
  };

  const collapsedText = registeredToolDef
    .renderResult(result, { expanded: false }, dummyTheme, {})
    .render(80)
    .join("\n");
  assert.ok(collapsedText.includes(TEXTS.card.resultCompleted), "折叠态应包含完成状态");
  assert.ok(!collapsedText.includes("展开查看明细"), "折叠态不应包含显式展开快捷键提示");

  const expandedText = registeredToolDef.renderResult(result, { expanded: true }, dummyTheme, {}).render(80).join("\n");
  assert.ok(expandedText.includes("测试题"), "展开态应展示题目详细作答明细");
}

// 5. 语言探测与文案装载验证
{
  assert.equal(detectLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh_CN", "LC_ALL 应优先于 LANG");
  assert.equal(detectLocale({ LANG: "en_GB.UTF-8" }), "en_US", "应回退到同族语言 en_US");
  assert.equal(detectLocale({ LANGUAGE: "zh_TW:en_GB" }), "zh_CN", "LANGUAGE 冒号列表应按顺序探测并回退同族语言");
  assert.equal(detectLocale({ LANG: "ja_JP.UTF-8" }), "ja_JP", "应正确匹配已注册的 ja_JP 语言");
  assert.equal(detectLocale({ LANG: "ko_KR.UTF-8" }), "ko_KR", "应正确匹配已注册的 ko_KR 语言");
  assert.equal(detectLocale({ LANG: "de_DE.UTF-8" }), "en_US", "无同族语言时应回退规范语言");
  assert.equal(detectLocale({ LANG: "C" }, "en-US"), "en_US", "C locale 应跳过并采用系统语言");
  assert.equal(detectLocale({}, "zh-Hans-CN"), "zh_CN", "系统语言应作为最后一位候选");
  assert.ok(["en_US", "ja_JP", "ko_KR", "zh_CN"].includes(ACTIVE_LOCALE), "当前界面语言应为已注册语言");
  assert.ok(TEXTS.tabs.questionTab(2).includes("2"), "语言模板应按形参插值");
  assert.throws(() => TEXTS.tabs.questionTab(), /形参数量不匹配/, "语言模板形参不足时应立即抛出");
  assert.ok(TEXTS.view.notePreviewClipped.length > 0, "补充预览区提示文案应完整装载");

  const assertStructureEqual = (canonical, target, path = "") => {
    if (typeof canonical === "string") {
      assert.equal(typeof target, "string", `${path} 应为字符串类型`);
      return;
    }
    if (Array.isArray(canonical)) {
      assert.ok(Array.isArray(target), `${path} 应为数组类型`);
      assert.equal(target.length, canonical.length, `${path} 数组长度应一致`);
      return;
    }
    if (typeof canonical === "object" && canonical !== null) {
      assert.ok(typeof target === "object" && target !== null, `${path} 应为对象类型`);
      if ("template" in canonical) {
        assert.ok("template" in target, `${path} 应包含 template 字段`);
        if ("params" in canonical) {
          assert.deepEqual(target.params, canonical.params, `${path} 的 params 应与规范语言一致`);
        }
        return;
      }
      const canonicalKeys = Object.keys(canonical).sort();
      const targetKeys = Object.keys(target).sort();
      assert.deepEqual(targetKeys, canonicalKeys, `${path} 的键集合应与规范语言完全一致`);
      for (const key of canonicalKeys) {
        assertStructureEqual(canonical[key], target[key], path ? `${path}.${key}` : key);
      }
    }
  };

  assertStructureEqual(enUS, jaJP, "ja_JP");
  assertStructureEqual(enUS, koKR, "ko_KR");
  assertStructureEqual(enUS, zhCN, "zh_CN");
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

  const branchOptions = model.getMenuItems(2);
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
  assert.equal(registeredToolDef.exposure, "model-only", "交互式工具应只由模型直接发起");
  assert.equal(registeredToolDef.annotations.readOnlyHint, true, "工具应标注只读");
  assert.equal(registeredToolDef.annotations.openWorldHint, false, "工具不应标注开放世界");
  assert.equal(registeredToolDef.executionMode, "sequential", "交互式工具应串行执行");
  assert.equal(MAX_OPTIONS, 30, "单题选项上限应由公共常量导出");
  assert.equal(MAX_QUESTIONS, 20, "问卷题目上限应由公共常量导出");

  const errorResult = await registeredToolDef.execute("call-error", { formTitle: "错误路径" }, undefined, undefined, {
    mode: "json",
  });
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
    complete
      .render(200)
      .join("\n")
      .includes(TEXTS.card.callQuestionAndOptionCount(MAX_QUESTIONS, MAX_QUESTIONS * 2)),
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
  const widths = [120, 40, 20];
  const assertWidths = (component, stage) => {
    for (const width of widths) {
      const lines = component.render(width);
      assert.ok(lines.length > 0, `${stage} 在 ${width} 列应输出内容`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${stage} 在 ${width} 列存在超宽行：${JSON.stringify(line)}`);
      }
    }
    assert.equal(component.render(120).length, fakeTui.terminal.rows, `${stage} 应占满终端全高`);
  };

  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory, options) => {
        assert.equal(options?.overlay, true, "作答界面应挂载为整屏覆盖层以接管滚轮");
        assert.deepEqual(
          options?.overlayOptions,
          { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
          "覆盖层应铺满整个终端",
        );
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        assertWidths(component, "题目页");
        assert.ok(component.render(120).join("\n").includes("选择接下来的方向"), "题目页应显示题干");

        component.handleInput("\t");
        assertWidths(component, "总览页");
        assert.ok(
          component.render(120).join("\n").includes(TEXTS.summary.submitButton),
          "总览页应显示确认提交按钮",
        );

        component.handleInput("h");
        component.handleInput("n");
        assertWidths(component, "编辑器页");
        assert.ok(component.render(120).join("\n").includes("选择接下来的方向"), "编辑器页应显示题目上下文");

        component.dispose();
        return { formTitle: "渲染冒烟", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const result = await registeredToolDef.execute(
    "call-render",
    { formTitle: "渲染冒烟", question: "选择接下来的方向", options: [{ label: "甲" }, { label: "乙" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.cancelled, true, "取消结果应原样返回");
}

// 9. 题目 Tab 短标签验证
{
  const longLabel = "非常长的自定义标签用于验证截断行为";
  const sanitized = sanitizeAskAuthorArgs({
    formTitle: "标签验证",
    questions: [
      { title: "第一章采用哪种叙事视角？", tabLabel: "视点", options: [{ label: "甲" }, { label: "乙" }] },
      { title: "第二章的节奏", options: [{ label: "丙" }, { label: "丁" }] },
      { title: "第三章的氛围", tabLabel: longLabel, options: [{ label: "戊" }, { label: "己" }] },
    ],
  });
  const model = new AskAuthorFormModel(sanitized);
  assert.equal(model.getQuestion(0)?.tabLabel, "视点", "Tab 短标签应经清洗进入模型");
  assert.equal(model.getQuestion(1)?.tabLabel, undefined, "未声明短标签的题目应保持 undefined");

  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) => {
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        const text = component.render(120).join("\n");
        assert.ok(text.includes("视点"), "Tab 栏应显示题目自定义短标签");
        assert.ok(!text.includes(TEXTS.tabs.questionTab(1)), "声明短标签后不应再显示默认题号");
        assert.ok(text.includes(TEXTS.tabs.questionTab(2)), "未声明短标签的题目应保留默认题号");
        assert.ok(!text.includes(longLabel), "超宽短标签应被截断");
        assert.ok(text.includes("第一章采用哪种叙事视角？"), "题头仍应显示完整标题");
        component.dispose();
        return { formTitle: "标签验证", questions: [], answers: [], cancelled: true };
      },
    },
  };

  await registeredToolDef.execute("call-tab-label", sanitized, undefined, undefined, ctx);
}

// 10. 实时推演：追加、签名、撤回与上限
{
  const sanitized = sanitizeAskAuthorArgs({
    formTitle: "推演验证",
    description: "作者只见到第一题",
    expansion: { maxQuestions: 2, guidance: "追问人物动机" },
    question: "主角如何应对谈判？",
    options: [{ label: "反击" }, { label: "谈判" }],
  });
  assert.equal(sanitized.expansion?.maxQuestions, 2, "推演配置应经清洗进入入参");
  assert.equal(sanitized.expansion?.guidance, "追问人物动机");

  const model = new AskAuthorFormModel(sanitized);
  assert.equal(model.questionCount, 1);
  assert.equal(model.answerSignature(0), undefined, "未作答时没有答案签名");

  model.toggleOption(0, 1);
  assert.equal(model.answerSignature(0), "谈判", "答案签名应为选中项标签");
  assert.equal(model.getSelectedIndex(0), 1);

  const record = model.pushExpansion({
    questionIndex: 0,
    signature: "谈判",
    payload: {
      questions: [
        { id: "q_next", title: "谈判筹码是什么？", options: [{ label: "人质" }, { label: "情报" }] },
        { id: "q_last", title: "这是第三题", options: [{ label: "甲" }] },
      ],
      optionAdditions: [{ questionId: model.questions[0].id, options: [{ label: "假意谈判" }] }],
    },
  });
  assert.equal(record.addedQuestions, 1, "题数上限为 2 时只应追加一题");
  assert.deepEqual(record.addedOptions, [{ questionIndex: 0, count: 1 }], "选项追加记录应指向触发题目");
  assert.equal(model.questionCount, 2);
  assert.equal(model.getQuestion(0)?.options.length, 3, "追加选项应进入既有题目");
  assert.equal(model.getQuestion(0)?.maxSelect, 3, "追加选项后上限应随选项总数扩展");
  assert.equal(model.getQuestion(1)?.id, "q_next");
  assert.equal(model.getExpansions().length, 1);

  // 撤回：追加的题目与选项一并消失，作者在该题上的作答同时剪除
  model.toggleOption(0, 2);
  assert.deepEqual(model.getSelectedIndices(0), [2], "新追加的选项可被勾选");
  const revisionBefore = model.revision;
  assert.equal(model.retractFrom(0), 1, "应撤回一条推演记录");
  assert.ok(model.revision > revisionBefore, "撤回应推进 revision");
  assert.equal(model.questionCount, 1, "追加的题目应被移除");
  assert.equal(model.getQuestion(0)?.options.length, 2, "追加的选项应被移除");
  assert.deepEqual(model.getSelectedIndices(0), [], "被移除选项上的勾选应一并剪除");
  assert.equal(model.getExpansions().length, 0);

  // 空载荷同样入栈：同一答案不会重复推演
  const empty = model.pushExpansion({
    questionIndex: 0,
    signature: "谈判",
    payload: { questions: [], optionAdditions: [] },
  });
  assert.equal(empty.addedQuestions, 0);
  assert.deepEqual(empty.addedOptions, []);
  assert.equal(model.getExpansions().length, 1);

  // 后续题目的推演记录会随起始题目改动一并撤回
  model.pushExpansion({ questionIndex: 1, signature: "人质", payload: { questions: [], optionAdditions: [] } });
  assert.equal(model.getExpansions().length, 2);
  assert.equal(model.retractFrom(0), 2, "起始题目改动应级联撤回后续推演");
  assert.equal(model.getExpansions().length, 0);
}

// 11. 推演载荷过滤与回复解析
{
  const known = { questionIds: ["q1"], optionLabels: new Map([["q1", ["反击", "谈判"]]]) };
  const payload = sanitizeExpansionPayload(
    {
      questions: [
        { id: "q1", title: "复用既有 ID", options: [{ label: "甲" }] },
        { id: "q2", title: "有效新题目", options: [{ label: "乙" }, { label: "乙" }] },
        { id: "q3", title: "没有选项的题目", options: [] },
      ],
      options: [
        { questionId: "q1", options: [{ label: "谈判" }, { label: "假意谈判" }] },
        { questionId: "missing", options: [{ label: "无效目标" }] },
      ],
    },
    known,
  );
  assert.equal(payload.questions.length, 2, "无选项的生成题目应被丢弃");
  assert.equal(payload.questions[0].id, undefined, "与既有题目冲突的 ID 应被清除");
  assert.equal(payload.questions[1].options.length, 1, "重复标签应在同一批次内去重");
  assert.equal(payload.optionAdditions.length, 1, "只保留指向既有题目的选项追加");
  assert.equal(payload.optionAdditions[0].questionId, "q1");
  assert.deepEqual(
    payload.optionAdditions[0].options.map((option) => option.label),
    ["假意谈判"],
    "与既有标签重复的追加选项应被丢弃",
  );

  const reply = parseExpansionReply(
    '```json\n{"questions":[{"id":"q9","title":"后续","options":[{"label":"甲"}]}],"options":[]}\n```',
    known,
  );
  assert.equal(reply.questions.length, 1);
  assert.equal(reply.questions[0].id, "q9");
  assert.throws(() => parseExpansionReply("没有 JSON", known), /JSON/, "非 JSON 回复应立即抛出");
}

// 12. 推演标记的判定条件
{
  const model = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({
      formTitle: "标记验证",
      expansion: { maxQuestions: 3 },
      question: "选择方向",
      options: [{ label: "甲" }, { label: "乙" }],
    }),
  );
  assert.equal(model.canExpandOnConfirm(0, false), false, "未开启推演时不应标记");
  assert.equal(model.canExpandOnConfirm(0, true), true, "开启推演且未作答时应标记");

  model.toggleOption(0, 0);
  assert.equal(model.canExpandOnConfirm(0, true), true, "答案变化前仍可标记");

  model.pushExpansion({
    questionIndex: 0,
    signature: "甲",
    payload: { questions: [{ title: "后续题目", options: [{ label: "丙" }] }], optionAdditions: [] },
  });
  assert.equal(model.canExpandOnConfirm(0, true), false, "同一答案已推演过时不再标记");

  model.toggleOption(0, 1);
  assert.equal(model.canExpandOnConfirm(0, true), true, "答案改变后应重新标记");

  model.pushExpansion({
    questionIndex: 0,
    signature: "乙",
    payload: { questions: [{ title: "再追加一题", options: [{ label: "丁" }] }], optionAdditions: [] },
  });
  assert.equal(model.questionCount, 3, "两次推演后应达到题数上限");
  model.toggleOption(0, 0);
  assert.equal(model.canExpandOnConfirm(0, true), false, "题数达上限后不再标记");
}

// 13. Tab 标签上的推演标记验证
{
  const renderOnce = async (args) => {
    let text = "";
    const ctx = {
      mode: "tui",
      model: { id: "stub-model" },
      sessionManager: { getSessionId: () => "badge-session" },
      modelRegistry: {
        complete() {
          throw new Error("渲染验证不应发起推演请求");
        },
      },
      ui: {
        custom: async (factory) => {
          const component = factory(fakeTui, dummyTheme, {}, () => {});
          text = component.render(120).join("\n");
          component.dispose();
          return { formTitle: "标记渲染", questions: [], answers: [], cancelled: true };
        },
      },
    };
    await registeredToolDef.execute("call-badge", args, undefined, undefined, ctx);
    return text;
  };

  const body = { formTitle: "标记渲染", question: "选择方向", options: [{ label: "甲" }, { label: "乙" }] };
  const withExpansion = await renderOnce({ ...body, expansion: { maxQuestions: 3 } });
  assert.ok(withExpansion.includes(TEXTS.tabs.expansionBadge), "开启推演时 Tab 标签应带推演标记");

  const withoutExpansion = await renderOnce(body);
  assert.ok(!withoutExpansion.includes(TEXTS.tabs.expansionBadge), "未开启推演时不应显示推演标记");

  // 题目类型短标记随 Tab 出现在同一行
  const singleTabRow = withExpansion.split("\n").find((line) => line.includes(TEXTS.tabs.typeSingle));
  assert.ok(singleTabRow !== undefined, "Tab 标签应带单选标记");
  assert.ok(singleTabRow.includes(TEXTS.tabs.expansionBadge), "类型标记与推演标记应在同一行 Tab 内");
}

// 14. 推演题目插队与索引平移
{
  const model = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({
      formTitle: "插队验证",
      expansion: { maxQuestions: 8 },
      questions: [
        { id: "q1", title: "第一题", options: [{ label: "甲" }, { label: "乙" }] },
        {
          id: "q2",
          title: "第二题",
          options: [{ label: "丙" }, { label: "丁" }],
          showIf: { questionId: "q1", option: "甲" },
        },
        { id: "q3", title: "第三题", options: [{ label: "戊" }] },
      ],
    }),
  );
  model.toggleOption(1, 1);
  model.toggleOption(2, 0);
  model.toggleOption(0, 0);

  const record = model.pushExpansion({
    questionIndex: 0,
    signature: "甲",
    payload: {
      questions: [
        { id: "g1", title: "推演一", options: [{ label: "己" }] },
        { id: "g2", title: "推演二", options: [{ label: "庚" }], showIf: { questionId: "g1", option: "己" } },
      ],
      optionAdditions: [],
    },
  });
  assert.equal(record.insertAt, 1, "插队位置应为触发题目的下一题");
  assert.equal(record.addedQuestions, 2);
  assert.deepEqual(
    model.questions.map((q) => q.id),
    ["q1", "g1", "g2", "q2", "q3"],
    "推演题目应插在触发题目之后，既有题目整体后移",
  );
  assert.deepEqual(model.getSelectedIndices(3), [1], "移位后的题目应保留原作答状态");
  assert.deepEqual(model.getSelectedIndices(4), [0], "末题作答状态同样应随索引平移");
  assert.equal(model.getQuestion(3)?.showIf[0]?.questionIndex, 0, "既有题目的显示条件应仍然指向原题目");
  assert.equal(model.getQuestion(2)?.showIf[0]?.questionIndex, 1, "推演题目的条件应指向同批插入的前一题");

  // 在平移后的题目上再次推演：记录索引指向新位置，撤回按栈顶逆序回收
  const second = model.pushExpansion({
    questionIndex: 3,
    signature: "丁",
    payload: { questions: [{ id: "h1", title: "后续追问", options: [{ label: "辛" }] }], optionAdditions: [] },
  });
  assert.equal(second.insertAt, 4);
  assert.deepEqual(
    model.questions.map((q) => q.id),
    ["q1", "g1", "g2", "q2", "h1", "q3"],
    "第二次推演应插在它自己的触发题目之后",
  );
  assert.deepEqual(model.getSelectedIndices(5), [0], "第二次插入后末题状态同样平移正确");
  assert.equal(model.retractFrom(3), 1, "撤回该题推演不应影响更早的插入块");
  assert.deepEqual(
    model.questions.map((q) => q.id),
    ["q1", "g1", "g2", "q2", "q3"],
  );
  assert.deepEqual(model.getSelectedIndices(4), [0], "撤回第二次插入后末题索引应复位");

  const envelope = model.formatAnswers(model.compileAnswers());
  const order = ["第一题", "第二题", "第三题"].map((title) => envelope.indexOf(`[${title}]`));
  assert.ok(
    order.every((position) => position >= 0),
    "封套应包含已作答的全部题目",
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "封套条目应按插队后的题目顺序输出",
  );

  assert.equal(model.retractFrom(0), 1, "插入的记录应可撤回");
  assert.deepEqual(
    model.questions.map((q) => q.id),
    ["q1", "q2", "q3"],
    "撤回后应恢复原题目序列",
  );
}

// 15. 推演插入位置预设（跟随 / 队尾 / 自定义）
{
  const build = (insert) =>
    new AskAuthorFormModel(
      sanitizeAskAuthorArgs({
        formTitle: "插入位置",
        expansion: insert === undefined ? { maxQuestions: 8 } : { maxQuestions: 8, insert },
        questions: [
          { id: "q1", title: "第一题", options: [{ label: "甲" }] },
          { id: "q2", title: "第二题", options: [{ label: "乙" }] },
          { id: "q3", title: "第三题", options: [{ label: "丙" }] },
        ],
      }),
    );
  const payload = (id) => ({
    questions: [{ id, title: `生成${id}`, options: [{ label: "丁" }] }],
    optionAdditions: [],
  });

  const follow = build(undefined);
  assert.equal(follow.expansionInsert, "follow", "缺省插入位置为跟随");
  follow.pushExpansion({ questionIndex: 1, signature: "乙", payload: payload("f1") });
  assert.deepEqual(
    follow.questions.map((q) => q.id),
    ["q1", "q2", "f1", "q3"],
    "跟随时插在触发题目之后",
  );

  const tail = build("tail");
  tail.pushExpansion({ questionIndex: 0, signature: "甲", payload: payload("t1") });
  assert.deepEqual(
    tail.questions.map((q) => q.id),
    ["q1", "q2", "q3", "t1"],
    "队尾时排在全部题目之后",
  );

  const custom = build({ after: "q1" });
  custom.pushExpansion({ questionIndex: 2, signature: "丙", payload: payload("c1") });
  assert.deepEqual(
    custom.questions.map((q) => q.id),
    ["q1", "c1", "q2", "q3"],
    "自定义锚点时插到锚点题目之后",
  );
  custom.pushExpansion({ questionIndex: 2, signature: "丙2", payload: payload("c2") });
  assert.deepEqual(
    custom.questions.map((q) => q.id),
    ["q1", "c2", "c1", "q2", "q3"],
    "同一锚点的后续推演直接排在锚点之后",
  );
  assert.equal(custom.retractFrom(2), 2, "两条记录应可逐条撤回");
  assert.deepEqual(
    custom.questions.map((q) => q.id),
    ["q1", "q2", "q3"],
  );
  assert.equal(custom.canExpandOnConfirm(1, true), true, "自定义锚点不影响推演标记的判定");

  assert.throws(() => build({ after: "nope" }), AdaptiveConditionError, "未知锚点应在构建期报错");

  const flatArgs = { formTitle: "x", question: "q", options: [{ label: "a" }] };
  const asPreset = sanitizeAskAuthorArgs({ ...flatArgs, expansion: { insert: "tail" } });
  assert.equal(asPreset.expansion?.insert, "tail");
  const asId = sanitizeAskAuthorArgs({ ...flatArgs, expansion: { insert: "q7" } });
  assert.deepEqual(asId.expansion?.insert, { after: "q7" }, "字符串锚点应收敛为 after 形式");
  const asObject = sanitizeAskAuthorArgs({ ...flatArgs, expansion: { insert: { after: "q1" } } });
  assert.deepEqual(asObject.expansion?.insert, { after: "q1" });
}

// 16. 推演在途期间把当前页换成占位页并暂停作答输入
{
  let settle;
  const expansionReply = new Promise((resolve) => {
    settle = resolve;
  });

  let pendingRender;
  let frozenRender;
  let readyRender;
  let resumedRender;
  const ctx = {
    mode: "tui",
    model: { id: "stub-model" },
    sessionManager: { getSessionId: () => "placeholder-session", buildSessionProjection: () => ({ messages: [] }) },
    getSystemPrompt: () => "stub system prompt",
    modelRegistry: {
      async complete() {
        const text = await expansionReply;
        return { stopReason: "endTurn", content: [{ type: "text", text }] };
      },
    },
    ui: {
      async custom(factory) {
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        // 空格勾选首项，Enter 确认并前移：此刻推演请求已在途，作者停在第二题
        component.handleInput(" ");
        component.handleInput("\r");
        pendingRender = component.render(120).join("\n");
        assert.equal(pendingRender.split("\n").length, fakeTui.terminal.rows, "推演占位页应占满终端全高");
        // 在途期间一切作答输入被忽略：渲染结果与占位页完全一致
        component.handleInput("\t");
        component.handleInput("1");
        component.handleInput("j");
        frozenRender = component.render(120).join("\n");

        settle('```json\n{"questions":[{"id":"g1","title":"推演题","options":[{"label":"戊"}]}],"options":[]}\n```');
        await new Promise((resolve) => setTimeout(resolve, 0));
        readyRender = component.render(120).join("\n");
        // 推演就绪后切换恢复
        component.handleInput("\t");
        resumedRender = component.render(120).join("\n");
        return { formTitle: "占位符", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const body = {
    formTitle: "占位符",
    expansion: { maxQuestions: 6 },
    questions: [
      { id: "q1", title: "第一题", options: [{ label: "甲" }, { label: "乙" }] },
      { id: "q2", title: "第二题", options: [{ label: "丙" }, { label: "丁" }] },
    ],
  };
  await registeredToolDef.execute("call-placeholder", body, undefined, undefined, ctx);

  assert.ok(pendingRender.includes(TEXTS.tabs.expansionPlaceholder), "推演在途时激活页的 Tab 标题应换成占位文案");
  assert.ok(pendingRender.includes(TEXTS.status.expansionRunning), "推演在途时占位页应展示运行提示");
  assert.ok(pendingRender.includes(TEXTS.view.expansionPendingHint), "推演在途时占位页应展示暂停说明");
  assert.ok(!pendingRender.includes("第二题"), "推演在途时作答页内容应被占位页替换");
  assert.equal(frozenRender, pendingRender, "推演在途期间作答与切换输入应被忽略");
  assert.ok(!readyRender.includes(TEXTS.tabs.expansionPlaceholder), "推演就绪后 Tab 占位文案应恢复");
  assert.ok(!readyRender.includes(TEXTS.view.expansionPendingHint), "推演就绪后占位页应消失");
  assert.ok(readyRender.includes("推演题"), "推演就绪后生成题目应可见");
  assert.notEqual(resumedRender, readyRender, "推演就绪后题目切换应恢复");
}

// 17. 逐题确认后自动进入总览页，Enter 提交并把答卷编译进封套
{
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const component = factory(fakeTui, dummyTheme, {}, settle);
        // 每题「空格选定 + Enter 确认」，确认最后一题后自动落入总览页
        for (const key of [" ", "\r", " ", "\r"]) component.handleInput(key);
        assert.ok(
          component.render(120).join("\n").includes(TEXTS.summary.submitButton),
          "确认最后一题后应自动进入总览页",
        );
        component.handleInput("\r");
        const result = await done;
        component.dispose();
        return result;
      },
    },
  };

  const result = await registeredToolDef.execute(
    "call-submit",
    {
      formTitle: "提交验证",
      questions: [
        { id: "q1", title: "开场镜头", options: [{ label: "雨夜" }, { label: "清晨" }] },
        { id: "q2", title: "叙事人称", options: [{ label: "第一人称" }, { label: "第三人称" }] },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, undefined, "提交结果不应标记为错误");
  assert.equal(result.details.cancelled, false, "提交结果不应标记为取消");
  assert.equal(result.details.answers.length, 2, "答卷应包含两道已确认题目");
  const envelope = result.content[0].text;
  assert.ok(envelope.startsWith(TEXTS.markdown.envelopePrefix), "提交结果应以完成封套开头");
  assert.ok(envelope.includes("【雨夜】") && envelope.includes("【第一人称】"), "封套应携带各题选定项");
}

// 18. 推演请求接入会话上下文：会话投影 + 主对话系统提示词 + 在途工具调用占位
{
  const calls = [];
  const mainSystemPrompt = "You are pi, a coding agent working in this repository.";
  const ctx = {
    mode: "tui",
    model: { id: "opencode-go/stub" },
    sessionManager: {
      getSessionId: () => "session-abc123",
      buildSessionProjection: () => ({
        messages: [
          { role: "user", content: [{ type: "text", text: "把雨夜追车那场改成第一人称" }], timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "先确认叙述人称。" },
              { type: "toolCall", id: "call-session-header", name: "ask_author", arguments: {} },
            ],
            timestamp: 2,
          },
        ],
      }),
    },
    getSystemPrompt: () => mainSystemPrompt,
    modelRegistry: {
      async complete(model, request, options) {
        calls.push({ model, request, options });
        return { stopReason: "endTurn", content: [{ type: "text", text: '{"questions":[],"options":[]}' }] };
      },
    },
    ui: {
      async custom(factory) {
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        component.handleInput(" ");
        component.handleInput("\r");
        component.dispose();
        return { formTitle: "会话标识", questions: [], answers: [], cancelled: true };
      },
    },
  };

  await registeredToolDef.execute(
    "call-session-header",
    {
      formTitle: "会话标识",
      expansion: { maxQuestions: 4 },
      questions: [
        { id: "q1", title: "第一题", options: [{ label: "甲" }, { label: "乙" }] },
        { id: "q2", title: "第二题", options: [{ label: "丙" }, { label: "丁" }] },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(calls.length, 1, "确认一道题目应发起一次推演请求");
  assert.equal(calls[0].options?.sessionId, "session-abc123", "推演请求应携带当前会话标识");
  assert.ok(calls[0].options?.signal instanceof AbortSignal, "推演请求应携带级联取消信号");

  assert.equal(
    calls[0].request.systemPrompt,
    `${mainSystemPrompt}\n\n${TEXTS.expansion.systemPrompt}`,
    "推演系统提示词应由主对话系统提示词与推演协议拼接而成",
  );
  const messages = calls[0].request.messages;
  assert.equal(messages.length, 4, "请求应为会话历史、在途调用占位与推演用户消息");
  assert.equal(messages[0].role, "user", "会话历史首条应来自会话投影");
  assert.ok(messages[0].content[0].text.includes("雨夜追车"), "会话历史应保留作者原话");
  assert.equal(messages[1].role, "assistant", "会话历史应保留助手消息");
  assert.equal(messages[2].role, "toolResult", "在途工具调用应补上占位结果");
  assert.equal(messages[2].toolCallId, "call-session-header", "占位结果应挂在本次调用上");
  assert.equal(messages[2].isError, false, "在途调用不是失败");
  assert.equal(messages[2].content[0].text, TEXTS.expansion.pendingToolResult, "占位结果应说明作者正在作答");
  assert.equal(messages[3].role, "user", "推演载荷应作为最后一条用户消息");
  assert.ok(messages[3].content[0].text.startsWith(TEXTS.expansion.userPreamble), "推演载荷应带协议前缀");
  assert.ok(messages[3].content[0].text.includes('"formTitle":"会话标识"'), "推演载荷应携带表单真实状态");
}

// 19. 鼠标滚轮由本工具接管：预览区滚预览、其余位置移光标、总览页滚答卷
{
  const ROWS = 30;
  const WIDTH = 100;
  const wheel = (y, wheelDelta) => ({
    type: "wheel",
    button: "none",
    x: 10,
    y,
    screenX: 10,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  });
  const longPreview = Array.from(
    { length: 10 },
    (_, i) => `第${i + 1}段：“退无可退，那便无须再退。”林澈反手拔剑，古朴剑脊上泛起暗金光芒。`,
  ).join("\n\n");

  let frames = {};
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");
        frames.page = render();
        const tabRow = frames.page.findIndex((l) => l.includes(TEXTS.tabs.questionTab(1)));
        const cursorRow = frames.page.findIndex((l) => l.includes(ICONS.cursor));
        const contentRow = frames.page.findIndex((l) => l.includes("第1段"));
        assert.ok(tabRow >= 0 && contentRow > tabRow, "内容区应在题目标题区之后");

        // 非滚轮事件不接管
        assert.equal(component.handleMouse({ ...wheel(0, 3), type: "press" }), undefined, "非滚轮事件不应处理");

        // 内容区滚轮：预览内容滚动，选项光标不动
        assert.deepEqual(component.handleMouse(wheel(contentRow, 5)), { handled: true }, "滚轮应标记为已消费");
        frames.scrolled = render();
        assert.notEqual(frames.scrolled[contentRow], frames.page[contentRow], "内容区滚轮应滚动预览内容");
        assert.equal(
          frames.scrolled.findIndex((l) => l.includes(ICONS.cursor)),
          cursorRow,
          "内容区滚轮不应移动选项光标",
        );

        // 作答区滚轮：光标下移，预览位移重置
        assert.deepEqual(component.handleMouse(wheel(cursorRow, 1)), { handled: true }, "作答区滚轮应被接管");
        frames.moved = render();
        assert.ok(frames.moved.findIndex((l) => l.includes(ICONS.cursor)) > cursorRow, "作答区滚轮应下移选项光标");

        // 切到下一题后滚轮仍被接管
        component.handleInput("\t");
        frames.next = render();
        const nextCursorRow = frames.next.findIndex((l) => l.includes(ICONS.cursor));
        assert.deepEqual(component.handleMouse(wheel(nextCursorRow, 1)), { handled: true }, "切题后滚轮应被接管");
        frames.nextMoved = render();
        assert.ok(
          frames.nextMoved.findIndex((l) => l.includes(ICONS.cursor)) > nextCursorRow,
          "切题后滚轮应下移选项光标",
        );

        component.dispose();
        return { formTitle: "滚轮", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const wheelRun = await registeredToolDef.execute(
    "call-wheel",
    {
      formTitle: "滚轮",
      questions: [
        {
          id: "q1",
          title: "滚轮第一题",
          options: [
            { label: "甲", preview: longPreview },
            { label: "乙", preview: longPreview },
          ],
        },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `q${i + 2}`,
          title: `滚轮第${i + 2}题`,
          description: "用于把总览内容撑到一页之外。",
          options: [{ label: `选项${i + 1}` }, { label: `选项${i + 1}b` }],
        })),
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!wheelRun.isError, `滚轮流程不应报错：${wheelRun.content[0]?.text ?? ""}`);

  assert.equal(frames.page.length, ROWS, "整屏覆盖层下作答页应恰好占满终端行数");
  assert.ok(frames.next.length > 0 && frames.nextMoved.length > 0, "切题后应可渲染");
}

// 20. 鼠标点击：Tab 标签切题、选项行移动并激活、总览页全高与带序
{
  const ROWS = 24;
  const WIDTH = 84;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y) => ({
    press: component.handleMouse(pointer("press", x, y)),
    click: component.handleMouse(pointer("click", x, y)),
  });

  const frames = {};
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));

        frames.question = render();
        const tabRow = frames.question.findIndex((l) => plain(l).includes(TEXTS.tabs.submitTab));
        assert.equal(tabRow, 0, "Tab 栏应位于整页首行的题目标题区");
        const titleRow = frames.question.findIndex((l) => plain(l).includes("第一章采用哪种叙事视角？"));
        assert.ok(titleRow > tabRow, "题名应在 Tab 栏之下");
        const firstOptionRow = frames.question.findIndex((l) => plain(l).includes("第一人称"));
        assert.ok(firstOptionRow > titleRow, "选项应在题目标题区之下的作答区");
        assert.ok(plain(frames.question[tabRow]).startsWith(ICONS.unchecked), "Tab 栏应贴整页左缘");
        assert.ok(
          plain(frames.question[tabRow]).includes(TEXTS.tabs.typeSingle),
          "Tab 标签应带题目类型短标记",
        );
        assert.ok(
          plain(frames.question[titleRow]).startsWith("第一章采用哪种叙事视角？"),
          "题名行应贴整页左缘",
        );
        const tabCol = plain(frames.question[tabRow]).indexOf("节奏");
        assert.ok(tabCol > 0, "自定义短标签应落在 Tab 栏内");

        const tabClick = click(component, tabCol, tabRow);
        assert.deepEqual(tabClick.press, { handled: true }, "标签按下应被接管");
        assert.deepEqual(tabClick.click, { handled: true }, "标签松开应被接管");
        frames.afterTabClick = render();
        assert.ok(text(frames.afterTabClick).includes("第二题"), "点击标签应切换到对应题目");

        component.handleInput("h");
        frames.back = render();
        const optionRow = frames.back.findIndex((l) => plain(l).includes("第三人称"));
        const optionClick = click(component, 8, optionRow);
        assert.deepEqual(optionClick.press, { handled: true }, "选项按下应被接管");
        assert.deepEqual(optionClick.click, { handled: true }, "选项松开应被接管");
        frames.afterOptionClick = render();
        assert.ok(text(frames.afterOptionClick).includes("第一章采用哪种叙事视角？"), "点击选项不应跳题");
        assert.notEqual(text(frames.afterOptionClick), text(frames.back), "点击选项应改变勾选与光标");

        // 非条目区域的按下不被接管，留给 pi 做文本选择
        assert.equal(
          component.handleMouse(pointer("press", 2, frames.afterOptionClick.length - 1)),
          undefined,
          "空白处按下不接管",
        );

        // 总览页：全高，Tab 栏在上、答卷正文在其下的内容区，未完成时补一行提示
        component.handleInput("\t");
        component.handleInput("\t");
        frames.summary = render();
        assert.equal(frames.summary.length, ROWS, `总览页应占满终端 ${ROWS} 行`);
        const summaryTabRow = frames.summary.findIndex((l) => plain(l).includes(TEXTS.tabs.submitTab));
        const warningRow = frames.summary.findIndex((l) => plain(l).includes(TEXTS.summary.pendingWarning));
        const answerRow = frames.summary.findIndex((l) =>
          plain(l).includes(TEXTS.summary.questionPrefix(1, "第一章采用哪种叙事视角？")),
        );
        assert.equal(summaryTabRow, 0, "总览页 Tab 栏应位于整页首行的题目标题区");
        assert.ok(warningRow > summaryTabRow, "未完成提示应在 Tab 栏之下");
        assert.ok(plain(frames.summary[warningRow]).startsWith(TEXTS.summary.pendingWarning), "未完成提示应贴整页左缘");
        assert.ok(answerRow > warningRow, "答卷总览正文应在标题区之下的内容区");

        // 总览页点击题目标签切回题目
        const backCol = plain(frames.summary[summaryTabRow]).indexOf("视角");
        assert.deepEqual(click(component, backCol, summaryTabRow).click, { handled: true }, "总览页标签点击应被接管");
        frames.backToQuestion = render();
        assert.ok(text(frames.backToQuestion).includes("第一章采用哪种叙事视角？"), "总览页点击标签应切回该题");

        component.dispose();
        return { formTitle: "点击", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const clickRun = await registeredToolDef.execute(
    "call-click",
    {
      formTitle: "点击",
      questions: [
        {
          id: "q1",
          tabLabel: "视角",
          title: "第一章采用哪种叙事视角？",
          options: [
            { label: "第一人称", preview: "我在雨里站了很久。" },
            { label: "第三人称", preview: "他在雨里站了很久。" },
          ],
        },
        { id: "q2", tabLabel: "节奏", title: "第二题", options: [{ label: "快" }, { label: "慢" }] },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!clickRun.isError, `点击流程不应报错：${clickRun.content[0]?.text ?? ""}`);
}

// 21. 编辑页整页占满且编辑框内点击可定位光标
{
  const ROWS = 22;
  const WIDTH = 80;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const clickAt = (component, x, y) =>
    component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width: WIDTH,
      height: ROWS,
      shift: false,
      alt: false,
      ctrl: false,
    });

  const frames = {};
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");

        component.handleInput("N");
        for (const ch of "abcdef") component.handleInput(ch);
        frames.editor = render();
        assert.equal(frames.editor.length, ROWS, `编辑页应占满 ${ROWS} 行`);
        assert.ok(
          plain(frames.editor[ROWS - 1]).includes(TEXTS.editor.footerHelp),
          "编辑页末行应为提示区的按键帮助（无外层双横线）",
        );

        const textRow = frames.editor.findIndex((l) => plain(l).includes("abcdef"));
        assert.ok(textRow > 0, "编辑框文字应可见");
        const textColumn = plain(frames.editor[textRow]).indexOf("abcdef");
        assert.deepEqual(
          clickAt(component, textColumn + 2, textRow),
          { handled: true, focus: true },
          "编辑框内点击应由编辑器接管",
        );
        component.handleInput("X");
        frames.afterClick = render();
        // 编辑器的焦点光标以 `ESC _pi:fc BEL` / `ESC _pi:/fc BEL` 夹住一个字符，比对正文前先剔除这对标记
        const caretFree = frames.afterClick.join("\n").replace(/\x1b_pi:\/?fc\x07/g, "");
        assert.ok(plain(caretFree).includes("abXcdef"), "点击处应成为插入位置");
        assert.equal(clickAt(component, 2, 0), undefined, "编辑框外点击不接管");

        component.dispose();
        return { formTitle: "编辑页", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const editorClickRun = await registeredToolDef.execute(
    "call-editor-click",
    { formTitle: "编辑页", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }, { label: "乙" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!editorClickRun.isError, `编辑页流程不应报错：${editorClickRun.content[0]?.text ?? ""}`);
}

// 22. 提交页整卷补充：模型封套、总览块、键位与点击
{
  const model = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({
      formTitle: "整卷补充",
      questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }] }],
    }),
  );
  model.toggleOption(0, 0);
  assert.equal(model.formNote, undefined, "未填写时整卷补充缺省为空");
  assert.equal(model.setFormNote("  全程第一人称  "), "saved", "整卷补充应可保存");
  assert.equal(model.formNote, "全程第一人称", "整卷补充应去首尾空白保存");

  const envelope = model.formatAnswers(model.compileAnswers());
  const supplementLine = "[Author supplement: 全程第一人称]";
  const supplementIndex = envelope.indexOf(supplementLine);
  assert.ok(supplementIndex > 0, "封套应包含整卷补充行");
  assert.ok(envelope.indexOf("1. [第一题]") < supplementIndex, "整卷补充应排在作答行之后");
  assert.ok(supplementIndex < envelope.indexOf(TEXTS.markdown.envelopeSuffix), "整卷补充应排在收尾指令之前");

  // 未勾选任何选项时补充同样输出，空答卷提示让位给补充行
  const blank = new AskAuthorFormModel(
    sanitizeAskAuthorArgs({ formTitle: "空卷", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }] }] }),
  );
  assert.ok(blank.formatAnswers(blank.compileAnswers()).includes(TEXTS.markdown.envelopeEmpty), "无补充的空答卷保持空卷提示");
  blank.setFormNote("按你的默认方案写作");
  const blankEnvelope = blank.formatAnswers(blank.compileAnswers());
  assert.ok(blankEnvelope.includes("[Author supplement: 按你的默认方案写作]"), "空答卷也应携带整卷补充");
  assert.ok(!blankEnvelope.includes(TEXTS.markdown.envelopeEmpty), "有补充时不再输出空卷提示");
  assert.equal(blank.clearFormNote(), true, "整卷补充应可清空");
  assert.equal(blank.clearFormNote(), false, "空补充再次清空不应报告变更");
}
{
  const ROWS = 24;
  const WIDTH = 84;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y) => ({
    press: component.handleMouse(pointer("press", x, y)),
    click: component.handleMouse(pointer("click", x, y)),
  });

  const frames = {};
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, settle);
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));
        const rowOf = (lines, needle) => lines.findIndex((l) => plain(l).includes(needle));

        // 「空格选定 + Enter 确认」唯一一题后自动进入总览页
        for (const key of [" ", "\r"]) component.handleInput(key);
        frames.summary = render();
        const emptyNoteRow = rowOf(frames.summary, TEXTS.summary.formNoteLabel);
        assert.ok(emptyNoteRow > 0, "总览页应显示整卷补充按钮");
        assert.ok(
          plain(frames.summary[emptyNoteRow - 1]).includes("┌") && plain(frames.summary[emptyNoteRow + 1]).includes("┕"),
          "整卷补充按钮应带字符框线",
        );

        // n 打开编辑器，输入后 Enter 保存：正文进入补充区，按钮换成已填写标记
        component.handleInput("n");
        frames.editor = render();
        assert.ok(
          text(frames.editor).includes(TEXTS.titleArea.formNote) &&
            text(frames.editor).includes("整卷补充"),
          "整卷补充编辑器应在面包屑里显示问卷标题与面板名",
        );
        for (const ch of "全程第一人称") component.handleInput(ch);
        component.handleInput("\r");
        frames.saved = render();
        const savedNoteRow = rowOf(frames.saved, TEXTS.summary.formNoteLabelFilled);
        assert.ok(savedNoteRow > 0, "保存后整卷补充按钮应标记已填写");
        const savedPreviewRow = rowOf(frames.saved, "全程第一人称");
        assert.ok(savedPreviewRow > 0, "保存后补充区应显示整卷补充正文");
        assert.ok(savedPreviewRow < savedNoteRow, "补充区在按钮组之上");
        assert.ok(plain(frames.saved[savedPreviewRow - 1]).includes("─"), "正文与补充区之间有分隔线");

        // 点击补充按钮也能打开编辑器（按钮组靠右，点击列按当前帧现算）
        const savedNoteX = visibleWidth(plain(frames.saved[savedNoteRow]).slice(0, plain(frames.saved[savedNoteRow]).indexOf("整卷补充"))) + 2;
        assert.deepEqual(
          click(component, savedNoteX, savedNoteRow),
          { press: { handled: true }, click: { handled: true } },
          "补充按钮点击应被接管",
        );
        frames.clicked = render();
        assert.ok(
          text(frames.clicked).includes(TEXTS.titleArea.formNote),
          "点击补充按钮应打开整卷补充编辑器",
        );
        for (const key of ["\x1b", "\x1b"]) component.handleInput(key);
        frames.back = render();
        assert.ok(text(frames.back).includes(TEXTS.summary.submitButton), "放弃修改后回到总览页");

        // x 清空后再写一条，Enter 提交后封套与结果详情都应携带补充
        component.handleInput("x");
        const cleared = render();
        assert.ok(!text(cleared).includes("全程第一人称"), "x 应清空补充区正文");
        assert.ok(rowOf(cleared, TEXTS.summary.formNoteLabel) > 0, "清空后按钮回到入口文案");
        component.handleInput("n");
        for (const ch of "保持伏笔") component.handleInput(ch);
        component.handleInput("\r");
        frames.final = render();
        assert.ok(rowOf(frames.final, TEXTS.summary.formNoteLabelFilled) > 0, "第二条整卷补充应已保存");
        const finalPreviewRow = rowOf(frames.final, "保持伏笔");
        assert.ok(finalPreviewRow > 0, "补充区应显示第二条正文");

        component.handleInput("\r");
        const result = await done;
        component.dispose();
        frames.result = result;
        return result;
      },
    },
  };

  const result = await registeredToolDef.execute(
    "call-form-note",
    { formTitle: "整卷补充", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }] }] },
    undefined,
    undefined,
    ctx,
  );

  assert.ok(result.content[0].text.includes("[Author supplement: 保持伏笔]"), "提交封套应携带整卷补充行");
  assert.equal(result.details.supplement, "保持伏笔", "结果详情应携带整卷补充原文");
}

// 23. 选项下方动作按钮组：选项补充 / 题目补充 / 确认靠右成组，换行后仍靠右，点击打开对应编辑器
{
  const ROWS = 28;
  const WIDTH = 100;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y, width = WIDTH) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y, width = WIDTH) => ({
    press: component.handleMouse(pointer("press", x, y, width)),
    click: component.handleMouse(pointer("click", x, y, width)),
  });
  const columnOf = (line, needle) => visibleWidth(line.slice(0, line.indexOf(needle)));

  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));
        const back = () => {
          component.handleInput("\x1b");
          component.handleInput("\x1b");
        };

        // 聚焦首个选项按 n 写选项专属补充，按 N 写题目整体补充
        component.handleInput("n");
        for (const ch of "第一人称更好") component.handleInput(ch);
        component.handleInput("\r");
        component.handleInput("N");
        for (const ch of "全篇统一视角") component.handleInput(ch);
        component.handleInput("\r");
        const frame = render();
        assert.equal(frame.length, ROWS, `含招式区的作答页应占满终端 ${ROWS} 行`);

        const optionRow = frame.findIndex((l) => plain(l).includes(TEXTS.menu.optionNoteLabelFilled));
        const questionRow = frame.findIndex((l) => plain(l).includes(TEXTS.menu.customNoteLabelFilled));
        const confirmRow = frame.findIndex((l) => plain(l).includes(TEXTS.menu.confirmLabel("甲", true)));
        assert.ok(optionRow > 0 && questionRow === optionRow && confirmRow === optionRow, "三个按钮应成组同一行");

        const listRow = frame.findIndex((l) => plain(l).includes("乙"));
        assert.ok(optionRow > listRow, "按钮组应在选项列表下方");

        const groupTop = plain(frame[optionRow - 1]);
        const groupBottom = plain(frame[optionRow + 1]);
        assert.ok(groupTop.includes("┌") && groupTop.includes("┐"), "上缘应为 ┌ ─ ┐");
        assert.ok(groupBottom.includes("┕") && groupBottom.includes("━") && groupBottom.includes("┙"), "下缘应为 ┕ ━ ┙");
        assert.equal(visibleWidth(frame[optionRow + 1]), WIDTH, "按钮组应贴右缘");
        assert.ok(
          columnOf(plain(frame[optionRow]), TEXTS.menu.optionNoteLabelFilled) <
            columnOf(plain(frame[optionRow]), TEXTS.menu.confirmLabel("甲", true)),
          "选项补充与题目补充在左、确认在右",
        );

        // 点击选项补充按钮打开选项专属编辑器
        const optionX = columnOf(plain(frame[optionRow]), TEXTS.menu.optionNoteLabelFilled) + 2;
        assert.deepEqual(
          click(component, optionX, optionRow),
          { press: { handled: true }, click: { handled: true } },
          "选项补充按钮点击应被接管",
        );
        const optionEditor = render();
        assert.ok(
          text(optionEditor).includes(TEXTS.titleArea.optionNote) && text(optionEditor).includes("甲"),
          "点击选项补充应打开选项补充说明编辑器",
        );
        assert.ok(text(optionEditor).includes("第一人称更好"), "选项补充编辑器应带出既有正文");
        back();
        render();

        // 点击题目补充按钮打开题目编辑器
        const questionX = columnOf(plain(frame[optionRow]), TEXTS.menu.customNoteLabelFilled) + 2;
        assert.deepEqual(
          click(component, questionX, optionRow),
          { press: { handled: true }, click: { handled: true } },
          "题目补充按钮点击应被接管",
        );
        const questionEditor = render();
        assert.ok(
          text(questionEditor).includes(TEXTS.titleArea.questionNote) && text(questionEditor).includes("第一题"),
          "点击题目补充应打开题目补充说明编辑器",
        );
        assert.ok(text(questionEditor).includes("全篇统一视角"), "题目补充编辑器应带出既有正文");
        back();
        render();

        // 窄终端：按钮组自动换行，每一行都贴右缘
        const narrowWidth = 46;
        const narrow = component.render(narrowWidth).join("\n").split("\n");
        for (const line of narrow) assert.ok(visibleWidth(line) <= narrowWidth, `窄终端存在超宽行：${JSON.stringify(line)}`);
        const narrowConfirmRow = narrow.findIndex((l) => plain(l).includes(TEXTS.menu.confirmLabel("甲", true)));
        const narrowNoteRow = narrow.findIndex((l) => plain(l).includes(TEXTS.menu.optionNoteLabelFilled));
        assert.ok(narrowConfirmRow > narrowNoteRow, "窄终端下确认按钮应换到下一行");
        for (const row of [narrowNoteRow, narrowConfirmRow]) {
          const bottom = narrow.findIndex((l, index) => index > row && plain(l).includes("┕"));
          assert.equal(visibleWidth(narrow[bottom]), narrowWidth, "换行后的每一行按钮都贴右缘");
        }

        component.dispose();
        return { formTitle: "批注按钮", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const noteButtonsRun = await registeredToolDef.execute(
    "call-note-buttons",
    { formTitle: "批注按钮", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }, { label: "乙" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!noteButtonsRun.isError, `批注按钮流程不应报错：${noteButtonsRun.content[0]?.text ?? ""}`);
}

// 24. 题目底部操作按钮组：两端分开、点击补充说明与点击确认推进
{
  const ROWS = 24;
  const WIDTH = 72;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y) => ({
    press: component.handleMouse(pointer("press", x, y)),
    click: component.handleMouse(pointer("click", x, y)),
  });
  const columnOf = (line, needle) => visibleWidth(line.slice(0, line.indexOf(needle)));

  const noteLabel = TEXTS.menu.customNoteLabel;
  const confirmLabel = TEXTS.menu.confirmLabel(TEXTS.fallbacks.unselectedOption, false);

  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, settle);
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));

        const frame = render();
        const actionRow = frame.findIndex((l) => plain(l).includes(noteLabel));
        assert.ok(actionRow > 0, "选项列表之后应有补充说明按钮");
        assert.ok(plain(frame[actionRow]).includes(confirmLabel), "补充说明与确认按钮应同属一行");
        assert.ok(plain(frame[actionRow - 1]).includes("┌") && plain(frame[actionRow + 1]).includes("┕"), "按钮应带字符框线");
        assert.equal(visibleWidth(frame[actionRow + 1]), WIDTH, "按钮组应贴右缘");
        const optionRow = frame.findIndex((l) => plain(l).includes("第一人称"));
        assert.ok(optionRow > 0 && optionRow < actionRow - 1, "按钮组应排在选项列表之后");

        // 未作答时点确认：只提示状态栏，不切页
        const confirmX = columnOf(plain(frame[actionRow]), confirmLabel) + 2;
        assert.deepEqual(
          click(component, confirmX, actionRow),
          { press: { handled: true }, click: { handled: true } },
          "确认按钮点击应被接管",
        );
        const blocked = render();
        assert.ok(text(blocked).includes(TEXTS.status.pleaseAnswerBeforeSubmit), "未作答时点确认应提示状态栏");
        assert.ok(text(blocked).includes("第一题"), "未作答时点确认不应切页");

        // 点补充说明按钮打开题目补充说明编辑器
        const noteX = columnOf(plain(frame[actionRow]), noteLabel) + 2;
        assert.deepEqual(
          click(component, noteX, actionRow),
          { press: { handled: true }, click: { handled: true } },
          "补充说明按钮点击应被接管",
        );
        const editorFrame = render();
        assert.ok(
          text(editorFrame).includes(TEXTS.titleArea.questionNote),
          "点击补充说明按钮应打开题目补充说明编辑器",
        );
        // 编辑框为空，单个 Esc 即退出输入模式（不会连带取消整张表单）
        component.handleInput("\x1b");

        // 选定选项后点确认：单题直接进入总览页
        component.handleInput(" ");
        const answered = render();
        const answeredLabel = TEXTS.menu.confirmLabel("第一人称", false);
        // 状态提示行让内容区变矮，作答区随之整体上移，按钮行以当前帧重算
        const answeredRow = answered.findIndex((l) => plain(l).includes(answeredLabel));
        assert.ok(answeredRow > 0, "作答后应有确认按钮行");
        const answeredConfirmX = columnOf(plain(answered[answeredRow]), answeredLabel) + 2;
        assert.deepEqual(
          click(component, answeredConfirmX, answeredRow),
          { press: { handled: true }, click: { handled: true } },
          "已作答时确认按钮点击应被接管",
        );
        assert.ok(text(render()).includes(TEXTS.summary.submitButton), "确认后应进入总览页");

        component.handleInput("\r");
        const result = await done;
        assert.equal(result.answers.length, 1, "确认后应携带本题作答");
        component.dispose();
        return result;
      },
    },
  };

  const actionButtonsRun = await registeredToolDef.execute(
    "call-action-buttons",
    { formTitle: "操作按钮", questions: [{ id: "q1", title: "第一题", options: [{ label: "第一人称" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!actionButtonsRun.isError, `操作按钮流程不应报错：${actionButtonsRun.content[0]?.text ?? ""}`);
}

// 25. 总览页确认提交按钮：与整卷补充同属作答区、未完成时跳题、点下即提交
{
  const ROWS = 24;
  const WIDTH = 72;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y) => ({
    press: component.handleMouse(pointer("press", x, y)),
    click: component.handleMouse(pointer("click", x, y)),
  });
  const columnOf = (line, needle) => visibleWidth(line.slice(0, line.indexOf(needle)));

  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, settle);
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));
        const submitRowOf = (lines) => lines.findIndex((l) => plain(l).includes(TEXTS.summary.submitButton));

        // 直接切到总览页：未完成状态下按钮仍可点，点击跳到第一道未完成题目
        component.handleInput("\t");
        const pending = render();
        const pendingRow = submitRowOf(pending);
        assert.ok(pendingRow > 0, "总览页应显示确认提交按钮");
        assert.ok(plain(pending[pendingRow - 1]).includes("┌") && plain(pending[pendingRow + 1]).includes("┕"), "按钮应带字符框线");
        assert.equal(visibleWidth(pending[pendingRow + 1]), WIDTH, "确认提交按钮应贴右缘");
        const pendingX = columnOf(plain(pending[pendingRow]), TEXTS.summary.submitButton) + 2;
        assert.deepEqual(
          click(component, pendingX, pendingRow),
          { press: { handled: true }, click: { handled: true } },
          "未完成时点击确认提交应被接管",
        );
        const jumped = render();
        assert.ok(text(jumped).includes("第一题"), "未完成时点确认应跳到待答题目");
        assert.ok(text(jumped).includes(TEXTS.status.pleaseAnswerBeforeSubmit), "跳转时应在状态栏说明原因");

        // 作答后回到总览页，点按钮直接提交
        component.handleInput(" ");
        component.handleInput("\r");
        const ready = render();
        assert.ok(text(ready).includes(TEXTS.summary.submitButton), "确认一题后回到总览页");
        const readyRow = submitRowOf(ready);
        const readyX = columnOf(plain(ready[readyRow]), TEXTS.summary.submitButton) + 2;
        assert.deepEqual(
          click(component, readyX, readyRow),
          { press: { handled: true }, click: { handled: true } },
          "已完成时点击确认提交应被接管",
        );

        const result = await done;
        assert.equal(result.answers.length, 1, "点击确认提交应提交答卷");
        assert.equal(result.cancelled, false, "提交后不应标记为取消");
        component.dispose();
        return result;
      },
    },
  };

  const submitButtonRun = await registeredToolDef.execute(
    "call-submit-button",
    { formTitle: "提交按钮", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!submitButtonRun.isError, `提交按钮流程不应报错：${submitButtonRun.content[0]?.text ?? ""}`);
}

// 26. 编辑页返回按钮：面包屑在按钮右侧折行，点击返回退出编辑，有未保存内容时需二次确认
{
  const ROWS = 20;
  const WIDTH = 46;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const pointer = (type, x, y) => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: WIDTH,
    height: ROWS,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const click = (component, x, y) => ({
    press: component.handleMouse(pointer("press", x, y)),
    click: component.handleMouse(pointer("click", x, y)),
  });

  const frames = {};
  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");
        const text = (lines) => plain(lines.join("\n"));
        const rowOf = (lines, needle) => lines.findIndex((l) => plain(l).includes(needle));
        const backColumn = (lines, row) => plain(lines[row]).indexOf(TEXTS.titleArea.backButton) + 2;

        component.handleInput("N");
        frames.editor = render();
        const backRow = rowOf(frames.editor, TEXTS.titleArea.backButton);
        assert.ok(backRow > 0, "编辑页题目标题区应有返回按钮");
        assert.ok(
          plain(frames.editor[backRow]).indexOf(TEXTS.titleArea.backButton) < plain(frames.editor[backRow]).indexOf("雨夜追车"),
          "返回按钮应在面包屑左侧",
        );
        const tabRow = rowOf(frames.editor, TEXTS.tabs.submitTab);
        const titleRows = frames.editor.slice(tabRow + 1, rowOf(frames.editor, "─".repeat(10)));
        assert.ok(titleRows.length >= 3, "返回按钮与面包屑应占满三行以上标题区");
        assert.ok(
          plain(titleRows[1] ?? "").indexOf(TEXTS.titleArea.backButton) < plain(titleRows[1] ?? "").indexOf("雨夜追车"),
          "返回按钮应在面包屑左侧",
        );
        // 标题区不留左右边距：按钮框的首列就是整页首列
        assert.ok(plain(titleRows[0] ?? "").startsWith("┌"), "返回按钮应贴整页左缘");
        // 折行把同一段文字拆到多行，抹掉空白后仍应连成完整面包屑末段
        assert.ok(
          titleRows.map(plain).join("").replace(/\s+/g, "").includes("补充说明"),
          "面包屑末段应随折行显示",
        );
        const textColumn = plain(titleRows[0] ?? "").indexOf("┐") + 2;
        assert.ok(
          plain(titleRows[titleRows.length - 1] ?? "").startsWith(" ".repeat(textColumn)),
          "折行悬挂在文字起始列",
        );

        // 空编辑器：单击返回按钮直接回到作答页
        assert.deepEqual(
          click(component, backColumn(frames.editor, backRow), backRow),
          { press: { handled: true }, click: { handled: true } },
          "返回按钮点击应被接管",
        );
        frames.back = render();
        assert.ok(text(frames.back).includes(TEXTS.tabs.typeSingle), "点击返回应回到作答页");

        // 有未保存内容：首次点击只提醒，再次点击才丢弃并返回
        component.handleInput("N");
        for (const ch of "草稿") component.handleInput(ch);
        frames.dirty = render();
        const dirtyBackRow = rowOf(frames.dirty, TEXTS.titleArea.backButton);
        const dirtyBackX = backColumn(frames.dirty, dirtyBackRow);
        click(component, dirtyBackX, dirtyBackRow);
        frames.armed = render();
        assert.ok(text(frames.armed).includes("放弃修改"), "有未保存内容时返回应二次确认");
        assert.ok(text(frames.armed).includes(TEXTS.editor.footerHelp), "首次点击返回不应关闭编辑器");
        assert.deepEqual(
          click(component, dirtyBackX, dirtyBackRow),
          { press: { handled: true }, click: { handled: true } },
          "二次点击返回应被接管",
        );
        frames.discarded = render();
        assert.ok(text(frames.discarded).includes(TEXTS.tabs.typeSingle), "二次点击返回应回到作答页");
        assert.ok(!text(frames.discarded).includes("草稿"), "未保存的内容应被丢弃");

        component.dispose();
        return { formTitle: "返回按钮", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const backButtonRun = await registeredToolDef.execute(
    "call-back-button",
    {
      formTitle: "雨夜追车",
      questions: [
        {
          id: "q1",
          title: "第一章采用哪种叙事视角，并且决定林澈与沈砚的第一次正面交锋发生在雨夜还是破晓？",
          options: [{ label: "第一人称" }, { label: "第三人称" }],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!backButtonRun.isError, `返回按钮流程不应报错：${backButtonRun.content[0]?.text ?? ""}`);
}

// 27. 按钮组列宽分配：宽度够时两个按钮同行并铺满右缘，窄到无法审读才上下分行
{
  const ROWS = 24;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");
  const longNote = "全程第一人称，保持短句，克制心理描写，结尾留白";

  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const renderAt = (width) => component.render(width);
        const boxRowOf = (lines, needle) =>
          lines.findIndex((l) => plain(l).includes("│") && plain(l).includes(needle));

        // 一题作答完成后进入总览页，写入长整卷补充（正文进补充区，按钮只留入口）
        for (const key of [" ", "\r"]) component.handleInput(key);
        component.handleInput("n");
        for (const ch of longNote) component.handleInput(ch);
        component.handleInput("\r");

        // 宽终端：两个按钮同行、铺满右缘，正文完整留在补充区
        const wide = renderAt(56);
        for (const line of wide) assert.ok(visibleWidth(line) <= 56, `56 列存在超宽行：${JSON.stringify(line)}`);
        const wideNoteRow = boxRowOf(wide, TEXTS.summary.formNoteLabelFilled);
        const wideSubmitRow = boxRowOf(wide, TEXTS.summary.submitButton);
        assert.ok(wideNoteRow > 0, "宽终端应显示整卷补充按钮");
        assert.equal(wideNoteRow, wideSubmitRow, "宽度够时整卷补充与确认提交应同行");
        const wideBottom = wide.findIndex((l, index) => index > wideNoteRow && plain(l).includes("┕"));
        assert.equal(visibleWidth(wide[wideBottom]), 56, "同行两按钮应铺满整行");
        assert.ok(
          plain(wide[wideSubmitRow]).indexOf(TEXTS.summary.submitButton) >
            plain(wide[wideSubmitRow]).indexOf(TEXTS.summary.formNoteLabelFilled),
          "整卷补充在左、确认提交靠右",
        );
        assert.ok(plain(wide.join("\n")).includes("全程第一人称"), "正文应留在补充区");

        // 窄终端：装不下两个按钮就上下分行，每行仍贴右缘
        const narrow = renderAt(20);
        for (const line of narrow) assert.ok(visibleWidth(line) <= 20, `20 列存在超宽行：${JSON.stringify(line)}`);
        const narrowNoteRow = boxRowOf(narrow, TEXTS.summary.formNoteLabel);
        const narrowSubmitRow = boxRowOf(narrow, TEXTS.summary.submitButton);
        assert.ok(narrowNoteRow > 0 && narrowSubmitRow > narrowNoteRow, "窄终端两按钮应上下分行");
        for (const row of [narrowNoteRow, narrowSubmitRow]) {
          const bottom = narrow.findIndex((l, index) => index > row && plain(l).includes("┕"));
          assert.equal(visibleWidth(narrow[bottom]), 20, "换行后的每一行按钮都贴右缘");
        }

        component.dispose();
        return { formTitle: "按钮列宽", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const buttonWidthRun = await registeredToolDef.execute(
    "call-button-width",
    { formTitle: "按钮列宽", questions: [{ id: "q1", title: "第一题", options: [{ label: "甲" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!buttonWidthRun.isError, `按钮列宽流程不应报错：${buttonWidthRun.content[0]?.text ?? ""}`);
}

// 28. 内容区细分：无 ### 区块标题、内容区与作答区之间无分隔线、有补充时出现补充预览区
{
  const ROWS = 26;
  const WIDTH = 80;
  const ansi = /\x1b\[[0-9;]*m/g;
  const plain = (line) => line.replace(ansi, "");

  const ctx = {
    mode: "tui",
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: ROWS }, requestRender() {} }, dummyTheme, {}, () => {});
        const render = () => component.render(WIDTH).join("\n").split("\n");

        const before = render();
        assert.equal(before.length, ROWS, `作答页应占满终端 ${ROWS} 行`);
        assert.ok(!plain(before.join("\n")).includes("###"), "内容区不应出现 ### 区块标题");
        const firstOptionRow = before.findIndex((l) => plain(l).includes("第二人称"));
        assert.ok(firstOptionRow > 0, "作答区应有选项行");
        assert.ok(
          !plain(before[firstOptionRow - 1] ?? "").includes("─"),
          "内容区与作答区之间不应有分隔线",
        );
        assert.ok(
          !plain(before.join("\n")).includes(TEXTS.view.notePreviewOption("第一人称")),
          "无补充时不显示补充预览区",
        );

        // 分别写选项补充与题目补充
        component.handleInput("n");
        for (const ch of "更冷一些") component.handleInput(ch);
        component.handleInput("\r");
        component.handleInput("N");
        for (const ch of "全篇统一第一人称") component.handleInput(ch);
        component.handleInput("\r");

        const after = render();
        const questionNoteRow = after.findIndex((l) => plain(l).includes(TEXTS.view.notePreviewQuestion));
        const optionNoteRow = after.findIndex((l) => plain(l).includes(TEXTS.view.notePreviewOption("第一人称")));
        const secondOptionRow = after.findIndex((l) => plain(l).includes("第二人称"));
        assert.ok(questionNoteRow > 0 && optionNoteRow === questionNoteRow + 1, "补充预览区先题目后选项");
        assert.ok(questionNoteRow < secondOptionRow, "补充预览区应在选项之上");
        assert.ok(plain(after[questionNoteRow - 1] ?? "").includes("─"), "题目内容区与补充预览区之间有分隔线");
        assert.ok(plain(after[questionNoteRow]).includes("全篇统一第一人称"), "题目补充正文应可见");
        assert.ok(plain(after[optionNoteRow]).includes("更冷一些"), "选项补充正文应可见");
        assert.ok(
          !plain(after[secondOptionRow - 1] ?? "").includes("─"),
          "补充分区之后到选项之间同样没有分隔线",
        );

        // 窄终端下两块子区仍不超宽，且补充预览区被压到行数上限以内
        for (const line of component.render(40)) {
          assert.ok(visibleWidth(line) <= 40, `窄终端存在超宽行：${JSON.stringify(line)}`);
        }

        component.dispose();
        return { formTitle: "内容区细分", questions: [], answers: [], cancelled: true };
      },
    },
  };

  const contentSplitRun = await registeredToolDef.execute(
    "call-content-split",
    {
      formTitle: "内容区细分",
      questions: [
        {
          id: "q1",
          title: "第一题",
          description: "设定说明",
          options: [
            { label: "第一人称", description: "贴近内心", preview: "我在雨里站了很久。" },
            { label: "第二人称" },
          ],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!contentSplitRun.isError, `内容区分流程不应报错：${contentSplitRun.content[0]?.text ?? ""}`);
}

console.log("全部功能自检顺利通过。");
