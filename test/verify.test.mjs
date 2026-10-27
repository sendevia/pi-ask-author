import assert from "node:assert/strict";
import enUS from "../lang/en_US.json" with { type: "json" };
import jaJP from "../lang/ja_JP.json" with { type: "json" };
import koKR from "../lang/ko_KR.json" with { type: "json" };
import zhCN from "../lang/zh_CN.json" with { type: "json" };
import {
  ACTIVE_LOCALE,
  AdaptiveConditionError,
  AskAuthorFormModel,
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
  assert.ok(TEXTS.view.customNotePanelTips.length > 0, "文案列表应完整装载");

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
  const widths = [120, 40];
  const assertWidths = (component, stage) => {
    for (const width of widths) {
      const lines = component.render(width);
      assert.ok(lines.length > 0, `${stage} 在 ${width} 列应输出内容`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${stage} 在 ${width} 列存在超宽行：${JSON.stringify(line)}`);
      }
    }
  };

  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) => {
        const component = factory(fakeTui, dummyTheme, {}, () => {});
        assertWidths(component, "题目页");
        assert.ok(component.render(120).join("\n").includes("选择接下来的方向"), "题目页应显示题干");

        component.handleInput("\t");
        assertWidths(component, "总览页");
        assert.ok(component.render(120).join("\n").includes(TEXTS.summary.title), "总览页应显示标题");

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

// 13. 题头推演标记验证
{
  const renderOnce = async (args) => {
    let text = "";
    const ctx = {
      mode: "tui",
      model: { id: "stub-model" },
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
  assert.ok(withExpansion.includes(TEXTS.view.expansionBadge), "开启推演时题头应显示推演标记");

  const withoutExpansion = await renderOnce(body);
  assert.ok(!withoutExpansion.includes(TEXTS.view.expansionBadge), "未开启推演时不应显示推演标记");
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

console.log("全部功能自检顺利通过。");
