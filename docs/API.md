# API reference / API 参考

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

Examples use the JS API from the repository root. Writes require a new absolute output path.

示例通过仓库根目录的 JS API 调用。写入必须使用新的绝对输出路径。

## Page statistics / 页面统计

```javascript
const page = await editor.stats({ page: 0 });
console.log(page.widthPt, page.heightPt, page.totalObjects, page.counts);
```

CLI: `node src/cli.mjs stats "test pdf/figure.pdf" --page 0`.

`stats` accepts only `page` (default `0`) and returns page geometry, `pageCount`, `pdfVersion`, `counts`, `totalObjects`, warnings, and source identity. Counts include each Form occurrence and its descendants, matching the unfiltered `inspect` count convention; shared resources are counted at every placement. Types with no objects are omitted. It loads/parses the requested page and traverses its objects, but skips text extraction, fonts, per-object geometry, source mapping, and the full object JSON index. It does not report editability. Filtering or pagination parameters are rejected with `INVALID_ARGUMENT`; use `query`/`inspect` for object selection. Request options (cancellation and timeout) go in the second argument.

`stats` 仅接受 `page`（默认 `0`），返回页面几何信息、页数、PDF 版本、分类数量、总对象数、警告及源文件标识。按每次 Form 放置及其后代对象计数，与未筛选的 `inspect` 统计口径一致，不对共享资源去重；数量为零的类型省略。它仍会加载、解析目标页面并遍历对象，但跳过文字提取、字体、逐对象坐标、来源映射及完整对象 JSON 索引，不判断可编辑性。筛选或分页参数会报 `INVALID_ARGUMENT`；需要选择对象时使用 `query`/`inspect`。第二个参数可传取消信号和超时配置。

## Inspect and select / 检查与选择

```javascript
import path from 'node:path';
import { openDocument } from './src/index.mjs';

const editor = await openDocument(path.resolve('test pdf/figure.pdf'));
try {
  const page = await editor.inspect({ page: 0, limit: 100, offset: 0 });
  const labels = await editor.query({ page: 0, type: 'text', text: 'Study', editable: true });
  await editor.render({ page: 0, dpi: 144, output: path.resolve('output/preview.png') });
} finally {
  await editor.close();
}
```

`query` and `inspect` share parameters: `page`, `id`, `type`, `text`, `editable`, `offset`, and `limit`. Use `hasMore` to check pagination. `sourceMapping: "verified"` means the object was uniquely matched to its source command and a 96 dpi no-change render was checked. Read `supportedOperations` and `editReason` as well as `editable`.

`query` 与 `inspect` 使用相同参数，可按页、ID、类型、文字和可编辑性筛选，并用 `offset`、`limit` 和 `hasMore` 分页。`sourceMapping: "verified"` 表示对象与来源指令唯一对应，且通过了 96 dpi 无变化渲染核对。还应检查 `supportedOperations`、`editReason` 和 `editable`。

`mapping: false` (CLI `--no-mapping`) skips source mapping for read-only inspection, without relaxing write validation. `limit: 0` reduces the response but currently still builds the underlying page index.

`mapping: false`（CLI `--no-mapping`）跳过只读检查的来源映射，不放宽写入验证。`limit: 0` 能减少返回内容，但目前仍会建立底层页面索引。

For sizes/counts only, use `stats`; for target details, use `query`; after editing, use the receipt and request a preview when needed. Narrow queries reduce response size but may still build the full page index and source mapping on their first call.

只需要尺寸及数量时用 `stats`，选定目标时用 `query`，修改后读取回执并按需渲染预览。缩小查询范围能减少返回内容，但首次查询仍可能建立完整页面索引和来源映射。

### Choose response fields / 选择返回字段

```javascript
const labels = await editor.query({
  page: 0, type: 'text', editable: true,
  fields: ['textSource', 'editable', 'supportedOperations']
});
// Each object also has id/type; labels.source.sha256 identifies the snapshot.
```

`fields` is an optional array for `inspect` and `query`. It selects returned object properties, with `id` and `type` always included. An empty array returns only those two fields; properties absent on an object are omitted. Page/source metadata, counts, matching, order and pagination are unaffected. Defaults remain full-detail, and field selection does not alter the cached index or any edit validation. Include `textSource` and editability evidence when preparing text edits. With `mapping: false`, source-mapping fields may be unavailable as before. This reduces JSON/IPC size, not the initial index or mapping work; it does not anonymize selected document text.

`fields` 是 `inspect` 和 `query` 的可选数组，仅选择返回的对象属性，始终附带 `id` 和 `type`。空数组只返回这两项，对象上不存在的属性会省略。页面及源文件信息、统计、匹配、顺序和分页保持一致；默认仍返回完整详情，不改变缓存索引或编辑验证。准备改字时应请求 `textSource` 和可编辑性证据。设置 `mapping: false` 时，来源映射字段仍可能不可用。该参数减少 JSON 和进程间传输量，不省去首次索引或映射工作，也不会将选出的文档文字脱敏。

Allowed names (up to 24 per request) / 允许的字段名（每次最多 24 个）：

```text
id type depth matrix boundsPt boundsKind fill stroke text
fontSizeRaw fontSizeYPt font fontEmbedded strokeWidthRaw strokeWidthPt
segmentCount pixels sourceMapping editable supportedOperations
editReason sourceCommand textSource reusableCharacters
```

CLI: `--fields textSource,editable,supportedOperations`. Unknown names, non-array API values, non-string entries and empty CLI names fail with `INVALID_ARGUMENT`. The CLI option applies only to `inspect`/`query`; `stats` retains its page-only contract.

CLI 使用逗号分隔字段名。未知字段、非数组的 API 参数、非字符串元素或 CLI 中的空字段均报 `INVALID_ARGUMENT`。CLI 选项仅用于 `inspect`/`query`，`stats` 仍只接受页码。

## Geometry / 坐标

| Field / 字段 | Meaning / 含义 |
|---|---|
| `page` | Zero-based / 从 0 开始 |
| `rectPt`, `boundsPt` | Physical pt from the rotated visible page's top-left / 旋转后可见页面左上角起算的物理 pt |
| `fontSizeRaw` | Raw value extracted by PDFium / PDFium 提取的原始字号 |
| `fontSizeYPt` | Effective Y-direction size after text and ancestor transforms / 计入文字及祖先变换后的 Y 方向字号 |
| `strokeWidthPt` | Physical line width when representable; 0 is a hairline / 可表示时的物理线宽；0 表示发丝线 |
| Colors / 颜色 | Read RGBA; write `#RRGGBB` in DeviceRGB / 读取 RGBA，写入 DeviceRGB 的 `#RRGGBB` |

One pt is 1/72 inch. CropBox offsets, rotation, and UserUnit are accounted for. `boundsPt` does not resolve all clipping paths; it is not sufficient for automatic whitespace removal.

1 pt = 1/72 英寸。引擎处理 CropBox 偏移、旋转和 UserUnit。`boundsPt` 未扣除所有裁剪路径，不适合作为自动去白边的唯一依据。

## Edit objects / 修改对象

Pass the inspected source hash, actual object IDs, and exact `textSource` preconditions. The following objects belong in `editor.apply({ sourceSha256, output, operations })`.

使用检查得到的源文件哈希、实际对象 ID 和精确 `textSource` 前置条件。下列对象放入 `editor.apply({ sourceSha256, output, operations })`。

```javascript
// Replace text and optionally change size/color / 改字，可同时修改字号和颜色
{ op: 'text.replace', page: 0, target: label.id,
  expect: { text: label.textSource }, value: 'Studies',
  fontSizePt: 15, fill: '#1D4ED8' }

// Keep the content / 保留内容
{ op: 'text.style', page: 0, target: label.id,
  expect: { text: label.textSource }, fontSizePt: 12, fill: '#333333' }

// An already stroked path / 原本有描边的路径
{ op: 'path.style', page: 0, target: line.id,
  strokeWidthPt: 0.65, stroke: '#606060' }

// An already filled path / 原本有填充的路径
{ op: 'path.style', page: 0, target: shape.id, fill: '#AABBCC' }
```

`textSource` is source text; reader-extracted `text` can include inferred spaces. Font size must be in `(0, 300]` pt, line width in `[0, 100]` pt. Text keeps its baseline origin. Replacing a whole `Tj/TJ` label lays out the new string without its old internal manual kerning; `text.style` retains internal adjustments. Path styling does not move nodes or add previously absent strokes/fills.

`textSource` 是来源文字，阅读器提取的 `text` 可能含推断空格。字号范围为 `(0, 300]` pt，线宽为 `[0, 100]` pt。文字保留基线起点；整体替换 `Tj/TJ` 标签时按新文字排字，不保留旧词内部手工字距，`text.style` 则保留内部调整。路径样式不会移动节点，也不会新增原本不存在的描边或填充。

`reusableCharacters` describes a fast path, not a replacement whitelist. Other characters may come from a verified embedded TrueType program or an exact installed face, checked for observed glyph outlines, PDFium widths, and editable embedding permissions. Simple Type1/TrueType encodings and Type0 Identity-H with single BMP mappings are supported; font extension requires an embedded TrueType source. CFF/Type1/Type3 extension, font-family replacement, TTC/variable fonts, non-BMP text, vertical text, and complex shaping are unsupported.

`reusableCharacters` 表示快速复用路径，不是替换白名单。其他字符可来自核验过的嵌入 TrueType 字体或本机同款字体，检查内容包括已观察字形轮廓、PDFium 字宽和可编辑嵌入权限。支持简单 Type1/TrueType 编码及 Type0 Identity-H 的单个 BMP 映射；字符补全要求源字体嵌有 TrueType 程序。不支持 CFF/Type1/Type3 补全、字体家族替换、TTC/可变字体、非 BMP 字符、竖排和复杂整形。

Receipts include `changes`, `validation.pixelGates`, `validation.fontExpansions`, and `validation.fontReuses`. Text changes include `after.textSource`, checked against the reopened output. Reuse is limited to embedded Identity-H TrueType resources whose unique codes, glyph bindings, and renderer widths match the same embedded font program; other cases retain the expansion path. Keep complete receipts locally: they may contain document text and local font paths.

回执包含 `changes`、`validation.pixelGates`、`validation.fontExpansions` 和 `validation.fontReuses`。文字修改的 `after.textSource` 已与重新打开的输出核对。复用限于目标字符具有唯一编码、字形绑定及渲染字宽均与同一嵌入字体程序相符的 Identity-H TrueType 资源，其他情况保留扩展路径。完整回执可能含文档文字和本地字体路径，应留在本地。

## Compact receipts / 简短回执

```powershell
node src/cli.mjs apply "test pdf/figure.pdf" plan.json --summary --report "output/receipt.json"
node src/cli.mjs compose composition.json --summary --report "output/composition-receipt.json"
```

`--summary` changes stdout only. `--report FILE` writes the full receipt, with or without summary mode. These options are supported only for `apply` and `compose`; errors retain their original code and message. The JS API also exports `summarizeReceipt(receipt)` for callers that manage their own report files. The summary includes output identity, operation counts, and bounded validation statistics, excluding object contents and font paths. Output/report paths and error messages can still contain personal information; this is not automatic anonymization.

`--summary` 只改变 stdout；`--report FILE` 无论是否配合摘要模式，均保存完整回执。这两个选项仅适用于 `apply` 和 `compose`，错误保留原始代码及信息。JS API 也导出 `summarizeReceipt(receipt)`，供自行管理报告文件的调用方使用。摘要包含输出标识、操作数量和有界验证统计，不包含对象正文及字体路径；输出/报告路径和错误信息仍可能含个人信息，并非自动脱敏。

The report path is exclusively reserved before editing. Existing reports and input/output path conflicts are rejected. Controlled failures remove the reserved report. PDF publication and report writing are not one transaction: a report write failure after publication can leave a valid PDF, and a forced process termination can leave an empty or partial report. Check the command's exit status before consuming the report.

编辑前会独占预留报告路径，拒绝已有报告和输入/输出路径冲突，受控失败会清理预留报告。PDF 发布与报告写入并非同一事务：发布后写报告失败可能留下有效 PDF，进程被强制终止可能留下空报告或不完整报告。读取报告前应检查命令退出状态。

## Crop / 裁剪

After inspecting the page, submit a separate crop batch:

检查页面后，单独提交裁剪批次：

```javascript
const receipt = await editor.apply({
  sourceSha256: page.source.sha256,
  output: path.resolve('output/cropped.pdf'),
  operations: [{
    op: 'page.crop', page: 0,
    rectPt: { x: 1, y: 1, width: page.widthPt - 2, height: page.heightPt - 2 }
  }]
});
```

The example removes 1 pt from each visible edge; choose coordinates for your content. CropBox changes, MediaBox does not. Hidden content remains. Use composition for a new canvas size or added margins.

示例从四个可见边缘各裁去 1 pt，实际坐标按内容确定。裁剪修改 CropBox，不修改 MediaBox，隐藏内容仍然保留。新的画布尺寸或额外留白应通过拼版实现。

## Compose / 矢量拼版

```javascript
import path from 'node:path';
import { composeFigure } from './src/index.mjs';

const receipt = await composeFigure({
  widthPt: 720, heightPt: 360,
  output: path.resolve('output/combined.pdf'),
  panels: [
    { file: path.resolve('test pdf/panel-a.pdf'), page: 0,
      targetRectPt: { x: 20, y: 20, width: 330, height: 320 } },
    { file: path.resolve('test pdf/panel-b.pdf'), page: 0,
      targetRectPt: { x: 370, y: 20, width: 330, height: 320 } }
  ]
});
```

Add `sourceRectPt` to select a region, and the inspected `sourceSha256` to reject a changed panel source. Placement uses `contain`: preserve aspect ratio and center in the target rectangle. The receipt records actual placement and scale. Scaling changes final font sizes and line widths. Labels are not added automatically.

面板可增加 `sourceRectPt` 选择区域，以及检查时的 `sourceSha256` 以拒绝变更后的输入。放置采用 `contain`，保持比例并在目标框内居中；回执记录实际位置与缩放。缩放同时改变最终字号和线宽，不自动添加面板标签。

`compose` shares identical `/FontFile2` streams referenced by font descriptors in the new composition. The full stream dictionary (except the computed `/Length`) and encoded bytes must match; a hash match alone is insufficient. Descriptors, font dictionaries, widths, ToUnicode and CID mappings are not merged. Different encodings or stream dictionaries stay separate. Inputs are unchanged; this optimization does not apply to `apply` or crop.

`compose` 会在新拼版中共享字体描述符引用的相同 `/FontFile2` 流。必须核对完整流字典（计算得到的 `/Length` 除外）和编码字节，仅哈希相同不足以共享。不会合并描述符、字体字典、字宽、ToUnicode 或 CID 映射；编码或流字典不同的程序保持独立。输入文件不变，该优化不应用于 `apply` 或裁剪。

Full and compact composition receipts include `optimization.fontProgramsShared` (distinct program streams redirected to an existing copy) and `optimization.encodedFontBytesShared` (their combined encoded payload bytes). These counters describe reference sharing, not the measured output-size reduction or a rendering-verification result.

完整及简短拼版回执均包含 `optimization.fontProgramsShared`（改为引用已有副本的不同字体程序流数量）与 `optimization.encodedFontBytesShared`（这些流的编码数据字节数之和）。它们记录引用共享情况，不代表实测文件缩小量，也不代表渲染验证结果。

Panels with annotations are rejected by default. Explicit `annotations: 'exclude'` omits them and records the count. Clipped content can remain embedded; composition and cropping are not redaction.

默认拒绝带注释的面板；显式设置 `annotations: 'exclude'` 会排除注释并记录数量。被裁剪内容可能仍嵌在文件中，拼版和裁剪不能用于脱敏。

## Sessions and limits / 会话与限制

- A session edits its opened snapshot. Call `editor.open(receipt.output)` before editing a saved result. / 会话编辑打开时的快照，继续改保存结果前调用 `editor.open(receipt.output)`。
- An apply batch accepts 1–100 operations, at most one per object. Crop and object-edit batches are separate; at most one crop per page. / 每批接受 1–100 项操作，每个对象最多一项；裁剪与对象编辑分批执行，每页每批最多裁一次。
- Composition accepts 1–32 panels and dimensions up to 14,400 pt. Inputs are limited to 256 MiB. / 拼版接受 1–32 个面板，页面各边不超过 14,400 pt，输入文件上限 256 MiB。
- `apply` and `compose` copy plans before queuing. Later caller mutations do not change the job. / `apply` 和 `compose` 在排队前复制计划，随后修改调用方对象不会改变任务。
- The same explicit `requestId` and apply plan in one session replay the verified receipt. Different plans with that ID are rejected. This is not persistent recovery. / 同一会话中，相同 `requestId` 和 apply 计划会重放核验过的回执；相同 ID 不同计划被拒绝，不提供跨进程持久恢复。
- The second argument accepts `{ signal, timeoutMs }`. Cancellation before dispatch preserves the session; cancellation or timeout after dispatch terminates its worker. Reopen afterward. Always `await editor.close()`. / 第二个参数支持 `{ signal, timeoutMs }`。派发前取消保留会话，派发后取消或超时终止 worker，随后需要新会话。退出前始终 `await editor.close()`。

## CLI and errors / 命令行与错误

```powershell
node src/cli.mjs --help
node src/cli.mjs apply "test pdf/figure.pdf" plan.json
node src/cli.mjs compose composition.json
```

Plans use the JS API's JSON fields, including absolute output paths. `doctor` checks runtime support and executable presence without starting a worker; the demo additionally exercises the loaded libraries.

计划使用 JS API 的 JSON 字段，包括绝对输出路径。`doctor` 检查运行环境和可执行文件是否存在，不启动 worker；演示进一步验证相关库实际加载与工作。

| Error / 错误码 | Action / 处理方式 |
|---|---|
| `STALE_SOURCE` | Reopen and inspect the input / 重新打开并检查输入 |
| `OUTPUT_EXISTS` | Choose a new output name / 使用新的输出名称 |
| `OUTPUT_PUBLISH_FAILED` | Check NTFS and directory permissions / 检查 NTFS 和目录权限 |
| `ENGINE_NOT_FOUND`, `ENGINE_VERSION_MISMATCH` | Run setup/build, then reopen / 执行 setup/build 后重新打开 |
| `FONT_FACE_UNAVAILABLE`, `FONT_GLYPH_UNAVAILABLE` | Check the font and requested characters / 检查字体和目标字符 |
| `FONT_FACE_MISMATCH`, `FONT_EMBEDDING_RESTRICTED` | Inspect font compatibility and embedding permissions / 检查字体相符性和嵌入权限 |
| `FONT_EXTENSION_UNSUPPORTED`, `FONT_CODE_UNVERIFIED` | The font/encoding is outside supported editing / 字体或编码超出当前编辑范围 |
| `REPAIRED_PDF_READ_ONLY`, `UNSUPPORTED_DOCUMENT` | Read the document restriction / 查看文档限制原因 |
| `CANCELLED`, `TIMEOUT`, `SESSION_CLOSED` | Reopen if the worker stopped / worker 停止后重新建立会话 |

`PdfError` exposes `code` and `message`, with `details` when available. Objects also report read-only reasons. Keep full errors locally; remove document content and personal paths before sharing.

`PdfError` 提供 `code`、`message`，部分错误含 `details`；对象也返回只读原因。完整错误留在本地，共享前应去除文档内容和个人路径。
