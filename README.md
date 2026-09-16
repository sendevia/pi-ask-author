# pi-ask-author

[![pi-package](https://img.shields.io/badge/pi--package-extension-blue.svg)](https://pi.dev/packages)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

专为作家、轻小说创作者与 AI 协同写作设计的 [Pi](https://github.com/earendil-works/pi-coding-agent) 终端交互式请示扩展。

通过 Markdown 正文草稿预览、剧情因果推导阐述、全维度选项批注以及确定性返回封套，将创意分歧决策与灵感确认体验提升到全新高度。

---

## 🌟 核心特性 (Key Features)

- 🖥️ **双栏响应式 TUI 交互**
  - **左栏选项决策**：直观展示单选/多选状态、完成度指示徽标（`✔`/`⏳`）、选项标签与专属批注标识。
  - **右栏实时预览**：光标移动时即时联动渲染当前选项的**剧情因果推导**与 **Markdown 正文草稿预览**。
  - **自适应视口**：终端宽度 $\ge 72$ 列自动启用双栏，窄屏环境下优雅降级为单栏内联展开与折叠。
- 📖 **小说级富文本与草稿高亮**
  - 内置紧凑轻量的终端 Markdown 解析器，完整支持粗体、斜体、删除线、行内代码、引用区块。
  - 特别优化中文小说台词（引号内对话高亮）与分段排版，让作者在终端即可沉浸式检视行文节奏与语感。
- 📝 **全维度自由批注体系 (Notes & Annotations)**
  - **题目级补充说明 (Question Note)**：对该题整体提出全局创作指令或氛围补充。
  - **选项专属补充说明 (Option Note)**：按 `Ctrl+O` 即可为特定选项追加细化批注（**未勾选的选项同样支持填写补充说明**，以便指导模型汲取未选方案中的闪光点）。
- 📋 **单题平铺与批量问卷双模式**
  - **单题平铺模式**：快速发起单点决策（如重要剧情分歧、结局走向）。
  - **多题批量问卷模式**：支持在单次弹窗内汇集多个关联决策（如脱离路线 + 战利品搜刮 + 下章基调），配有顶部 Tab 标签栏与完成度总览页（Summary Tab），作者一次性统筹确认，极大降低打扰。
- 🎯 **确定性 LLM 封套与指令蒸馏 (Deterministic Envelopes)**
  - 工具返回给 LLM 的文本采用固定的结构化 Markdown 封套（`[Author Decision Finalized]` / `[Author Decision Cancelled]` / `[Author Consultation Error]`），前缀稳定，极度契合 Prompt Cache。
  - **草稿指令提取 (Draft Directives)**：选中的选项草稿预览会自动提炼为紧凑的单行 `[Draft directive: ...]` 指令，直接供 LLM 在后续正文执笔中原样复用或参考。
  - 尾部附带强制执行声明，彻底杜绝大模型的闲聊套话，直接驱动下一步正文输出。
- ⚡ **高性能与极简依赖**
  - 严格遵守 Pi 官方扩展生态规范，核心依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 与 `typebox` 均列为 `peerDependencies`，无多余重量级三方包。
  - 100% 内存安全：生命周期严格绑定 AbortSignal，定时器与事件监听幂等清理，渲染零冗余计算。

---

## 📦 安装与加载 (Installation)

### 方式一：通过 Pi 包管理器安装（推荐）

```bash
# 从 GitHub 仓库安装
pi install git:github.com/sendevia/pi-ask-author

# 或从 npm 安装（发布后）
pi install npm:pi-ask-author
```

添加到全局或项目配置后，每次启动 `pi` 时将自动加载该扩展。

### 方式二：临时体验

```bash
pi -e git:github.com/sendevia/pi-ask-author
```

### 方式三：本地开发加载

将仓库克隆至本地后，在项目 `.pi/extensions/` 或全局 `~/.pi/agent/extensions/` 中添加引用，或在运行时通过 `-e` 引入：

```bash
pi -e ./path/to/pi-ask-author
```

---

## ⌨️ 终端快捷键指南 (Keybindings)

| 按键                   | 功能说明                                                  |
| :--------------------- | :-------------------------------------------------------- |
| `Tab` / `Shift+Tab`    | 在多个题目 Tab 与最终提交总览页之间循环切换（仅批量模式） |
| `↑` / `↓` 或 `k` / `j` | 菜单上下移动高亮选项，右侧预览区实时同步联动刷新          |
| `Space`                | 勾选 / 取消勾选（单选互斥选中，多选独立切换）             |
| `Enter`                | 在选项上可进入该选项批注编辑；在总览页上直接提交答卷      |
| `Ctrl+O` / `Ctrl+K`    | 快捷编辑当前聚焦选项的专属补充说明（Option Note）         |
| `Ctrl+J` / `Ctrl+N`    | 将滚动焦点移至右侧预览区，可上下翻动长篇 Markdown 草稿    |
| `PageUp` / `PageDown`  | 快速上下翻页右侧预览长文                                  |
| `Esc`                  | 取消本次请示（向智能体返回取消封套）                      |

---

## 🤖 智能体提示词与调用规范 (Agent Guidelines)

在系统提示词或 Skill 中声明以下规则，可引导 LLM 智能、高效地发起创作请示：

```markdown
Whenever plot branches, character decisions, scene atmosphere, or outline directions need confirmation:

- Call `ask_author` directly without conversational preambles.
- Always provide a concise `formTitle`.
- Use the `questions` array to batch interrelated decisions into ONE invocation; avoid consecutive single calls.
- Include causal plot deductions in `description` and scene draft excerpts in `preview`.
- Omit optional default fields (`id`, `description`, `minSelect`, `maxSelect`, `allowEmpty`, `allowCustom`) to maximize token economy and prompt caching.
```

### 参数示例：多题批量问卷

```json
{
  "formTitle": "第七幕逃生抉择与伏笔分配",
  "questions": [
    {
      "title": "第一幕脱离路线选择",
      "options": [
        {
          "label": "炸毁地下蒸汽管网断后",
          "description": "引爆管网阻断追兵，代价是彻底暴露行踪并波及城区管线。",
          "preview": "“听着，艾略特，”雷恩咬紧牙关按下阀门，“我数到三，你往排污井跳！”\n蒸汽在接缝处发出濒临极限的尖啸，暗红警示灯将二人面孔映得如同凝血。"
        },
        { "label": "遁入旧排水暗渠迂回脱离", "description": "周旋于暗渠迷宫，隐匿行踪但有遭遇感染体风险。" }
      ]
    },
    {
      "title": "主角搜刮战利品与剧情伏笔（多选）",
      "multiSelect": true,
      "options": [
        { "label": "过载超频模块", "description": "战斗中可触发高热熔毁，但易过载自伤。" },
        { "label": "加密军方识别铭牌", "description": "揭示军方秘密人体实验编号，引发信任危机。" }
      ]
    }
  ]
}
```

### 返回封套示例

```text
[Author Decision Finalized]
1. [第一幕脱离路线选择]: 【炸毁地下蒸汽管网断后】引爆管网阻断追兵，代价是彻底暴露行踪并波及城区管线。 [Author note: 注意描写气压表的指针爆表碎裂细节] [Draft directive: '听着，艾略特，'雷恩咬紧牙关按下阀门，'我数到三，你往排污井跳！' / 蒸汽在接缝处发出濒临极限的尖啸，暗红警示灯将二人面孔映得如同凝血。]
2. [主角搜刮战利品与剧情伏笔（多选）]: 【过载超频模块】战斗中可触发高热熔毁，但易过载自伤。; 【加密军方识别铭牌】揭示军方秘密人体实验编号，引发信任危机。
Execute workflow and writing strictly according to the author decisions and draft directives above without conversational acknowledgments.
```

---

## 🏗️ 架构与模块设计 (Architecture)

插件采用严格的单向无环依赖图分层构建，保证各个组件职责清晰、高内聚且易于测试：

```text
theme ───► texts ───► format ───► model ─────────────► view-rows ─────► component ───► index
                       │           ▲                    ▲                  ▲
                       ├──► schema ┘                    ├──► novel-markdown┘
                       │                                │
                       └──► sanitize ───────────────────┴──► view-summary ┘
```

- **`index.ts`**：扩展主入口，注册 `ask_author` 工具与 `/ask-author` 命令，负责结果工厂构造与卡片记忆化渲染。
- **`component.ts`**：TUI 状态机核心组件，自持按键派生、光标记忆、视口滑动窗口与双栏排版。
- **`model.ts`**：问卷表单数据模型，负责规范化题目前置推导、选项校验与答案序列化。
- **`schema.ts`**：基于 TypeBox 构建的静态类型与运行时 Schema 单一数据源。
- **`texts.ts`**：常量、终端图标、小说语法表与面向作者/LLM 双向文案的集中字典。
- **`novel-markdown.ts`**：极轻量小说语法终端高亮解析器。
- **`sanitize.ts`**：入参防御性清洗与别名兼容。
- **`view-rows.ts` / `view-summary.ts`**：列表行与总览页的高性能排版生成器。

---

## 🧪 开发与质量验证 (Development)

本项目遵循严苛的静态类型检查与生产级编码规范：

```bash
# 安装开发依赖
pnpm install

# 严格类型检查（要求零错误、零警告）
pnpm run check
```

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](LICENSE) 开源发布。欢迎贡献代码或提出改进建议！
