import assert from "node:assert/strict";
import {
  AskAuthorFormModel,
  cleanOptional,
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

  const dummyTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };

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
  assert.ok(collapsedText.includes("已完成"), "折叠态应包含完成状态");
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

console.log("全部功能自检顺利通过。");
