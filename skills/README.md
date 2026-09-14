# PDF editor skill / PDF 编辑 skill

## 直接使用 / Install to use

从 [Release](https://github.com/linnnn89/PDF-editor/releases/tag/v0.2.8-alpha.1) 下载 **[pdf-editor-skill-v0.2.8-alpha.1-win-x64.zip](https://github.com/linnnn89/PDF-editor/releases/download/v0.2.8-alpha.1/pdf-editor-skill-v0.2.8-alpha.1-win-x64.zip)**，将其中整个 `pdf-editor/` 文件夹解压到宿主已配置的 skills 目录，例如 `~/.agents/skills/`。无需下载源码或编译；主机需 Windows x64、Node.js 24，输出目录需支持 NTFS 硬链接。更新前请将已有版本备份到 skills 发现目录之外，保留个人修改。

Download the **prebuilt skill ZIP** linked above and extract its `pdf-editor/` folder into your host's configured skills directory, such as `~/.agents/skills/`. No source download or compilation is required. The host needs Windows x64 and Node.js 24; outputs need NTFS hard-link support. Back up an existing installation outside the discovery directory before updating.

安装包 / Package contents:

```text
pdf-editor/
  SKILL.md                 Thin entrypoint / 薄入口
  references/              Setup, operations, rules / 按需手册
  package-manifest.json    File sizes and SHA-256 / 文件清单与哈希
  project/
    src/                   JavaScript API and CLI
    build/bin/             Compiled engine and required DLLs
    native/                C++ source
    scripts/               Local examples and developer scripts
    docs/                  API reference
    tests/                 Synthetic development tests
    licenses/              Third-party notices
    package.json
```

完整包保留公开项目文件；不包含 Node.js、编译器、Git 历史、下载缓存、真实 PDF、私人脚本或性能结果。`references/setup.md` 记录所有入口相对路径，从 skill 自身目录定位 `project/`，整体搬迁无需改写机器路径。宿主刷新 skills 或新开会话后使用 `$pdf-editor`。复制文件不证明客户端已热加载；包内 API 的 worker 握手才验证实际运行版本。

The package retains the public project files. Node.js, compilers, Git history, dependency caches, research PDFs, private scripts and benchmark results are excluded. `references/setup.md` resolves every entrypoint relative to the skill's location. Move the whole folder without rewriting machine-specific paths. Refresh skills or start a new session and invoke `$pdf-editor`. File copying does not establish client hot reload; verify the running worker through its API handshake.

## 自行改造 / Source development

修改项目请下载源码或 `git clone`，**无需下载预编译包**。仓库中的 `skills/pdf-editor/` 是精简模板，并不包含运行程序。按主 README 的开发者说明准备现有工具链，然后运行：

To modify the project, download source or clone the repository; **you do not need the prebuilt package**. The repository's `skills/pdf-editor/` is a thin template, not a runtime installation. Follow the main README's developer prerequisites, then run:

```powershell
npm run setup
npm run build
npm run skill:pack
```

`setup` 下载固定版本的本地构建依赖；`build` 编译；`skill:pack` 仅从已准备好的项目生成完整 `pdf-editor/` 目录，输出路径会打印到终端。打包命令本身不下载、不安装、不覆盖已有目录。可以用 `npm run skill:pack -- --output <新的绝对目录>/pdf-editor` 指定新目录。

`setup` downloads pinned project-local build dependencies; `build` compiles the engine; `skill:pack` creates the complete skill directory and prints its location. Packaging itself downloads, installs and overwrites nothing. Use `npm run skill:pack -- --output <new-absolute-directory>/pdf-editor` to select a new destination.

当前源码的 `skill:pack` 在输出成功前会校验成品清单中每个文件的大小及 SHA-256，将清单文件复制到包含中文和空格的新目录，再从搬迁后的包内运行 `doctor --deep` 与合成 PDF 演示。演示验证读取、编辑、重开、渲染、非目标像素及源文件哈希。验证目录和预览保留在 `artifacts/package-checks/`，不进入待分发包。失败时命令非零退出，保留现场用于诊断；不要分发未通过验证的目录。

Source `skill:pack` verifies every manifest file's size and SHA-256 before reporting success, copies the manifest files to a new path with Unicode and spaces, then runs `doctor --deep` and the synthetic PDF demo from that relocated package. The demo checks reading, editing, reopening, rendering, non-target pixels and the original hash. Diagnostics and previews stay in `artifacts/package-checks/`, outside the distributable package. Failure exits nonzero and retains diagnostic files; do not distribute an unverified directory.

对已有成品目录可单独运行 / To verify an existing package directory:

```powershell
npm run skill:verify -- --package "D:\packages\pdf-editor"
```

打包通过 `skills/project-files.json` 明确列出的公开文件、固定 EXE/DLL 清单及第三方许可文本复制，新增公开项目文件时需更新清单。源码 ZIP 无需 Git 也可打包。入口和参考手册放在包顶层，`project/` 内不再重复放置 `SKILL.md`，以免宿主重复发现。分发时压缩整个生成的 `pdf-editor/` 文件夹，并发布到 Release；不要提交编译文件到源码仓库。

Packaging copies the public files in `skills/project-files.json`, a fixed EXE/DLL list and third-party notices. Update the manifest when public project files are added; packaging a source ZIP does not require Git. The skill entrypoint and references live at the package root, without a duplicate `SKILL.md` under `project/`. Distribute the whole generated folder as a Release ZIP; keep compiled files out of source control.
