# Portable PDF editor skill / 可复制的 PDF 编辑 skill

## 中文

本目录的 `pdf-editor/` 是操作指南，包含精简入口、环境核验、操作手册和编辑规则。可下载仓库 ZIP 后提取该文件夹，或从已有 checkout 复制。**必须复制整个 `pdf-editor` 文件夹，包括 `references/`，不能只复制 `SKILL.md`。**

1. 找到宿主已经配置的 skills 目录；Codex 通常使用 `~/.agents/skills`，以当前宿主实际配置为准。
2. 若目标已存在 `pdf-editor`，先比较内容，将旧版备份到发现目录之外，再更新，不要直接覆盖个人修改。
3. 将整个文件夹放为 `<skills-directory>/pdf-editor/`，检查其内有 `SKILL.md` 与三个参考文件。
4. 按宿主正常方式刷新 skills 或新开会话，再使用 `$pdf-editor`。复制完成不代表已连接客户端已经热加载。

安装指南不要求修改 Codex 配置或安装软件。Skill 不捆绑引擎、字体、PDF 或二进制；实际执行仍需要另外的、已编译的本仓库、Windows x64 和 Node.js 24。提供 checkout 路径后，代理会核验包名、JS 与原生引擎版本。0.2.8 系列功能说明以实际 checkout 为准；缺少环境时应先说明，不能自动安装或下载依赖。

## English

`pdf-editor/` contains operating guidance: a thin entrypoint, setup verification, an operations manual, and editing rules. Download the repository ZIP and extract that folder, or copy it from an existing checkout. **Copy the entire `pdf-editor` directory, including `references/`, not only `SKILL.md`.**

1. Locate your host's already configured skills directory. Codex commonly uses `~/.agents/skills`; follow the actual host configuration.
2. If `pdf-editor` already exists, compare it first and back up the old version outside the discovery directory before updating. Preserve personal modifications.
3. Place the folder at `<skills-directory>/pdf-editor/`, retaining `SKILL.md` and all three reference files.
4. Refresh skills or start a new session using your host's normal workflow, then invoke `$pdf-editor`. Copying files does not prove an already connected client hot-loaded them.

Installing this guide does not require changing Codex configuration or installing software. The skill bundles no engine, fonts, PDFs, or binaries. Execution separately requires a compiled checkout of this repository, Windows x64, and Node.js 24. Supply the checkout path so the agent can verify its package identity and JS/native versions. The guide targets the 0.2.8 series; the actual checkout determines available features. Missing prerequisites must be reported before installing or downloading anything.
