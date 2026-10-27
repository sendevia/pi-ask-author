import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  AdaptiveConditionError,
  AskAuthorFormModel,
  TEXTS,
  askAuthorExtension,
  buildExpansionUserMessage,
  sanitizeAskAuthorArgs,
} from "../dist/index.js";

// 组合式自检：题目按组自由拼装，单选 / 多选 / 条件 / 推演四类属性逐题声明。
// 新增用例只需往 cases 追加一项：在 run 里用 form / answer / expand / payloadOf 组装场景并断言，需要走真实组件时用 drive。
// 运行单个用例：node test/compose.test.mjs 推演配置

/**
 * 组装表单模型（questions 直接按 ask_author 入参书写，未给出 expansion 时开启表单级推演）
 * @param spec - `{ questions, expansion?, description? }`
 * @returns 归一化后的表单模型
 */
function form({ questions, expansion = { maxQuestions: 8 }, description }) {
  return new AskAuthorFormModel(sanitizeAskAuthorArgs({ formTitle: "组合测试", description, expansion, questions }));
}

/**
 * 按题目 ID 定位索引
 * @param model - 表单模型
 * @param id - 题目 ID
 * @returns 0-based 题目索引；题目不存在时立即断言失败
 */
function indexOf(model, id) {
  const index = model.questions.findIndex((question) => question.id === id);
  assert.ok(index >= 0, `题目 ${id} 不存在，现有题目：${model.questions.map((question) => question.id).join(", ")}`);
  return index;
}

/**
 * 按选项标签作答（可附带题目批注与选项批注）
 * @param model - 表单模型
 * @param id - 题目 ID
 * @param spec - `{ pick?, note?, optionNotes? }`；`pick` 中的标签逐个切换勾选
 */
function answer(model, id, { pick = [], note, optionNotes = {} } = {}) {
  const index = indexOf(model, id);
  const question = model.questions[index];
  for (const label of pick) {
    const optionIndex = question.options.findIndex((option) => option.label === label);
    assert.ok(optionIndex >= 0, `题目 ${id} 没有选项 ${label}`);
    model.toggleOption(index, optionIndex);
  }
  if (note !== undefined) model.setQuestionNote(index, note);
  for (const [label, text] of Object.entries(optionNotes)) {
    const optionIndex = question.options.findIndex((option) => option.label === label);
    assert.ok(optionIndex >= 0, `题目 ${id} 没有选项 ${label}`);
    model.setOptionNote(index, optionIndex, text);
  }
}

/**
 * 构建推演请求载荷（与组件层发起请求时使用的协议一致，插入位置与方向取触发题目的生效配置）
 * @param model - 表单模型
 * @param triggerId - 触发推演的题目 ID
 * @param guidance - 覆盖请求的方向指示（可选；缺省取题目配置）
 * @returns 解析后的请求载荷对象
 */
function payloadOf(model, triggerId, guidance) {
  const triggerIndex = indexOf(model, triggerId);
  const config = model.expansionConfigFor(triggerIndex);
  const message = buildExpansionUserMessage({
    model,
    questionIndex: triggerIndex,
    insert: config?.insertLabel ?? "right after the question the author just confirmed",
    guidance: guidance ?? config?.guidance,
    maxAdditionalQuestions: 3,
  });
  return JSON.parse(message.slice(message.indexOf("\n") + 1));
}

/**
 * 读取请求载荷中的单题进度快照
 * @param model - 表单模型
 * @param id - 被查看的题目 ID
 * @param triggerId - 触发推演的题目 ID（缺省为第一题）
 * @returns 该题的进度快照
 */
function snapshot(model, id, triggerId = model.questions[0].id) {
  const entry = payloadOf(model, triggerId).questions.find((question) => question.id === id);
  assert.ok(entry, `载荷中没有题目 ${id}`);
  return entry;
}

/**
 * 按题目自身的推演配置写入一次推演结果
 * @param model - 表单模型
 * @param id - 触发推演的题目 ID
 * @param questions - 生成的新题目（可为空）
 * @param optionAdditions - 向既有题目追加的选项（可为空）
 * @returns 推演追加记录
 */
function expand(model, id, questions = [], optionAdditions = []) {
  const index = indexOf(model, id);
  const config = model.expansionConfigFor(index);
  assert.ok(config, `题目 ${id} 未开启推演`);
  const signature = model.answerSignature(index);
  assert.ok(signature !== undefined, `题目 ${id} 尚无作答，无法推演`);
  return model.pushExpansion({
    questionIndex: index,
    signature,
    insert: config.insert,
    payload: { questions, optionAdditions },
  });
}

/** 纯文本主题：只去掉着色并保留全部文本，排版与文案仍走真实组件与文案字典 */
const plainTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

let registeredTool;
askAuthorExtension({
  registerTool(def) {
    registeredTool = def;
  },
  registerCommand() {},
});
initTheme();

/**
 * 驱动真实 TUI 组件：按轮次发送按键并收集每轮渲染结果与推演请求载荷
 * @param body - ask_author 工具入参
 * @param spec - `{ turns, replies? }`；`turns` 每项是一轮按键数组，`replies` 是推演模型的回复队列
 * @returns `{ renders, requests }`：每轮渲染文本与按顺序收集的请求载荷
 */
async function drive(body, { turns, replies = [] }) {
  const pendingReplies = [...replies];
  const renders = [];
  const requests = [];
  const ctx = {
    mode: "tui",
    model: { id: "compose-model" },
    modelRegistry: {
      async complete(_model, request) {
        const text = request.messages[0].content[0].text;
        requests.push(JSON.parse(text.slice(text.indexOf("\n") + 1)));
        const reply = pendingReplies.shift() ?? '{"questions":[],"options":[]}';
        return { stopReason: "endTurn", content: [{ type: "text", text: reply }] };
      },
    },
    ui: {
      async custom(factory) {
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, plainTheme, {}, () => {});
        for (const keys of turns) {
          for (const key of keys) component.handleInput(key);
          await new Promise((resolve) => setTimeout(resolve, 0));
          renders.push(component.render(120).join("\n"));
        }
        component.dispose();
        return { formTitle: body.formTitle, questions: [], answers: [], cancelled: true };
      },
    },
  };
  await registeredTool.execute("call-compose", body, undefined, undefined, ctx);
  return { renders, requests };
}

/**
 * 断言渲染文本包含 / 不包含指定片段
 * @param text - 渲染文本
 * @param spec - `{ shows?, hides? }`
 */
function expectRender(text, { shows = [], hides = [] } = {}) {
  for (const fragment of shows) assert.ok(text.includes(fragment), `渲染应包含 ${fragment}`);
  for (const fragment of hides) assert.ok(!text.includes(fragment), `渲染不应包含 ${fragment}`);
}

// ===== 用例 =====

const mixedForm = () =>
  form({
    description: "整体背景",
    questions: [
      { id: "q1", title: "单选", options: [{ label: "甲", description: "甲带来的后果" }, { label: "乙" }] },
      {
        id: "q2",
        title: "多选",
        multiSelect: true,
        minSelect: 2,
        maxSelect: 2,
        showIf: { questionId: "q1", option: "甲" },
        options: [{ label: "丙" }, { label: "丁" }, { label: "戊", showIf: { questionId: "q1", option: "乙" } }],
        expansion: false,
      },
      {
        id: "q3",
        title: "条件",
        allowEmpty: true,
        showIf: { questionId: "q2", option: "丁" },
        options: [{ label: "己" }],
      },
      { id: "q4", title: "推演", options: [{ label: "庚" }], expansion: { guidance: "聚焦结局", insert: "tail" } },
    ],
  });

const cases = [
  {
    name: "四类属性混合：单选 / 多选 / 条件 / 推演逐题独立",
    run() {
      const model = mixedForm();

      assert.deepEqual(model.getVisibleQuestionIndices(), [0, 3], "未作答时应只有无条件的题目可见");
      assert.equal(snapshot(model, "q2").status, "hidden");
      assert.equal(snapshot(model, "q3").status, "hidden");

      answer(model, "q1", { pick: ["甲"] });
      assert.deepEqual(model.getVisibleQuestionIndices(), [0, 1, 3], "满足选项条件后题目应出现");
      answer(model, "q1", { pick: ["乙"] });
      assert.deepEqual(model.getSelectedIndices(indexOf(model, "q1")), [1], "单选应替换既有勾选");
      assert.deepEqual(model.getVisibleQuestionIndices(), [0, 3], "条件失效后题目应隐藏");

      answer(model, "q1", { pick: ["甲"] });
      answer(model, "q2", { pick: ["丙"] });
      assert.equal(model.isQuestionVisible(indexOf(model, "q3")), false, "条件选项未勾选时题目应隐藏");
      assert.equal(model.isQuestionAnswered(indexOf(model, "q2")), false);
      assert.equal(model.toggleOption(indexOf(model, "q2"), 1), "selected");
      assert.equal(model.toggleOption(indexOf(model, "q2"), 2), "limit", "多选应受本题上限约束");
      assert.equal(model.isQuestionVisible(indexOf(model, "q3")), true, "勾选条件选项后题目应出现");

      answer(model, "q2", { optionNotes: { 戊: "隐藏选项上的批注" } });
      const q2 = snapshot(model, "q2");
      assert.deepEqual(q2.selected, ["丙", "丁"]);
      assert.equal(q2.maxSelect, 2);
      assert.equal(q2.options[2].visible, false, "隐藏选项不应计入可见选项");
      assert.equal(q2.options[2].selected, false);
      assert.equal(q2.options[2].note, "隐藏选项上的批注", "选项批注应随进度发送");
      assert.equal(q2.expansion.enabled, false, "多选题目应独立关闭推演");

      const q1 = payloadOf(model, "q1");
      assert.equal(q1.formDescription, "整体背景", "请求应携带问卷级背景");
      assert.equal(q1.questions[0].options[0].description, "甲带来的后果", "选项属性应随进度发送");
      assert.equal(q1.questions[0].options[0].selected, true);
      assert.equal(q1.questions[0].expansion.enabled, true);
      assert.equal(q1.questions[2].status, "skipped", "允许空答且无作答痕迹的题目应标记为跳过");
      assert.deepEqual(q1.questions[2].selected, []);

      const q4 = snapshot(model, "q4");
      assert.equal(q4.expansion.guidance, "聚焦结局");
      assert.equal(q4.expansion.insert, "at the end of the form", "题目级插入位置应发送给模型");
      assert.equal(model.canExpandOnConfirm(indexOf(model, "q2"), true), false, "关闭推演的题目不应标记");
    },
  },
  {
    name: "推演配置矩阵：关闭 / 队尾 / 跟随 / 独立方向",
    run() {
      const model = form({
        questions: [
          { id: "q1", title: "静态", options: [{ label: "甲" }], expansion: false },
          { id: "q2", title: "队尾", options: [{ label: "乙" }], expansion: { guidance: "追问动机", insert: "tail" } },
          { id: "q3", title: "跟随", options: [{ label: "丙" }] },
        ],
      });
      answer(model, "q1", { pick: ["甲"] });
      answer(model, "q2", { pick: ["乙"] });
      answer(model, "q3", { pick: ["丙"] });

      assert.equal(model.expansionConfigFor(indexOf(model, "q1")), undefined);
      assert.throws(() => expand(model, "q1"), /未开启推演/);

      assert.deepEqual(model.expansionConfigFor(indexOf(model, "q2")), {
        insert: "tail",
        insertLabel: "at the end of the form",
        guidance: "追问动机",
      });
      expand(model, "q2", [{ id: "g1", title: "队尾生成", options: [{ label: "丁" }], expansion: false }]);
      assert.deepEqual(
        model.questions.map((question) => question.id),
        ["q1", "q2", "q3", "g1"],
        "队尾插入不受触发题目位置影响",
      );

      expand(model, "q3", [
        { id: "g2", title: "跟随生成", options: [{ label: "戊" }], expansion: { guidance: "自定", insert: "follow" } },
      ]);
      assert.deepEqual(
        model.questions.map((question) => question.id),
        ["q1", "q2", "q3", "g2", "g1"],
        "跟随时插在触发题目之后",
      );
      assert.equal(model.getQuestion(indexOf(model, "g1")).expandOnConfirm, false);
      assert.equal(model.getQuestion(indexOf(model, "g2")).expansionGuidance, "自定");

      const request = payloadOf(model, "q2");
      assert.equal(request.guidance, "追问动机");
      assert.equal(request.insert, "at the end of the form", "题目级插入位置应随请求发送");
      assert.deepEqual(request.trigger, { index: 2, id: "q2", title: "队尾" });
      assert.equal(
        request.questions.find((question) => question.id === "q2").expansion.addedQuestions,
        1,
        "请求应回传本题已追加的题目数",
      );
      assert.equal(request.questions.find((question) => question.id === "q1").expansion.enabled, false);

      assert.throws(
        () => form({ questions: [{ id: "a", title: "A", options: [{ label: "1" }], expansion: { insert: "nope" } }] }),
        /unknown question id/,
        "题目级未知锚点应在构建期报错",
      );
    },
  },
  {
    name: "推演生成题目自带条件与推演开关；条件非法时整批丢弃",
    run() {
      const model = form({
        questions: [
          { id: "q1", title: "触发", options: [{ label: "甲" }, { label: "乙" }] },
          { id: "q2", title: "后备", options: [{ label: "丙" }], showIf: { questionId: "q1", option: "乙" } },
        ],
      });
      answer(model, "q1", { pick: ["甲"] });
      assert.equal(model.isQuestionVisible(indexOf(model, "q2")), false);

      expand(model, "q1", [
        { id: "g1", title: "生成条件题", options: [{ label: "丁" }], showIf: { questionId: "q1", option: "甲" } },
        { id: "g2", title: "生成静态题", options: [{ label: "戊" }], expansion: false },
      ]);
      assert.deepEqual(
        model.getVisibleQuestionIndices().map((index) => model.questions[index].id),
        ["q1", "g1", "g2"],
        "生成题目的条件与开关应生效",
      );
      assert.equal(model.getQuestion(indexOf(model, "g1")).showIf[0].questionIndex, 0);
      assert.equal(model.canExpandOnConfirm(indexOf(model, "g2"), true), false, "生成题目自带的推演开关应独立生效");

      const before = model.questions.map((question) => question.id);
      const selections = model.getSelectedIndices(indexOf(model, "q1"));
      assert.throws(
        () =>
          expand(model, "q1", [
            { id: "bad", title: "坏条件", options: [{ label: "己" }], showIf: { questionId: "q2", option: "丙" } },
          ]),
        AdaptiveConditionError,
      );
      assert.deepEqual(
        model.questions.map((question) => question.id),
        before,
        "条件非法的生成题目应整批丢弃",
      );
      assert.deepEqual(model.getSelectedIndices(indexOf(model, "q1")), selections, "失败不应改动作者已填作答");

      // 深层条件的既有索引在失败的追加后必须保持原位
      answer(model, "g1", { pick: ["丁"] });
      expand(model, "g1", [
        { id: "h1", title: "深层条件", options: [{ label: "辛" }], showIf: { questionId: "g1", option: "丁" } },
      ]);
      assert.deepEqual(
        model.questions.map((question) => question.id),
        ["q1", "g1", "h1", "g2", "q2"],
        "跟随时插在触发题目之后",
      );
      const ownerIndex = indexOf(model, "g1");
      assert.equal(model.getQuestion(indexOf(model, "h1")).showIf[0].questionIndex, ownerIndex);
      assert.throws(
        () =>
          expand(model, "q1", [
            { id: "bad2", title: "远期条件", options: [{ label: "壬" }], showIf: { questionId: "q2", option: "丙" } },
          ]),
        AdaptiveConditionError,
      );
      assert.equal(
        model.getQuestion(indexOf(model, "h1")).showIf[0].questionIndex,
        ownerIndex,
        "失败尝试不得移动既有题目的条件索引",
      );
    },
  },
  {
    name: "组件路径：混合表单的逐题标记与逐题推演开关",
    async run() {
      const body = {
        formTitle: "组合场景",
        expansion: { maxQuestions: 6, guidance: "表单级方向" },
        questions: [
          {
            id: "q1",
            title: "单向选择",
            tabLabel: "单选页",
            options: [{ label: "甲" }, { label: "乙" }],
            expansion: false,
          },
          {
            id: "q2",
            title: "双向收敛",
            tabLabel: "多选页",
            multiSelect: true,
            minSelect: 2,
            options: [{ label: "丙" }, { label: "丁" }, { label: "戊" }],
            showIf: { questionId: "q1", option: "甲" },
            expansion: { guidance: "多选专属方向" },
          },
          {
            id: "q3",
            title: "条件追问",
            tabLabel: "条件页",
            options: [{ label: "己" }],
            showIf: { questionId: "q2", answered: true },
          },
        ],
      };
      const { renders, requests } = await drive(body, {
        turns: [[], [" "], ["\r"], [" ", "j", " "], ["\r"], [" ", "\r"]],
      });

      expectRender(renders[0], {
        shows: [TEXTS.view.modeSingle, "单选页"],
        hides: [TEXTS.view.expansionBadge, "多选页", "条件页"],
      });
      expectRender(renders[2], {
        shows: [TEXTS.view.modeMulti(2, 3, 3, false), TEXTS.view.conditionalBadge, TEXTS.view.expansionBadge, "多选页"],
      });
      expectRender(renders[3], { shows: [TEXTS.view.modeMulti(2, 3, 3, false), TEXTS.view.expansionBadge] });

      expectRender(renders[5], { shows: [TEXTS.summary.title], hides: [TEXTS.view.expansionPendingHint] });
      assert.equal(requests.length, 2, "两次确认各应发起一次推演，关闭推演的第一题不应发起请求");
      assert.deepEqual(requests[0].trigger, { index: 2, id: "q2", title: "双向收敛" });
      assert.equal(requests[0].guidance, "多选专属方向", "题目级方向指示应优先于表单级设置");
      assert.deepEqual(
        requests[0].questions.map((question) => [question.id, question.status, question.expansion.enabled]),
        [
          ["q1", "answered", false],
          ["q2", "answered", true],
          ["q3", "unanswered", true],
        ],
      );
      assert.deepEqual(requests[0].questions[1].selected, ["丙", "丁"]);

      assert.deepEqual(requests[1].trigger, { index: 3, id: "q3", title: "条件追问" });
      assert.equal(requests[1].guidance, "表单级方向", "未声明方向指示的题目应沿用表单级设置");
      assert.deepEqual(
        requests[1].questions.map((question) => [question.id, question.selected]),
        [
          ["q1", ["甲"]],
          ["q2", ["丙", "丁"]],
          ["q3", ["己"]],
        ],
        "第二次请求应携带完整表单进度",
      );
    },
  },
];

let passed = 0;
const filter = process.argv[2];
const selectedCases = filter ? cases.filter((testCase) => testCase.name.includes(filter)) : cases;
assert.ok(selectedCases.length > 0, `没有匹配 ${filter} 的用例`);
for (const testCase of selectedCases) {
  await testCase.run();
  passed++;
  console.log(`通过：${testCase.name}`);
}
console.log(`组合式自检全部通过（${passed} 个用例）。`);
