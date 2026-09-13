# API reference / API 参考

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

Examples use the JS API from the repository root. Writes require a new absolute output path.

示例通过仓库根目录的 JS API 调用。写入必须使用新的绝对输出路径。

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

Receipts include `changes`, `validation.pixelGates`, and `validation.fontExpansions`. Keep the complete receipt locally; an agent can receive a summary and request details as needed. Receipts may contain document text and local font paths.

回执包含 `changes`、`validation.pixelGates` 和 `validation.fontExpansions`。完整回执留在本地，可只向 agent 返回摘要，按需读取详情；回执可能含文档文字和本地字体路径。

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
