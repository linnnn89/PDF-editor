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

`query` and `inspect` share parameters: `page`, `id`, `type`, `text`, `editable`, `withinRectPt`, `offset`, and `limit`. Use `hasMore` to check pagination. `sourceMapping: "verified"` means the object was uniquely matched to its source command and a 96 dpi no-change render was checked. Read `supportedOperations` and `editReason` as well as `editable`.

`query` 与 `inspect` 使用相同参数，可按页、ID、类型、文字和可编辑性筛选，并用 `offset`、`limit` 和 `hasMore` 分页。`sourceMapping: "verified"` 表示对象与来源指令唯一对应，且通过了 96 dpi 无变化渲染核对。还应检查 `supportedOperations`、`editReason` 和 `editable`。

`mapping: false` (CLI `--no-mapping`) skips source mapping for read-only inspection, without relaxing write validation. `limit: 0` reduces the response but currently still builds the underlying page index.

`mapping: false`（CLI `--no-mapping`）跳过只读检查的来源映射，不放宽写入验证。`limit: 0` 能减少返回内容，但目前仍会建立底层页面索引。

With mapping enabled, read-only objects expose `editReasonCode` alongside the
human-readable `editReason`. Editable objects omit both. General codes include
`SOURCE_MAPPING_UNAVAILABLE`, `SOURCE_MAPPING_FAILED`, `UNSUPPORTED_FONT`,
`UNSUPPORTED_TEXT`, and `UNSUPPORTED_PATH`. This diagnostic does not replace
the validation performed by `apply`.

开启来源映射时，只读对象同时返回稳定的 `editReasonCode` 和可读说明 `editReason`；可编辑对象省略两者。诊断不代替 `apply` 的写入核验。可用 `--fields font,editable,editReasonCode,editReason` 查询并按字体归类原因。

### Simple-font encoding dictionaries / 简单字体编码字典

Type1/TrueType fonts without a ToUnicode stream can use a direct or indirect
`/Encoding` dictionary. Supported bases are `/WinAnsiEncoding` and the printable
32–126 subset of `/StandardEncoding`. An omitted base is accepted only for the
twelve unembedded standard Latin Type1 fonts (Helvetica, Times and Courier
variants). `Differences` overlays the base using exact names from the 586-entry
Adobe AGLFN 1.7 table. `/minus` means U+2212 (`−`); `/hyphen` means U+002D (`-`).
Use `textSource` for exact edit preconditions. A supported ToUnicode stream
takes precedence.

无 ToUnicode 流的 Type1/TrueType 字体现在支持直接或间接的 `/Encoding` 字典。基础编码支持 WinAnsi，以及 StandardEncoding 的 32–126 字符码子集；省略基础编码时，仅接受未嵌入的 Helvetica、Times、Courier 标准 Type1 字体及其粗体/斜体变体。`Differences` 按 Adobe AGLFN 1.7 的 586 个精确字形名覆盖基础映射，不猜测未知名称、名称后缀、组合字形或 Unicode 命名形式。数学减号 `−` 与连字符 `-` 分别保留。已有受支持的 ToUnicode 流优先，编辑前置条件应使用 `textSource`。

| Code / 诊断码 | Meaning / 含义 |
| --- | --- |
| `FONT_ENCODING_UNSUPPORTED` | Unsupported base or unknown implicit encoding / 不支持的基础编码，或无法确定内置编码 |
| `FONT_ENCODING_INVALID` | Invalid types, start codes, out-of-range or repeated assignments / 字典类型、起始码、越界或重复赋值有误 |
| `FONT_GLYPH_UNMAPPED` | A used code names an unsupported glyph, including `.notdef` / 实际使用的字符码对应未知或未定义字形 |

Unknown Differences names remove the corresponding base mapping and only block
text using those codes; malformed dictionaries block the whole font. Ambiguous
character reuse and noncanonical duplicate-code metrics still fail closed at
edit time. Font resources and source streams are preserved. CID encoding,
complex shaping, and additional text rendering modes are outside this feature.

未知字形会移除对应字符码的基础映射，仅阻止使用该码的文字；结构无效的字典会阻止整套字体。字符复用或字宽仍有歧义时，写入继续拒绝。保存保留原始字体资源及内容流。

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

Allowed names (up to 25 per request) / 允许的字段名（每次最多 25 个）：

```text
id type depth matrix boundsPt boundsKind fill stroke text
fontSizeRaw fontSizeYPt font fontEmbedded strokeWidthRaw strokeWidthPt
segmentCount pixels sourceMapping editable supportedOperations
editReason editReasonCode sourceCommand textSource reusableCharacters
```

CLI: `--fields textSource,editable,supportedOperations`. Unknown names, non-array API values, non-string entries and empty CLI names fail with `INVALID_ARGUMENT`. The CLI option applies only to `inspect`/`query`; `stats` retains its page-only contract.

CLI 使用逗号分隔字段名。未知字段、非数组的 API 参数、非字符串元素或 CLI 中的空字段均报 `INVALID_ARGUMENT`。CLI 选项仅用于 `inspect`/`query`，`stats` 仍只接受页码。

### Select a region / 按区域筛选

```javascript
const column = { x: 20, y: 60, width: 150, height: 240 }; // choose from your PDF
const labels = await editor.query({ page: 0, type: 'text', withinRectPt: column,
  limit: 10000, fields: ['textSource', 'editable', 'supportedOperations'] });
```

CLI: `node src/cli.mjs query figure.pdf --type text --within-rect 20,60,150,240`.

`withinRectPt` is optional for `query`/`inspect`. It must contain exactly `x`, `y`, `width`, `height`, finite values and positive dimensions, entirely inside the visible page. Coordinates use the same physical top-left pt system as `boundsPt`. Only objects whose complete geometric bounds fit within it are selected, allowing 0.0002 pt numerical tolerance. Partly intersecting objects and objects with missing/invalid bounds are excluded. Selection works with `mapping: false`, happens before pagination and field projection, and does not change the cached index. `counts` still describes the whole page; `matched`/`hasMore` describe the filtered selection. The CLI flag is rejected by other commands.

`withinRectPt` 是 `query`/`inspect` 的可选项，必须恰好包含 `x`、`y`、`width`、`height`；数值有限、宽高为正，整个区域位于可见页内。坐标与 `boundsPt` 一致，为左上角起算的物理 pt。仅选中几何边界完整落入区域的对象，允许 0.0002 pt 数值误差；部分相交、缺失或非法边界的对象不选中。支持 `mapping: false`，筛选发生在分页及字段裁剪之前，不修改缓存索引。`counts` 仍为整页计数，`matched`/`hasMore` 反映筛选结果；其他 CLI 命令拒绝该选项。

This filters existing geometry; it does not detect study rows or guarantee that replacement text fits. Geometric bounds do not resolve clipping or prove visibility. Use `textBounds` when output containment is required.

该功能筛选已有几何对象，不识别 study 行，也不保证替换后的文字仍放得下。几何边界未扣除裁剪，也不能证明内容可见；需要约束输出时另传 `textBounds`。

## Batch label replacement / 批量替换标签

```javascript
import { planTextReplacements, summarizeReceipt } from './src/index.mjs';

const labels = await editor.query({
  page: 0, type: 'text', limit: 10000,
  fields: ['textSource', 'editable', 'supportedOperations']
});
const plan = planTextReplacements(labels, [
  { from: 'Author 2020', to: 'Author (2020)' },
  { from: 'Example 2021', to: 'Example (2021)' }
], { fontSizePt: 12, fill: '#222222' }); // optional shared style
const receipt = await editor.apply({ ...plan, output: path.resolve('output/renamed.pdf') });
console.log(summarizeReceipt(receipt));
```

`planTextReplacements(queryResult, replacements, style = {})` is a synchronous, local plan builder. It returns `{ sourceSha256, operations }`; add a new absolute `output` path for `apply`. It never edits the input or calls the engine. Each of 1–100 `{from,to}` entries must identify one editable text object by exact `textSource`, with `text.replace` in `supportedOperations`. Only `fontSizePt` in `(0,300]` and `fill` as `#RRGGBB` are accepted in shared style. Replacement text must contain 1–4096 UTF-16 code units and only BMP characters, matching the current native contract.

`planTextReplacements(queryResult, replacements, style = {})` 是同步的本地计划生成函数，返回 `{ sourceSha256, operations }`；调用 `apply` 时另加新的绝对 `output` 路径。它不修改输入，也不调用引擎。每批 1–100 项 `{from,to}`，按精确 `textSource` 唯一选中一个可编辑且支持 `text.replace` 的文字对象。统一样式仅接受 `(0,300]` 内的 `fontSizePt` 和 `#RRGGBB` 格式的 `fill`。替换文本需为 1–4096 个 UTF-16 码元且仅含 BMP 字符，与原生接口限制一致。

The response must contain all matches: `offset === 0`, `hasMore === false`, and `matched === objects.length`. Uniqueness is scoped to the query's filters and readable `textSource` values. Unmapped text without source text cannot establish equality and is never selected. Names split across objects are not joined. This is not a study detector or a substring/regular-expression replacement API.

查询结果必须完整：`offset === 0`、`hasMore === false` 且 `matched === objects.length`。唯一性仅覆盖查询筛选范围内可读取的 `textSource`；未映射且没有来源文字的对象无法参与等值判断，也不会被选中。跨对象的名称不自动合并；该接口不识别 study 行，也不做子串或正则替换。

Invalid inputs, incomplete pages, duplicate names, missing/ambiguous targets and unsupported targets are collected in `PdfError` with `code: 'INVALID_ARGUMENT'` and `details.issues` (each issue includes `code`, `path`, `message`, and relevant target details). Any issue rejects the entire plan. Font availability, text width and final rendering are not prevalidated by this helper; native `apply` retains its save/reopen, source, object and pixel checks. Reopened glyph verification scans each touched text page once for the whole batch. The helper adds no required agent round trip.

无效输入、分页残缺、名称重复、目标缺失或歧义、目标不支持等问题集中在 `PdfError` 中返回：`code: 'INVALID_ARGUMENT'`、`details.issues`，每项含 `code`、`path`、`message` 和相关目标信息。出现任一问题就拒绝整个计划。该函数不预判字体可用性、字宽或最终渲染；原生 `apply` 保留保存重开、源文件、对象与像素核验。重开后的字形核验对整批每个相关文字页面只扫描一次。辅助函数不要求新增一次 agent 往返。

## Text boundary guards / 文字范围约束

```javascript
const receipt = await editor.apply({ ...plan,
  output: path.resolve('output/renamed.pdf'),
  textBounds: [{ page: labels.page,
    targets: plan.operations.map(operation => operation.target),
    withinRectPt: column }]
});
```

The optional `textBounds` array contains 1–100 groups, each with exactly `page`, nonempty `targets`, and `withinRectPt`. Each target must be a `text.replace` or `text.style` operation on that page in the same batch; one constraint per target. Unknown, duplicate, unedited or path targets are rejected, as is combination with `page.crop`. Regions follow the query rectangle contract. This is independent of the query filter and is never added implicitly. Existing plans without this field behave as before.

可选 `textBounds` 数组含 1–100 组，每组恰好有 `page`、非空 `targets` 和 `withinRectPt`。目标必须是本批该页中的 `text.replace` 或 `text.style` 操作，每个目标只能约束一次。未知、重复、未修改或路径目标均被拒绝，也不能与 `page.crop` 合用。区域遵循查询矩形规则。它与查询筛选独立，不会隐式添加；未提供时保持原有行为。

After saving to a temporary candidate and reopening it, the engine checks the actual text bounds with a 0.0002 pt tolerance. Failure returns `TEXT_OUTSIDE_BOUNDS` with `details.issues` for all failing constrained targets and no final output is published. A normal overflow issue includes `page`, `target`, `boundsPt`, `withinRectPt`, and `overflowPt: {left,top,right,bottom}` in pt. Missing/invalid geometry is also rejected. Passing the guard continues all original text/object/pixel checks. Successful full and compact receipts include `validation.textBounds: {checkedObjects,tolerancePt}`. Native structured error details propagate through the JS API and CLI.

先保存到临时候选文件并重开，再以 0.0002 pt 容差检查实际文字边界。失败返回 `TEXT_OUTSIDE_BOUNDS`，`details.issues` 汇总所有不符合约束的目标，不发布最终文件。普通越界项包含 `page`、`target`、`boundsPt`、`withinRectPt` 及以 pt 计的 `overflowPt: {left,top,right,bottom}`；缺失或非法几何信息也会拒绝。范围检查通过后继续全部原有文字、对象和像素核验。完整及简短成功回执均包含 `validation.textBounds: {checkedObjects,tolerancePt}`。原生结构化错误经 JS API 和 CLI 完整传递。

The guard does not resize, move or abbreviate text. It checks geometric containment only, not overlap between labels, clipping, reading order or typographic quality. Use a suitable rectangle and inspect a preview for layout acceptance.

该约束不缩字号、不移动或缩写文字，只检查几何包含关系，不检查标签之间的重叠、裁剪、阅读顺序或排版质量。应选择合适区域并检查预览。

### Local formatting rule / 本地格式规则

```powershell
node scripts/rename-year-labels.mjs --input "test pdf/figure.pdf" --output "output/renamed.pdf" --within-rect 20,60,150,240 --expected-count 7
```

This narrow example converts selected complete labels from `Author 2020` to `Author (2020)` with ordinary JS. It reports format/count mismatches together before applying and uses the same rectangle as an output guard. `--page` defaults to 0; `--expected-count` is optional (1–100). It prints a compact receipt, does not upload text or call a model, and fails rather than skipping labels whose format differs. Edit the local rule or use an explicit replacement list for other requests; no general rule engine is required.

该窄用途示例以普通 JS 将选中的完整标签从 `Author 2020` 改为 `Author (2020)`，提交前集中报告格式或数量不匹配，并以同一区域约束输出。`--page` 默认为 0，`--expected-count` 可选、范围 1–100。输出简短回执，不上传文字、不调用模型；格式不符合时失败，不静默跳过。其他需求可修改本地规则或提供显式对应表，无需通用规则引擎。

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

## Native phase timings / 原生分阶段耗时

Current source builds add `timingsMs` to successful `inspect`/`query` results and object-edit `apply` receipts. Values are non-overlapping elapsed milliseconds within that native request; repeated phases accumulate. They exclude JS source hashing, IPC serialization, final file publication and model latency, so their sum is not the end-to-end duration. Cached queries measure work actually performed in that request. Replayed receipts retain their original timings. Crop, composition and compact summaries do not include these phase fields.

当前源码构建在成功的 `inspect`/`query` 结果和对象编辑 `apply` 回执中增加 `timingsMs`。各项为本次原生请求内互不重叠的实际毫秒耗时，重复进入同一阶段时累加。不包含 JS 源文件哈希、进程间序列化、最终文件发布及模型耗时，因此总和不等于端到端耗时。缓存查询记录本次实际工作；回执重放保留原始耗时。裁剪、拼版和简短摘要不包含这些阶段字段。

| Request / 请求 | Phases / 阶段 |
|---|---|
| `inspect`, `query` | `objectIndex` (page/object index and ID lookup table), `sourceMapping` (source mapping including probe construction and its 96 dpi render check), `selection` (filtering and projection) |
| Object-edit `apply` / 对象编辑 | `prepare` (plan/font preparation), `sourceMapping`, `patch`, `sourceStreams` (original raw-stream hashes), `save`, `reopen`, `verifyObjects` (saved streams, text bounds, objects and glyphs), `verifyPixels` (144 dpi target pixel gates) |

`bench:edits` stores `firstMappingTimingsMs` and per-edit `phaseStatistics` in its JSON report. `bench:batch` stores `firstQueryTimingsMs` and per-batch `phases`, excluding its warmup apply from phase statistics. Existing total wall-clock measurements remain available; older engines provide no phase data.

`bench:edits` 的 JSON 报告增加 `firstMappingTimingsMs` 和各类编辑的 `phaseStatistics`；`bench:batch` 增加 `firstQueryTimingsMs` 和各批次的 `phases`，阶段统计排除预热修改。原有总耗时测量继续保留；旧引擎不提供对应阶段数据。

## CLI and errors / 命令行与错误

```powershell
node src/cli.mjs --help
node src/cli.mjs apply "test pdf/figure.pdf" plan.json
node src/cli.mjs compose composition.json
```

Plans use the JS API's JSON fields, including absolute output paths. `doctor` checks runtime support and executable presence without starting a worker. Current source builds also provide `doctor({ deep: true })` and `node src/cli.mjs doctor --deep`: these start a worker, verify its version/protocol handshake, then close it. The result includes `ready`, and either `engine` or `error`. `workerStarted` is true once the worker has answered the handshake, even if its version is incompatible. A failed deep CLI check emits the diagnostic result as JSON to stdout and exits with status 1. Worker startup has a 5-second request timeout. The demo additionally exercises PDF reading, editing and rendering.

计划使用 JS API 的 JSON 字段，包括绝对输出路径。`doctor` 检查运行环境和可执行文件是否存在，不启动 worker。当前源码构建还支持 `doctor({ deep: true })` 和 `node src/cli.mjs doctor --deep`：启动 worker、核对版本和协议握手，然后关闭。结果包含 `ready`，以及 `engine` 或 `error`。worker 回答握手后 `workerStarted` 为 true，即使版本不匹配。CLI 深度检查失败时，诊断结果以 JSON 写入 stdout，退出码为 1；启动请求超时为 5 秒。演示进一步验证 PDF 的读取、编辑和渲染。

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
