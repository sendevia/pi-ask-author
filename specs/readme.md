---
id: doc-readme
type: module-design
status: active
title: 项目 README
parent: ask-author-goal
references: [ask-author-architecture, mod-interaction]
---

# 项目 README

`README.md` 是本插件面向最终用户的唯一说明文档，随包发布并在 npm 与 GitHub 仓库页展示。

## 读者

用 Pi 写小说或其他长文的作者。他不读源码，不构建项目，只关心这个插件解决什么、怎么装、怎么用、按哪个键。

## 文档骨架

固定按此顺序组织，没有内容的小节直接删除，不保留空标题：

1. 一句话定位：在什么场合替作者决定什么。
2. 截图：`etc/image.png`。
3. 用途：为什么这类决定值得一张独立问卷。
4. 功能：按作者能获得的结果分条，每条两三句。
5. 安装：npm 与 GitHub 两条 `pi install`，外加不安装直接试用的 `pi -e` 命令。
6. 使用：模型主动发起、在提示词里要求发起的示例、`/ask-author` 命令。
7. 快捷键表：按键与作用的完整对照。
8. 许可证。

## 内容边界

- 只写作者可感知的行为：界面分区、展示内容、按键、批注、题型、语言。模块划分、缓存失效、入参清洗、Schema 字段、推演协议与封套格式属于 specs，不进入 README。
- 构建、类型检查与测试命令属于开发流程，由 AGENTS.md 承载；README 不设开发章节。
- 面向大语言模型的工具说明不在此展开，需要指导模型使用时指向 `/ask-author` 命令的提示。

## 事实来源

- 安装命令取自 `package.json` 的包名与 `pi` 命令的装载方式。
- 快捷键表以 `mod-interaction` 记录的按键状态机为准，按键与作用逐条对应，不遗漏也不臆造。
- 界面语言列表以 `lang/` 下实际存在的语言文件为准。
- 版本、许可证、仓库地址与 `package.json` 保持一致。
- 截图引用仓库内的 `etc/image.png`，更换界面后同步更新。

## 措辞

遵守 AGENTS.md 第一节的语言规则，此处不复制其条目。
