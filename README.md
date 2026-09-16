# pi-ask-author

![NPM Version](https://img.shields.io/npm/v/%40sendevia%2Fpi-ask-author?style=flat-square&link=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2F%40sendevia%2Fpi-ask-author)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

专为作家、轻小说创作者与 AI 协同写作设计的 [Pi](https://github.com/earendil-works/pi-coding-agent) 终端交互式请示扩展。

通过 Markdown 正文草稿预览、剧情因果推演、题目与选项两级批注以及结构化的返回封套，让创作分歧在同一次询问内得到确认。

---

## 🌟 核心特性 (Key Features)

- 🖥️ **双栏响应式 TUI 交互**
  - **左栏选项决策**：直观展示单选/多选状态、完成度指示徽标、选项标签与专属批注标识。
  - **右栏实时预览**：光标移动时即时联动渲染当前选项的**剧情因果推导**与 **Markdown 正文草稿预览**。
  - **自适应视口**：终端宽度不足时启用双栏，窄屏下改为单栏内联展开与折叠。
- 📖 **小说级富文本与草稿高亮**
  - 内置紧凑轻量的终端 Markdown 渲染与小说语法高亮，完整支持 bold、italic、删除线、行内代码、引用区块。
  - 对中文小说台词（引号内对话高亮）与分段排版做了专门处理，作者可以在终端内直接检视行文节奏与语感。
- 📝 **题目与选项两级批注体系 (Notes & Annotations)**
  - **题目级补充说明 (Question Note)**：对该题整体提出全局创作指令或氛围补充。
  - **选项专属补充说明 (Option Note)**：光标位于选项行时按 `n` 即可为特定选项追加细化批注（**未勾选的选项同样可以填写补充说明**，便于模型借鉴未选方案中的可取之处）。
- 📋 **单题平铺与批量问卷双模式**
  - **单题平铺模式**：快速发起单点决策（如重要剧情分歧、结局走向）。
  - **多题批量问卷模式**：支持在单次弹窗内汇集多个关联决策（如脱离路线 + 战利品搜刮 + 下章基调），配有顶部 Tab 标签栏与完成度总览页（Summary Tab），作者在一处完成全部确认。
- 🎯 **确定性 LLM 封套与指令蒸馏 (Deterministic Envelopes)**
  - 工具返回给 LLM 的文本采用固定的结构化 Markdown 封套（`[Author Decision Finalized]` / `[Author Decision Cancelled]` / `[Author Consultation Error]`），前缀稳定，便于缓存命中。
  - **草稿指令提取 (Draft Directives)**：选中的选项草稿预览会自动提炼为紧凑的单行 `[Draft directive: ...]` 指令，直接供 LLM 在后续正文执笔中原样复用或参考。
  - 尾部附带执行指令，要求模型不再寒暄，直接进入下一步正文写作。
- ⚡ **高性能与极简依赖**
  - 严格遵守 Pi 官方扩展生态规范，不引入其他第三方依赖。
  - 资源回收：生命周期严格绑定 AbortSignal，定时器与事件监听幂等清理，渲染缓存按尺寸与状态键失效。

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

| 按键                                          | 功能说明                                                                     |
| :-------------------------------------------- | :--------------------------------------------------------------------------- |
| `Tab` / `Shift+Tab` 或 `←` / `→` 或 `h` / `l` | 在题目页与提交总览页之间循环切换                                             |
| `1`~`9`                                       | 直接跳转到第 N 题                                                            |
| `↑` / `↓` 或 `k` / `j`                        | 作答页移动菜单光标；总览页上下滚动                                           |
| `Home` / `End`                                | 作答页跳到菜单首项 / 末项；总览页跳到顶部 / 底部                             |
| `Space`                                       | 作答页勾选或取消勾选当前选项；总览页向下滚动                                 |
| `Enter` / `Ctrl+S`                            | 作答页确认本题并前进；总览页提交答卷                                         |
| `n` / `e`                                     | 编辑当前聚焦选项的专属补充说明（光标位于题目补充说明入口时编辑题目补充说明） |
| `N`                                           | 直接编辑题目整体补充说明                                                     |
| `x` / `Delete`                                | 清空当前聚焦选项的补充说明，其次清空题目补充说明                             |
| `a`                                           | 多选模式下全选或清空已选项                                                   |
| `PgUp` / `[` / `Alt+↑`                        | 作答页向上滚动预览区；总览页向上滚动                                         |
| `PgDn` / `]` / `Alt+↓`                        | 作答页向下滚动预览区；总览页向下滚动                                         |
| `Esc` / `Ctrl+C`                              | 取消本次请示（编辑器中首次按下需再次确认丢弃修改）                           |

---

## 🧪 开发与质量验证 (Development)

本项目开启 TypeScript 严格模式：

```bash
# 安装开发依赖
pnpm install

# 严格类型检查（要求零错误、零警告）
pnpm run check
```

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](LICENSE) 开源发布。欢迎贡献代码或提出改进建议！
