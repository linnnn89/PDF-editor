# Agent PDF Editor

**直接修改手头已有的 PDF Figure。** 修正标签、调整字号和线条、裁剪留白、组合多个面板，并保留矢量内容。

[English](README.md) · [简体中文](README.zh-CN.md)

![状态：alpha](https://img.shields.io/badge/status-alpha-orange)
![Windows x64](https://img.shields.io/badge/platform-Windows_x64-blue)
![Node.js 24](https://img.shields.io/badge/Node.js-24-417E38)

Agent PDF Editor 为研究者和 agent 开发者提供本地 CLI 与 JavaScript API，用于精确修改已有 PDF 图中的受支持对象。处理过程直接操作 PDF，无需经 SVG 往返转换，也无需从数据重新生成整张图。

> **当前版本：0.2.8-alpha.1。** 仅支持 Windows x64。目前需要从源码构建，尚无桌面 GUI 或预编译安装包。能否编辑具体对象，取决于输入 PDF 的结构和字体。

[快速开始](#快速开始) · [JavaScript 示例](#javascript-示例) · [能力范围](#能力范围) · [API 参考](docs/API.md)

## 效果预览

将 `Panle A` 修正为 `Panel A`，字号从 12 pt 调至 18 pt，横线从 0.75 pt 调至 1.5 pt，并统一为蓝色。其余对象保持不变。

| 修改前 | 修改后 |
|---|---|
| ![合成 PDF 修改前：含拼写错误的小号标签和细灰线](docs/assets/demo-before.png) | ![合成 PDF 修改后：修正后的蓝色标签和加粗蓝线](docs/assets/demo-after.png) |

预览来自**程序生成的合成样本**，不包含真实研究资料。构建后运行 `node scripts/demo.mjs`，即可在本地生成对应 PDF、预览和验证回执。每次运行使用新的输出目录。

## 适合做什么

- **修正图中标签：** 替换文字，调整字号和颜色。
- **改善可读性：** 修改路径线宽、描边色和填充色，保留原图结构。
- **制作多面板 Figure：** 将多份 PDF 的页面或指定区域放到新画布，保留其中的矢量内容。
- **调整可见留白：** 按物理坐标裁剪页面，或拼入更大的画布增加边距。
- **让修改可重复执行：** 检查对象，提交带明确前置条件的一批操作，核查保存结果和回执。

## 快速开始

运行需要 **Windows x64**、**Node.js 24** 和 **NTFS 输出目录**。构建还需要已安装的 Visual Studio C++ x64 工具链、Windows SDK、CMake 3.24+ 和 Ninja。构建脚本会查找 Visual Studio 及其附带的 CMake/Ninja；后两项也可从 PATH 查找。

```powershell
git clone https://github.com/linnnn89/PDF-editor.git
cd PDF-editor
npm run setup
npm run build
node src/cli.mjs doctor
node scripts/demo.mjs
```

无需安装第三方 npm 包。`setup` 将约 33 MB 的固定版本原生依赖下载到项目的 `vendor/`，校验 SHA-256，并创建被 Git 忽略的 `test pdf/` 目录。它不会安装系统工具或修改全局配置。

演示命令会输出修改前后的 PDF、PNG 预览和结果目录路径。编辑器在本地处理文件，不调用 AI 服务，也不上传 PDF；外部 agent 宿主自行决定模型调用及哪些工具输出会发送给模型。

### 使用自己的 PDF

将文件放到 `test pdf/figure.pdf`，然后检查对象、生成预览：

```powershell
node src/cli.mjs stats "test pdf/figure.pdf" --page 0
node src/cli.mjs inspect "test pdf/figure.pdf" --limit 20
node src/cli.mjs query "test pdf/figure.pdf" --type text --text "Study" --fields textSource,editable,supportedOperations
node src/cli.mjs query "test pdf/figure.pdf" --type path --editable
node src/cli.mjs render "test pdf/figure.pdf" --output "output/preview.png" --dpi 144
```

每次写入请使用新的输出名称；工具不会覆盖已有文件。CLI 的结果以 JSON 写入 stdout，错误以 JSON 写入 stderr。需要解析 JSON 时，直接调用 `node src/cli.mjs`，避免混入 npm 自身的控制台输出。

agent 可先用 `stats` 获取页面尺寸和各类对象数量，需要选定目标时再用 `query`。`stats` 跳过文字、字体和来源映射提取，递归计入嵌套面板，但不能判断对象是否可编辑。它仍需解析页面；完整选择与检查使用 `query` 或 `inspect`。

使用 `fields`（CLI 为 `--fields`）可只返回任务需要的对象属性，始终包含 ID 和类型，筛选、分页及编辑验证保持一致。不传该参数时仍返回完整详情。这会减少响应内容，不会省去首次页面索引，也不要求在编辑前额外查询一次。

agent 工作流可在 `apply` 或 `compose` 后增加 `--summary --report output/receipt.json`：向模型返回简短结果，将完整回执保存在新的本地文件中。不使用这些选项时仍返回原有完整 JSON。报告失败和隐私边界见[简短回执](docs/API.md#compact-receipts--简短回执)。

## JavaScript 示例

将下列代码保存为仓库根目录下的 `edit.mjs`，按实际 PDF 修改输入路径和标签。目标必须是可编辑的文字对象；不支持的字体或字符会返回明确错误。

```javascript
import path from 'node:path';
import { openDocument } from './src/index.mjs';

const editor = await openDocument(path.resolve('test pdf/figure.pdf'));
try {
  const result = await editor.query({ page: 0, type: 'text', text: 'Study' });
  const matches = result.objects.filter(o => o.editable && o.textSource === 'Study');
  if (result.hasMore || matches.length !== 1) throw new Error('Select one exact editable label');
  const label = matches[0];

  const receipt = await editor.apply({
    sourceSha256: result.source.sha256,
    output: path.resolve('output/figure-edited.pdf'),
    operations: [{
      op: 'text.replace', page: 0, target: label.id,
      expect: { text: label.textSource }, value: 'Studies',
      fontSizePt: 15, fill: '#1D4ED8'
    }]
  });
  console.log(receipt.output);
} finally {
  await editor.close();
}
```

页码从 **0** 开始。坐标以旋转后可见页面的左上角为原点，单位为物理 **pt**，1 pt = 1/72 英寸。对象 ID 和 `textSource` 应取自本次检查结果。

连续执行多项修改时，保持一个 JS 会话并批量提交。每个会话始终编辑打开时的快照；要继续修改保存后的结果，需要重新打开输出文件。裁剪、拼版、分页读取、取消和错误处理见 [API 参考](docs/API.md)。

**需要替换整列名称？** 将完整查询结果和明确的新旧名称对应表交给 `planTextReplacements()`，再用一次 `apply()` 提交返回的操作。可统一设置字号和颜色；缺失、歧义和不支持的目标会集中报告，不返回部分计划。匹配范围限于查询中的完整来源文字，不自动识别 study 行或合并碎片文字。示例见[批量替换标签](docs/API.md#batch-label-replacement--批量替换标签)。

只处理某一列时，可使用 `query({ withinRectPt })`，CLI 对应 `--within-rect x,y,width,height`。若要求改后的文字仍留在该列内，还需给 `apply` 传入 `textBounds`。两者是独立的可选项：前者筛选原始对象，后者检查重开后的结果，集中报告超界目标并拒绝发布该结果，不自动缩字号。详见[文字范围约束](docs/API.md#text-boundary-guards--文字范围约束)和[本地年份格式示例](scripts/rename-year-labels.mjs)。

## 安装 agent skill

将整个 [`skills/pdf-editor`](skills/pdf-editor) 文件夹复制到 agent 宿主的 skills 目录即可。入口保持简短，按需读取环境设置、操作手册和规则。Skill 提供操作指南，使用时仍需已构建的 Windows 编辑器仓库。复制、更新和验证方法见[安装说明](skills/README.md)。

## 能力范围

| 需求 | 当前支持情况 |
|---|---|
| 检查文字、路径、图片、字体和嵌套 Form | 读取几何位置、样式，并返回明确的可编辑性及原因 |
| 替换文字、修改字号或颜色 | 唯一映射的顶层水平文字；支持已知字符复用与经过核验的 TrueType 字符补全 |
| 修改线宽、描边色或填充色 | 受支持的路径；按物理单位改线宽要求均匀正交变换 |
| 裁剪页面可见留白 | `page.crop`；修改 CropBox 并保留原始内容流 |
| 合并页面或区域 | 最多 32 个面板，按比例放入新页面，保留矢量内容 |
| 生成预览 | 36–600 dpi PNG，单次最多 4000 万像素 |
| 移动线条端点、替换图片、编辑嵌套 Form 内部对象 | 尚未实现；可以读取检查 |
| 更换字体家族、扫描件 OCR、复杂文字整形 | 尚未实现 |

## 验证与使用边界

写入使用新文件，拒绝过期输入和已存在的目标路径。对象编辑后会重新打开结果，核对请求的修改、原始内容流和未选中的对象，并由 PDFium 在 **144 dpi** 下比较图像：允许变化的目标区域及固定抗锯齿边缘之外，变化像素必须为零。

这项检查用于验证修改范围，不能判断长标签是否遮住邻近内容，也不能代替排版审美。用于论文或演示之前，请检查预览。

保存时对可压缩的新增流进行无损压缩，包括页面内容、字体映射和拼版包装；原始内容流、资源流及导入的图片、字体和嵌套 Form 资源保留编码。没有图片降采样，也不清除旧内容。文件大小取决于输入结构和新增字体，不能保证每次编辑都比原文件小。

拼版会核对流字典和编码字节，共享不同面板输入中完全相同的嵌入 TrueType 字体程序；字体描述符、字符映射和字宽仍然独立。回执记录共享统计，这些数值不等于文件实际缩小量。对象编辑和裁剪继续保留原有的原始流保护行为。

- 文字保留原基线起点，不提供自动重排、居中或适应文本框。
- 字符补全会核验字形、字宽和嵌入权限。对于受支持的嵌入 Identity-H TrueType 资源，会先验证目标字符的编码、字形编号和字宽，再复用原资源。首次补入完整字体仍可能增大文件；不能确认可复用时，使用独立字体资源。
- 拼版面板使用嵌套 Form。修改其中的标签时，应调整输入文件或拼版前的计划，再执行拼版。
- 不支持加密 PDF；签名 PDF 及存在解析修复警告的文件不能编辑。
- 写入颜色为 DeviceRGB，不提供 ICC/CMYK 印前转换，也不保证不同阅读器的渲染完全一致。
- **本工具不能用于保密删除或脱敏。** 裁剪和拼版可能保留隐藏内容，文字替换也会保留原始流；不要用这些操作删除机密信息。

## 开发与本地资料

```powershell
npm test
npm run bench -- --dir "test pdf" --runs 10
npm run bench:edits -- --dir "test pdf" --runs 5
npm run bench:batch -- --input "test pdf/figure.pdf" --replacements "test pdf/names.json" --runs 5
```

测试会生成合成 PDF；字体补全测试使用本机已安装的 Arial 常规体和粗体，不随仓库分发字体文件。性能测试使用自己的本地样本，报告写入 `artifacts/`，测量本地处理耗时，不包含 agent 推理或模型调用延迟。

批量基准读取所选页面的明确对应表，例如由 `{ "from": "Author 2020", "to": "Author (2020)" }` 组成的 JSON 数组，比较单个、半列和整列替换，核对重开文字、非目标像素及原文件哈希。请求大小记录 UTF-8 字节数，不等同于模型 token。名称对应表请与私有 PDF 一起放在 `test pdf/`。

PDF、本地研究目录、凭据、生成结果、下载的依赖和构建产物均由 Git 忽略。性能报告和编辑回执可能含提取出的文字和本地路径，应留在本地；提交 issue 附件前请单独检查。

技术栈为 **JavaScript / Node.js 24 + C++20**：[PDFium](https://pdfium.googlesource.com/pdfium/) 负责读取与渲染，[QPDF](https://github.com/qpdf/qpdf) 负责写入，[nlohmann/json](https://github.com/nlohmann/json) 负责 JSON。版本、下载地址和校验值固定在 [dependencies.lock.json](dependencies.lock.json)，第三方许可说明保留在下载的依赖中。项目自身暂未选择许可证。

欢迎通过 [GitHub Issues](https://github.com/linnnn89/PDF-editor/issues) 反馈问题，附上版本、命令、预期行为和错误码。优先提供合成复现样本，避免提交机密 PDF。
