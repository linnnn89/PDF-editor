#pragma once

// Included after the document/geometry helpers. All edits are against a fresh
// QPDF snapshot; PDFium objects are never used as a write backend.
struct ContentToken { OH value; size_t offset, length; };
struct ContentTokens : OH::ParserCallbacks {
    std::vector<ContentToken> values;
    size_t size = 0;
    void contentSize(size_t n) override { size = n; }
    void handleObject(OH value, size_t offset, size_t length) override {
        require(values.size() < 500000, "RESOURCE_LIMIT", "Content token limit exceeded");
        values.push_back({value, offset, length});
    }
    void handleEOF() override {}
};
std::string decoded(OH stream) {
    auto data = stream.getStreamData(qpdf_dl_specialized);
    require(data->getSize() <= 32 * 1024 * 1024, "RESOURCE_LIMIT", "Decoded stream exceeds 32 MiB");
    return {reinterpret_cast<const char*>(data->getBuffer()), data->getSize()};
}
std::string pageContent(QPDFPageObjectHelper page) {
    std::string result;
    for (auto stream : page.getPageContents()) {
        // Match QPDF's virtual concatenation used by parseContents, including
        // the separator when a previous stream does not end in LF.
        if (!result.empty() && result.back() != '\n') result += '\n';
        result += decoded(stream);
        require(result.size() <= 32 * 1024 * 1024, "RESOURCE_LIMIT", "Page content exceeds 32 MiB");
    }
    return result;
}
struct GraphicsState {
    Matrix ctm{1,0,0,1,0,0};
    std::string font;
    double size = 0, charSpace = 0, wordSpace = 0;
    int renderMode = 0;
    std::string fillSpace = "/DeviceGray cs\n", fillRestore = "0 g\n";
};
struct DrawCommand {
    size_t begin{}, end{};
    std::string op;
    std::vector<OH> args;
    GraphicsState state;
    bool pendingClip = false, inText = false;
};
struct ExpandedFont;
struct FontMap {
    OH dictionary;
    int codeBytes = 0;
    std::map<unsigned, wchar_t> unicode;
    std::map<wchar_t, std::set<unsigned>> observed;
    std::map<wchar_t, unsigned> verifiedCodes;
    std::string reason;
    std::shared_ptr<ExpandedFont> expansion;
};
struct PageMapping {
    std::string content;
    std::vector<DrawCommand> commands;
    std::map<std::string, size_t> targets;
    std::map<std::string, FontMap> fonts;
};
bool pathPaint(const std::string& op) {
    return op == "S" || op == "s" || op == "f" || op == "F" || op == "f*" || op == "B" || op == "B*" || op == "b" || op == "b*";
}
bool stroked(const std::string& op) { return op == "S" || op == "s" || op == "B" || op == "B*" || op == "b" || op == "b*"; }
bool filled(const std::string& op) { return op != "S" && op != "s"; }
std::vector<DrawCommand> drawCommands(QPDFPageObjectHelper page, const std::string& content) {
    ContentTokens parsed; page.parseContents(&parsed);
    require(parsed.size == content.size(), "SOURCE_MAPPING_FAILED", "Decoded content offsets disagree");
    std::vector<DrawCommand> result;
    GraphicsState state; std::vector<GraphicsState> stack;
    std::vector<OH> args; size_t begin = 0;
    bool inText = false, clip = false, inlineImage = false;
    for (auto token : parsed.values) {
        auto value = token.value;
        if (!value.isOperator()) {
            if (args.empty()) begin = token.offset;
            args.push_back(value); continue;
        }
        auto op = value.getOperatorValue();
        if (op == "BI") inlineImage = true;
        if (inlineImage) { if (op == "EI") inlineImage = false; args.clear(); continue; }
        if (args.empty()) begin = token.offset;
        auto numeric = [&](size_t n) { return n < args.size() && args[n].isNumber(); };
        if (op == "q") { require(stack.size() < 256, "RESOURCE_LIMIT", "Graphics state nesting exceeds 256"); stack.push_back(state); }
        else if (op == "Q") { require(!stack.empty(), "SOURCE_MAPPING_FAILED", "Unbalanced graphics state"); state = stack.back(); stack.pop_back(); }
        else if (op == "BT") inText = true;
        else if (op == "ET") inText = false;
        else if (op == "cm" && args.size() == 6 && std::all_of(args.begin(), args.end(), [](OH a) { return a.isNumber(); })) {
            Matrix m{}; for (int i = 0; i < 6; ++i) m[i] = args[i].getNumericValue(); state.ctm = multiply(state.ctm, m);
        } else if (op == "Tf" && args.size() == 2 && args[0].isName() && numeric(1)) {
            state.font = args[0].getName(); state.size = args[1].getNumericValue();
        } else if (op == "Tc" && numeric(0)) state.charSpace = args[0].getNumericValue();
        else if (op == "Tw" && numeric(0)) state.wordSpace = args[0].getNumericValue();
        else if (op == "Tr" && numeric(0)) state.renderMode = args[0].getIntValueAsInt();
        else if (op == "g" || op == "rg" || op == "k" || op == "cs" || op == "sc" || op == "scn") {
            std::string instruction;
            for (auto arg : args) instruction += arg.unparse() + " ";
            instruction += op + "\n";
            if (op == "cs") { state.fillSpace = instruction; state.fillRestore.clear(); }
            else if (op == "sc" || op == "scn") state.fillRestore = state.fillSpace + instruction;
            else {
                state.fillSpace = op == "g" ? "/DeviceGray cs\n" : op == "rg" ? "/DeviceRGB cs\n" : "/DeviceCMYK cs\n";
                state.fillRestore = instruction;
            }
        }
        else if (op == "gs" && args.size() == 1 && args[0].isName()) {
            auto ext = page.getAttribute("/Resources", false).getKey("/ExtGState").getKey(args[0].getName());
            if (ext.isDictionary() && ext.hasKey("/Font")) state.font.clear(); // Explicit Tf is required.
        } else if (op == "\"" && args.size() == 3 && numeric(0) && numeric(1)) {
            state.wordSpace = args[0].getNumericValue(); state.charSpace = args[1].getNumericValue();
        } else if (op == "W" || op == "W*") clip = true;
        if (pathPaint(op) || op == "Tj" || op == "TJ") {
            require(result.size() < 100000, "RESOURCE_LIMIT", "Too many drawing commands");
            result.push_back({begin, token.offset + token.length, op, args, state, clip, inText});
        }
        if (pathPaint(op) || op == "n") clip = false;
        args.clear();
    }
    require(!inlineImage && !inText && stack.empty(), "SOURCE_MAPPING_FAILED", "Unbalanced page content");
    return result;
}
std::vector<OH> textItems(const DrawCommand& cmd) {
    require(cmd.args.size() == 1, "UNSUPPORTED_TEXT", "Expected a single text operand");
    if (cmd.op == "Tj" && cmd.args[0].isString()) return cmd.args;
    require(cmd.op == "TJ" && cmd.args[0].isArray(), "UNSUPPORTED_TEXT", "Unsupported text-show operand");
    return cmd.args[0].getArrayAsVector();
}
unsigned codeNumber(const std::string& bytes) {
    unsigned code = 0;
    for (unsigned char c : bytes) code = (code << 8) | c;
    return code;
}
template<class Accept>
void readUnicodeMap(OH cmap, int codeBytes, Accept accept) {
    ContentTokens parsed; OH::parseContentStream(cmap, &parsed);
    auto& tokens = parsed.values;
    auto put = [&](OH source, OH dest) {
        if (!source.isString() || !dest.isString()) return;
        auto from = source.getStringValue(), to = dest.getStringValue();
        if (from.size() != static_cast<size_t>(codeBytes) || to.size() != 2) return;
        unsigned u = codeNumber(to), c = codeNumber(from);
        if (u >= 0xd800 && u <= 0xdfff) return;
        accept(c, static_cast<wchar_t>(u));
    };
    for (size_t i = 0; i < tokens.size(); ++i) {
        auto v = tokens[i].value;
        if (!v.isOperator()) continue;
        auto op = v.getOperatorValue();
        require(op != "usecmap", "UNSUPPORTED_FONT", "Inherited ToUnicode CMaps are not supported");
        if (op != "beginbfchar" && op != "beginbfrange") continue;
        require(i > 0 && tokens[i-1].value.isInteger(), "UNSUPPORTED_FONT", "Invalid CMap count");
        int n = tokens[i-1].value.getIntValueAsInt();
        require(n >= 0 && n <= 65536, "UNSUPPORTED_FONT", "CMap count is out of range");
        size_t pos = i+1;
        for (int k = 0; k < n; ++k) {
            if (op == "beginbfchar") {
                require(pos+1 < tokens.size(), "UNSUPPORTED_FONT", "Truncated CMap");
                put(tokens[pos].value, tokens[pos+1].value); pos += 2;
            } else {
                require(pos+2 < tokens.size(), "UNSUPPORTED_FONT", "Truncated CMap range");
                auto first = tokens[pos++].value, last = tokens[pos++].value, dest = tokens[pos++].value;
                require(first.isString() && last.isString(), "UNSUPPORTED_FONT", "Invalid CMap range");
                auto start = first.getStringValue(), end = last.getStringValue();
                require(start.size() <= 2 && start.size() == end.size(), "UNSUPPORTED_FONT", "Unsupported CMap code length");
                unsigned a = codeNumber(start), b = codeNumber(end);
                require(b >= a && b-a < 65536, "UNSUPPORTED_FONT", "Invalid CMap range");
                for (unsigned code = a; code <= b; ++code) {
                    std::string raw = start; unsigned c = code;
                    for (int j = static_cast<int>(raw.size())-1; j >= 0; --j) { raw[j] = static_cast<char>(c & 255); c >>= 8; }
                    OH target = OH::newNull();
                    if (dest.isArray() && code-a < static_cast<unsigned>(dest.getArrayNItems())) target = dest.getArrayItem(static_cast<int>(code-a));
                    else if (dest.isString() && dest.getStringValue().size() == 2) {
                        unsigned u = codeNumber(dest.getStringValue()) + code-a;
                        if (u <= 65535) target = OH::newString(std::string{static_cast<char>(u >> 8), static_cast<char>(u & 255)});
                    }
                    put(OH::newString(raw), target);
                }
            }
        }
    }
}
FontMap readFont(OH font) {
    FontMap result; result.dictionary = font;
    try {
        require(font.isDictionary(), "UNSUPPORTED_FONT", "Missing font dictionary");
        auto subtype = font.getKey("/Subtype");
        bool cid = subtype.isNameAndEquals("/Type0");
        require(cid || subtype.isNameAndEquals("/Type1") || subtype.isNameAndEquals("/TrueType"), "UNSUPPORTED_FONT", "Only simple Type1/TrueType and Identity-H fonts are supported");
        require(!cid || font.getKey("/Encoding").isNameAndEquals("/Identity-H"), "UNSUPPORTED_FONT", "Only horizontal Identity-H CID encoding is supported");
        result.codeBytes = cid ? 2 : 1;
        auto cmap = font.getKey("/ToUnicode");
        if (cmap.isStream()) {
            readUnicodeMap(cmap, result.codeBytes, [&](unsigned c, wchar_t u) {
                require(!result.unicode.contains(c) || result.unicode.at(c) == u, "UNSUPPORTED_FONT", "Conflicting ToUnicode entries");
                result.unicode[c] = u;
            });
        } else {
            require(!cid, "UNSUPPORTED_FONT", "CID font has no ToUnicode map");
            auto encoding = font.getKey("/Encoding"), base = font.getKey("/BaseFont");
            bool win = encoding.isNameAndEquals("/WinAnsiEncoding");
            bool standard = encoding.isNull() || encoding.isNameAndEquals("/StandardEncoding");
            require(win || (standard && base.isName() && (base.getName().find("Helvetica") != std::string::npos || base.getName().find("Times") != std::string::npos || base.getName().find("Courier") != std::string::npos)), "UNSUPPORTED_FONT", "Font encoding requires a ToUnicode map");
            for (unsigned c = 32; c <= (win ? 255u : 126u); ++c) {
                wchar_t u{}; char byte = static_cast<char>(c);
                if (win) { if (MultiByteToWideChar(1252, MB_ERR_INVALID_CHARS, &byte, 1, &u, 1) != 1) continue; }
                else u = static_cast<wchar_t>(c == 39 ? 0x2019 : c == 96 ? 0x2018 : c);
                result.unicode[c] = u;
            }
        }
        require(!result.unicode.empty(), "UNSUPPORTED_FONT", "No supported single-Unicode glyph mappings");
    } catch (const Failure& e) { result.reason = e.what(); result.codeBytes = 0; }
    return result;
}
std::vector<unsigned> charCodes(const std::vector<OH>& items, const FontMap& font) {
    require(font.codeBytes > 0, "UNSUPPORTED_FONT", font.reason);
    std::vector<unsigned> codes;
    for (auto item : items) {
        if (item.isNumber()) continue;
        require(item.isString(), "UNSUPPORTED_TEXT", "TJ must contain only strings and numbers");
        auto bytes = item.getStringValue();
        require(bytes.size() % font.codeBytes == 0, "UNSUPPORTED_TEXT", "Incomplete character code");
        for (size_t i = 0; i < bytes.size(); i += font.codeBytes) {
            auto code = codeNumber(bytes.substr(i, font.codeBytes));
            require(font.unicode.contains(code), "UNSUPPORTED_TEXT", "A character has no verified single-Unicode mapping");
            codes.push_back(code);
        }
    }
    return codes;
}
std::string sourceText(const DrawCommand& cmd, const FontMap& font) {
    std::wstring text;
    for (auto code : charCodes(textItems(cmd), font)) text += font.unicode.at(code);
    return utf8(text.data(), static_cast<int>(text.size()));
}
double uniformScale(const Matrix& m, double unit) {
    double x = std::hypot(m[0], m[1]), y = std::hypot(m[2], m[3]);
    if (x <= 0 || std::abs(x-y) > 1e-6 * std::max(x,y) || std::abs(m[0]*m[2]+m[1]*m[3]) > 1e-6*x*y) return 0;
    return x*unit;
}
J fingerprint(J item) {
    for (const char* key : {"id", "depth", "sourceMapping", "editable", "supportedOperations", "editReason", "textSource", "reusableCharacters", "strokeWidthPt", "sourceCommand"}) item.erase(key);
    return item;
}
struct Raster {
    int width, height;
    std::vector<unsigned char> bytes;
    Raster(Document& doc, int pageNo, double dpi) {
        auto g = geometry(doc.pages.at(pageNo));
        double w = std::ceil(g.width*dpi/72), h = std::ceil(g.height*dpi/72);
        require(w > 0 && h > 0 && w*h <= 40000000, "RESOURCE_LIMIT", "Verification render exceeds 40 megapixels");
        width = static_cast<int>(w); height = static_cast<int>(h);
        auto bitmap = FPDFBitmap_Create(width, height, 1);
        require(bitmap != nullptr, "RENDER_FAILED", "Could not allocate verification bitmap");
        try {
            FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
            FPDF_RenderPageBitmap(bitmap, doc.load(pageNo).page, 0, 0, width, height, 0, FPDF_ANNOT);
            auto buffer = static_cast<unsigned char*>(FPDFBitmap_GetBuffer(bitmap)); int stride = FPDFBitmap_GetStride(bitmap);
            bytes.resize(static_cast<size_t>(width)*height*4);
            for (int y = 0; y < height; ++y) std::copy_n(buffer+static_cast<size_t>(stride)*y, static_cast<size_t>(width)*4, bytes.data()+static_cast<size_t>(width)*y*4);
        } catch (...) { FPDFBitmap_Destroy(bitmap); throw; }
        FPDFBitmap_Destroy(bitmap);
    }
};
std::shared_ptr<Buffer> memoryPDF(QPDF& q) {
    QPDFWriter writer(q); writer.setOutputMemory(); writer.setCompressStreams(false); writer.setDecodeLevel(qpdf_dl_none); writer.write();
    return writer.getBufferSharedPointer();
}
void ensureMapping(Document& doc, int index) {
    auto& all = objects(doc, index); auto& loaded = doc.load(index);
    if (loaded.mapping) return;
    auto mapping = std::make_shared<PageMapping>();
    try {
        writable(doc);
        mapping->content = pageContent(doc.pages.at(index));
        mapping->commands = drawCommands(doc.pages.at(index), mapping->content);
        std::string key = "APE" + doc.sha.substr(0, 16);
        require(mapping->content.find(key) == std::string::npos, "SOURCE_MAPPING_FAILED", "Probe marker conflicts with source");
        std::string instrumented; size_t cursor = 0;
        for (size_t i = 0; i < mapping->commands.size(); ++i) {
            const auto& cmd = mapping->commands[i];
            instrumented += mapping->content.substr(cursor, cmd.begin-cursor);
            instrumented += "\n/Artifact << /" + key + " " + std::to_string(i) + " >> BDC\n";
            instrumented += mapping->content.substr(cmd.begin, cmd.end-cmd.begin) + "\nEMC\n";
            cursor = cmd.end;
        }
        instrumented += mapping->content.substr(cursor);
        QPDF probePDF; probePDF.setSuppressWarnings(true); probePDF.processMemoryFile("probe.pdf", doc.bytes.data(), doc.bytes.size());
        auto pages = QPDFPageDocumentHelper::get(probePDF).getAllPages();
        pages.at(index).getObjectHandle().replaceKey("/Contents", probePDF.newStream(instrumented));
        Document probe(memoryPDF(probePDF));
        const auto& probeObjects = objects(probe, index);
        // The temporary tags must not alter the rendered page at all.
        require(Raster(doc, index, 96).bytes == Raster(probe, index, 96).bytes, "SOURCE_MAPPING_FAILED", "Instrumented page is not visually identical");
        std::map<std::string, std::vector<size_t>> originalByShape, probeByShape;
        for (size_t i = 0; i < all.size(); ++i) if (all[i]["depth"] == 0) originalByShape[fingerprint(all[i]).dump()].push_back(i);
        for (size_t i = 0; i < probeObjects.size(); ++i) if (probeObjects[i]["depth"] == 0) probeByShape[fingerprint(probeObjects[i]).dump()].push_back(i);
        std::map<int, std::vector<size_t>> byCommand;
        std::map<size_t, size_t> commandsPerObject;
        for (int i = 0; i < FPDFPage_CountObjects(probe.load(index).page); ++i) {
            auto obj = FPDFPage_GetObject(probe.load(index).page, i);
            for (int k = 0; k < FPDFPageObj_CountMarks(obj); ++k) {
                int command = -1;
                if (FPDFPageObjMark_GetParamIntValue(FPDFPageObj_GetMark(obj, k), key.c_str(), &command) && command >= 0 && command < static_cast<int>(mapping->commands.size())) {
                    byCommand[command].push_back(static_cast<size_t>(i)); ++commandsPerObject[static_cast<size_t>(i)];
                }
            }
        }
        auto resources = doc.pages.at(index).getAttribute("/Resources", false).getKey("/Font");
        for (const auto& cmd : mapping->commands) if (cmd.op == "Tj" || cmd.op == "TJ") {
            if (!mapping->fonts.contains(cmd.state.font)) mapping->fonts[cmd.state.font] = readFont(resources.getKey(cmd.state.font));
            auto& font = mapping->fonts.at(cmd.state.font);
            try { for (auto c : charCodes(textItems(cmd), font)) font.observed[font.unicode.at(c)].insert(c); } catch (const Failure&) {}
        }
        auto g = geometry(doc.pages.at(index));
        for (const auto& [commandNo, probeIndices] : byCommand) {
            if (probeIndices.size() != 1 || commandsPerObject[probeIndices.front()] != 1) continue;
            // Top-level IDs equal the PDFium enumeration index, while the JSON
            // list also includes nested Form children. Resolve by ID explicitly.
            std::string probeId = "p" + std::to_string(index) + "/" + std::to_string(probeIndices.front());
            auto found = std::find_if(probeObjects.begin(), probeObjects.end(), [&](const J& v) { return v["id"] == probeId; });
            if (found == probeObjects.end()) continue;
            auto shape = fingerprint(*found).dump();
            if (originalByShape[shape].size() != 1 || probeByShape[shape].size() != 1) continue;
            auto& item = all[originalByShape.at(shape).front()];
            const auto& cmd = mapping->commands[commandNo];
            item["sourceMapping"] = "verified"; item["sourceCommand"] = commandNo; item["supportedOperations"] = J::array();
            try {
                if (item["type"] == "text") {
                    require(cmd.inText && cmd.state.size > 0 && cmd.state.renderMode == 0, "UNSUPPORTED_TEXT", "Only visible fill text with a positive explicit font size is editable");
                    auto& font = mapping->fonts.at(cmd.state.font);
                    item["textSource"] = sourceText(cmd, font);
                    std::wstring reuse;
                    for (const auto& [u, codes] : font.observed) if (codes.size() == 1) reuse += u;
                    item["reusableCharacters"] = utf8(reuse.data(), static_cast<int>(reuse.size()));
                    item["supportedOperations"] = {"text.replace", "text.style"};
                } else if (item["type"] == "path") {
                    require(!cmd.pendingClip, "UNSUPPORTED_PATH", "Painting also installs a clipping path");
                    double scale = uniformScale(cmd.state.ctm, g.unit);
                    if (scale > 0) item["strokeWidthPt"] = item["strokeWidthRaw"].get<double>() * scale;
                    item["supportedOperations"] = {"path.style"};
                } else continue;
                item["editable"] = true; mapping->targets[item["id"].get<std::string>()] = commandNo;
            } catch (const Failure& e) { item["editReason"] = e.what(); }
        }
        for (auto& item : all) if (!item["editable"].get<bool>() && !item.contains("editReason")) item["editReason"] = "No unique top-level text/path command mapping";
    } catch (const std::exception& e) {
        mapping->targets.clear();
        for (auto& item : all) { item["editable"] = false; item["sourceMapping"] = "unmapped"; item["supportedOperations"] = J::array(); item["editReason"] = e.what(); }
    }
    loaded.mapping = std::move(mapping);
}

double glyphWidth(FontMap& font, unsigned code, FPDF_FONT rendered) {
    // PDFium rounds PDF font widths to integers internally. Use the renderer's
    // actual metrics, including fractional /Widths and /W inputs, so restoring
    // the cursor matches the source as this renderer originally interpreted it.
    auto unicode = font.unicode.at(code);
    require(std::count_if(font.unicode.begin(), font.unicode.end(), [&](const auto& pair) { return pair.second == unicode; }) == 1,
            "UNSUPPORTED_FONT", "Unicode maps to multiple font codes; metric lookup is ambiguous");
    float width = 0;
    require(FPDFFont_GetGlyphWidth(rendered, unicode, 1000, &width) && std::isfinite(width) && width >= 0 && width < 1000000,
            "UNSUPPORTED_FONT", "Cannot read verified glyph width");
    return width;
}
#include "font_extension.h"
double advance(const std::vector<OH>& items, FontMap& font, const GraphicsState& state, double size, FPDF_FONT rendered) {
    double result = 0;
    for (auto item : items) {
        if (item.isNumber()) { result -= item.getNumericValue()*size/1000; continue; }
        for (auto code : charCodes({item}, font)) result += glyphWidth(font, code, rendered)*size/1000 + state.charSpace + (font.codeBytes == 1 && code == 32 ? state.wordSpace : 0);
    }
    require(std::isfinite(result), "UNSUPPORTED_TEXT", "Non-finite text advance");
    return result;
}
std::string decimal(double value) {
    require(std::isfinite(value) && std::abs(value) < 1e12, "INVALID_ARGUMENT", "PDF number is out of range");
    return OH::newReal(value, 10).unparse();
}
std::array<unsigned, 3> rgb(const J& value) {
    require(value.is_string(), "INVALID_ARGUMENT", "Color must be #RRGGBB");
    auto text = value.get<std::string>();
    require(text.size() == 7 && text[0] == '#' && text.find_first_not_of("0123456789abcdefABCDEF", 1) == std::string::npos, "INVALID_ARGUMENT", "Color must be #RRGGBB");
    return {static_cast<unsigned>(std::stoul(text.substr(1,2), nullptr,16)), static_cast<unsigned>(std::stoul(text.substr(3,2), nullptr,16)), static_cast<unsigned>(std::stoul(text.substr(5,2), nullptr,16))};
}
std::string colorCommand(const J& value, bool stroke) {
    auto c = rgb(value); return decimal(c[0]/255.) + " " + decimal(c[1]/255.) + " " + decimal(c[2]/255.) + (stroke ? " RG\n" : " rg\n");
}
void fields(const J& op, const std::set<std::string>& allowed) {
    for (const auto& [key, value] : op.items()) require(allowed.contains(key), "INVALID_ARGUMENT", "Unknown operation field: " + key);
}
struct PreparedEdit { size_t begin, end; std::string patch, target; J expected, fontExpansion, fontReuse; };
PreparedEdit prepareEdit(Document& doc, int pageNo, const J& op, QPDF& candidate, QPDFPageObjectHelper candidatePage) {
    auto& mapping = *doc.load(pageNo).mapping;
    std::string target = op.at("target"), kind = op.at("op");
    require(mapping.targets.contains(target), "OBJECT_NOT_EDITABLE", "Target has no supported, unique source mapping: " + target);
    const auto& cmd = mapping.commands.at(mapping.targets.at(target));
    auto& list = objects(doc, pageNo);
    auto it = std::find_if(list.begin(), list.end(), [&](const J& i) { return i["id"] == target; });
    require(it != list.end(), "OBJECT_NOT_FOUND", "Object is not on the requested page");
    J before = *it, expected = J::object(), fontExpansion, fontReuse;
    std::string patch = "\n";
    if (kind == "path.style") {
        patch += "q\n";
        fields(op, {"op", "page", "target", "strokeWidthPt", "stroke", "fill"});
        require(before["type"] == "path" && pathPaint(cmd.op), "WRONG_OBJECT_TYPE", "path.style requires a path");
        require(op.contains("strokeWidthPt") || op.contains("stroke") || op.contains("fill"), "INVALID_ARGUMENT", "No path style change requested");
        if (op.contains("strokeWidthPt")) {
            require(stroked(cmd.op), "INVALID_ARGUMENT", "This path is not stroked");
            double width = number(op["strokeWidthPt"], "strokeWidthPt"), scale = uniformScale(cmd.state.ctm, geometry(doc.pages.at(pageNo)).unit);
            require(width >= 0 && width <= 100 && scale > 0, "UNSUPPORTED_PATH", "Physical line width requires a uniform CTM and a width in [0,100] pt");
            double raw = width/scale; patch += decimal(raw) + " w\n"; expected["strokeWidthRaw"] = raw;
        }
        for (auto key : {"stroke", "fill"}) if (op.contains(key)) {
            bool stroke = std::string(key) == "stroke";
            require(stroke ? stroked(cmd.op) : filled(cmd.op), "INVALID_ARGUMENT", "Requested paint component is not used by this path");
            patch += colorCommand(op[key], stroke); expected[key] = rgb(op[key]);
        }
        patch += mapping.content.substr(cmd.begin, cmd.end-cmd.begin) + "\nQ\n";
    } else {
        fields(op, {"op", "page", "target", "expect", "value", "fontSizePt", "fill"});
        require(before["type"] == "text", "WRONG_OBJECT_TYPE", "Text operation requires a text object");
        require(op.contains("expect") && op["expect"].is_object() && op["expect"].size() == 1 && op["expect"].contains("text") && op["expect"]["text"] == before["textSource"], "PRECONDITION_FAILED", "expect.text must match the inspected textSource exactly");
        require(kind == "text.replace" ? op.contains("value") : !op.contains("value"), "INVALID_ARGUMENT", "Only text.replace accepts and requires value");
        require(kind == "text.replace" || op.contains("fontSizePt") || op.contains("fill"), "INVALID_ARGUMENT", "No text style change requested");
        auto& font = mapping.fonts.at(cmd.state.font);
        int nativeIndex = std::stoi(target.substr(target.find('/')+1));
        auto rendered = FPDFTextObj_GetFont(FPDFPage_GetObject(doc.load(pageNo).page, nativeIndex));
        FontMap* writingFont = &font;
        FPDF_FONT writingRendered = rendered;
        std::string writingResource = cmd.state.font;
        auto items = textItems(cmd), next = items;
        size_t prefixEnd = 0, suffixBegin = items.size();
        double prefixAdjustment = 0, suffixAdjustment = 0;
        // Leading TJ numbers position the first glyph, unlike kerning between
        // glyphs. Empty strings do not end this positioning prefix.
        for (auto item : items) {
            if (item.isNumber()) prefixAdjustment += item.getNumericValue();
            else if (!item.isString() || !item.getStringValue().empty()) break;
            ++prefixEnd;
        }
        while (suffixBegin > prefixEnd) {
            auto item = items[suffixBegin - 1];
            if (item.isNumber()) suffixAdjustment += item.getNumericValue();
            else if (!item.isString() || !item.getStringValue().empty()) break;
            --suffixBegin;
        }
        if (kind == "text.replace") {
            auto text = wide(op.at("value").get<std::string>());
            require(!text.empty() && text.size() <= 4096, "INVALID_ARGUMENT", "Replacement must contain 1 to 4096 UTF-16 code units");
            require(std::none_of(text.begin(), text.end(), [](wchar_t u) { return u >= 0xd800 && u <= 0xdfff; }), "UNSUPPORTED_TEXT", "Replacement currently supports BMP characters only");
            bool reusable = std::all_of(text.begin(), text.end(), [&](wchar_t u) {
                return (font.observed.contains(u) && font.observed.at(u).size() == 1) || font.verifiedCodes.contains(u);
            });
            if (!reusable) {
                auto complete = expandFont(font, rendered, text);
                if (verifyExistingFontCodes(font, rendered, *complete, text)) {
                    fontReuse = complete->evidence;
                    fontReuse["resource"] = writingResource;
                    fontReuse["encodingGlyphsAndWidthsVerified"] = true;
                } else {
                writingFont = &complete->map; writingRendered = complete->rendered;
                auto resources = candidatePage.getAttribute("/Resources", false).shallowCopy();
                auto fonts = resources.getKey("/Font").shallowCopy();
                int serial = 1;
                do { writingResource = "/APEFont" + std::to_string(serial++); } while (fonts.hasKey(writingResource));
                fonts.replaceKey(writingResource, candidate.copyForeignObject(complete->map.dictionary));
                resources.replaceKey("/Font", fonts); candidatePage.getObjectHandle().replaceKey("/Resources", resources);
                fontExpansion = complete->evidence;
                fontExpansion["resource"] = writingResource;
                std::set<wchar_t> added;
                for (auto u : text) if (!font.observed.contains(u)) added.insert(u);
                std::wstring characters(added.begin(), added.end());
                fontExpansion["addedCharacters"] = utf8(characters.data(), static_cast<int>(characters.size()));
                expected["font"] = complete->evidence["postScriptName"];
                expected["fontEmbedded"] = true;
                }
            }
            std::string encoded;
            for (auto u : text) {
                unsigned code = 0;
                if (writingFont == &font) code = font.verifiedCodes.contains(u) ? font.verifiedCodes.at(u) : *font.observed.at(u).begin();
                else code = std::find_if(writingFont->unicode.begin(), writingFont->unicode.end(), [&](const auto& pair) { return pair.second == u; })->first;
                if (writingFont->codeBytes == 2) encoded += static_cast<char>(code >> 8);
                encoded += static_cast<char>(code & 255);
            }
            next = {OH::newString(encoded)}; expected["textSource"] = op["value"];
        } else expected["textSource"] = before["textSource"];
        double size = cmd.state.size;
        if (op.contains("fontSizePt")) {
            double pt = number(op["fontSizePt"], "fontSizePt");
            require(pt > 0 && pt <= 300 && before["fontSizeYPt"].get<double>() > 0, "INVALID_ARGUMENT", "Font size must be in (0,300] pt");
            size = cmd.state.size * pt/before["fontSizeYPt"].get<double>(); expected["fontSizeYPt"] = pt;
        }
        double positioningScale = cmd.state.size / size;
        if (kind == "text.replace") {
            // PDFium ignores terminal TJ kerning when an empty string occurs
            // anywhere in the array. Retain that property on replacement and
            // keep the original terminal displacement constant across sizes.
            if (std::any_of(items.begin(), items.end(), [](auto item) { return item.isString() && item.getStringValue().empty(); }))
                next.insert(next.begin(), OH::newString(""));
            if (prefixAdjustment != 0) next.insert(next.begin(), OH::newReal(prefixAdjustment * positioningScale, 10));
            if (suffixAdjustment != 0) next.push_back(OH::newReal(suffixAdjustment * positioningScale, 10));
        } else if (size != cmd.state.size) {
            for (size_t i = 0; i < next.size(); ++i) if ((i < prefixEnd || i >= suffixBegin) && next[i].isNumber())
                next[i] = OH::newReal(next[i].getNumericValue() * positioningScale, 10);
        }
        // Tw applies to byte 32 only. Preserve its spacing when a simple font
        // becomes a two-byte CID font by placing the advance in the TJ array.
        if (writingFont != &font && font.codeBytes == 1 && font.unicode.contains(32) && font.unicode.at(32) == L' ' && cmd.state.wordSpace != 0) {
            std::vector<OH> spaced;
            for (auto item : next) {
                if (!item.isString()) { spaced.push_back(item); continue; }
                std::string chunk;
                auto codes = charCodes({item}, *writingFont);
                for (size_t i = 0; i < codes.size(); ++i) {
                    auto code = codes[i];
                    chunk += static_cast<char>(code >> 8); chunk += static_cast<char>(code & 255);
                    // Terminal Tw positions no glyph. Leave it to the final
                    // cursor compensation, avoiding renderer-specific handling
                    // of a trailing numeric TJ after an empty source string.
                    if (writingFont->unicode.at(code) == L' ' && i+1 < codes.size()) {
                        spaced.push_back(OH::newString(chunk)); chunk.clear();
                        spaced.push_back(OH::newReal(-cmd.state.wordSpace*1000/size, 10));
                    }
                }
                if (!chunk.empty()) spaced.push_back(OH::newString(chunk));
                else if (item.getStringValue().empty()) spaced.push_back(item);
            }
            next = std::move(spaced);
        }
        patch += writingResource + " " + decimal(size) + " Tf\n";
        if (op.contains("fill")) {
            require(!cmd.state.fillRestore.empty(), "UNSUPPORTED_TEXT", "Original fill state cannot be restored exactly");
            patch += colorCommand(op["fill"], false); expected["fill"] = rgb(op["fill"]);
        }
        double oldAdvance = advance(items, font, cmd.state, cmd.state.size, rendered), newAdvance = advance(next, *writingFont, cmd.state, size, writingRendered);
        // Do not insert q/Q inside BT/ET. Restore only the parameters changed
        // here and compensate TJ advance, leaving the next text cursor intact.
        patch += "[";
        for (auto item : next) patch += item.unparse() + " ";
        // A numeric-only TJ is handled even when the preceding array contains
        // empty strings. Appending compensation to that array can lose it.
        patch += "] TJ\n[" + decimal((newAdvance-oldAdvance)*1000/size) + "] TJ\n";
        patch += cmd.state.font + " " + decimal(cmd.state.size) + " Tf\n";
        if (op.contains("fill")) patch += cmd.state.fillRestore;
    }
    return {cmd.begin, cmd.end, patch, target, expected, fontExpansion, fontReuse};
}
J pixelGate(Document& before, Document& after, int pageNo, const std::vector<std::pair<J,J>>& changed) {
    Raster a(before, pageNo, 144), b(after, pageNo, 144);
    require(a.width == b.width && a.height == b.height, "VERIFY_FAILED", "Rendered page dimensions changed");
    auto g = geometry(before.pages.at(pageNo));
    std::vector<unsigned char> mask(static_cast<size_t>(a.width)*a.height, 0);
    for (const auto& pair : changed) for (auto item : {pair.first, pair.second}) {
        require(item.contains("boundsPt"), "VERIFY_FAILED", "Edited object has no bounds");
        auto r = item["boundsPt"];
        double x = r["x"], y = r["y"], w = r["width"], h = r["height"];
        // A fixed renderer-derived 3-pixel AA margin, never supplied by the agent.
        int left = std::clamp(static_cast<int>(std::floor(x*a.width/g.width))-3, 0, a.width);
        int top = std::clamp(static_cast<int>(std::floor(y*a.height/g.height))-3, 0, a.height);
        int right = std::clamp(static_cast<int>(std::ceil((x+w)*a.width/g.width))+3, 0, a.width);
        int bottom = std::clamp(static_cast<int>(std::ceil((y+h)*a.height/g.height))+3, 0, a.height);
        for (int row = top; row < bottom; ++row) std::fill(mask.begin()+static_cast<size_t>(row)*a.width+left, mask.begin()+static_cast<size_t>(row)*a.width+right, static_cast<unsigned char>(1));
    }
    size_t insideChanges = 0, outsideChanges = 0, masked = 0;
    for (size_t i = 0; i < mask.size(); ++i) {
        masked += mask[i];
        if (!std::equal(a.bytes.begin()+i*4, a.bytes.begin()+i*4+4, b.bytes.begin()+i*4)) { if (mask[i]) ++insideChanges; else ++outsideChanges; }
    }
    require(outsideChanges == 0, "VISUAL_DIFF_OUTSIDE_TARGET", "Pixels outside edited object bounds changed: " + std::to_string(outsideChanges));
    return {{"page", pageNo}, {"dpi", 144}, {"changedPixelsInside", insideChanges}, {"changedPixelsOutside", outsideChanges}, {"maskedPixels", masked}, {"totalPixels", mask.size()}, {"marginPixels", 3}};
}
bool nearJson(const J& a, const J& b) {
    if (a.is_number() && b.is_number()) return std::abs(a.get<double>()-b.get<double>()) <= 0.0002;
    if (a.is_object() && b.is_object()) {
        if (a.size() != b.size()) return false;
        for (const auto& [k,v] : a.items()) if (!b.contains(k) || !nearJson(v,b[k])) return false;
        return true;
    }
    if (a.is_array() && b.is_array()) {
        if (a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i) if (!nearJson(a[i],b[i])) return false;
        return true;
    }
    return a == b;
}
std::map<std::string, std::string> actualGlyphTexts(LoadedPage& page, const std::map<std::string, J>& expected) {
    std::map<FPDF_PAGEOBJECT, std::pair<std::string, std::wstring>> targets;
    for (const auto& [id, value] : expected) if (value.contains("textSource")) {
        auto obj = FPDFPage_GetObject(page.page, std::stoi(id.substr(id.find('/')+1)));
        targets.emplace(obj, std::make_pair(id, std::wstring{}));
    }
    std::map<std::string, std::string> result;
    if (targets.empty()) return result;
    int count = FPDFText_CountChars(page.text);
    require(count >= 0 && count <= 1000000, "RESOURCE_LIMIT", "Verification character limit exceeded");
    // Group only requested objects from the reopened page in one ordered scan.
    // PDFium-generated separators are excluded; real spaces remain glyphs.
    for (int i = 0; i < count; ++i) {
        auto target = targets.find(FPDFText_GetTextObject(page.text, i));
        if (target == targets.end() || FPDFText_IsGenerated(page.text, i) != 0) continue;
        unsigned u = FPDFText_GetUnicode(page.text, i);
        require(u <= 65535, "UNSUPPORTED_TEXT", "Non-BMP verification is not supported");
        target->second.second += static_cast<wchar_t>(u);
    }
    for (const auto& [obj, entry] : targets) {
        const auto& [id, text] = entry;
        result.emplace(id, utf8(text.data(), static_cast<int>(text.size())));
    }
    return result;
}
J applyEdits(Document& original, const J& request) {
    const auto& operations = request.at("operations");
    require(operations.is_array() && !operations.empty() && operations.size() <= 100, "INVALID_ARGUMENT", "Provide 1 to 100 operations");
    struct TextBoundsTarget { int page; std::string target; Rect region; };
    std::vector<TextBoundsTarget> textBounds;
    if (request.contains("textBounds")) {
        const auto& groups = request.at("textBounds");
        require(groups.is_array() && !groups.empty() && groups.size() <= 100, "INVALID_ARGUMENT", "Provide 1 to 100 textBounds groups");
        require(std::none_of(operations.begin(), operations.end(), [](const J& op) { return op.value("op", "") == "page.crop"; }),
                "INVALID_ARGUMENT", "textBounds cannot be combined with page.crop");
        std::set<std::string> constrained;
        for (const auto& group : groups) {
            require(group.is_object() && group.size() == 3 && group.contains("page") && group.contains("targets") && group.contains("withinRectPt"),
                    "INVALID_ARGUMENT", "Each textBounds group must contain exactly page, targets and withinRectPt");
            int pageNo = integer(group.at("page"), "page", static_cast<int>(original.pages.size())-1);
            auto region = regionRect(group.at("withinRectPt"));
            auto g = geometry(original.pages.at(pageNo)); inside(region, g.width, g.height);
            const auto& ids = group.at("targets");
            require(ids.is_array() && !ids.empty(), "INVALID_ARGUMENT", "textBounds targets must be a nonempty string array");
            for (const auto& id : ids) {
                require(id.is_string() && !id.get_ref<const std::string&>().empty(), "INVALID_ARGUMENT", "textBounds targets must be nonempty strings");
                auto target = id.get<std::string>();
                require(constrained.insert(target).second, "INVALID_ARGUMENT", "A target may only have one textBounds constraint");
                require(std::any_of(operations.begin(), operations.end(), [&](const J& op) {
                    return op.is_object() && op.contains("page") && op.at("page") == pageNo && op.contains("target") && op.at("target") == id
                        && (op.value("op", "") == "text.replace" || op.value("op", "") == "text.style");
                }), "INVALID_ARGUMENT", "textBounds target must be a text edit in this batch on the specified page: " + target);
                textBounds.push_back({pageNo, target, region});
            }
        }
    }
    if (std::all_of(operations.begin(), operations.end(), [](const J& op) { return op.value("op", "") == "page.crop"; })) return crop(original, request);
    writable(original);
    QPDF candidate; candidate.setSuppressWarnings(true); candidate.processMemoryFile("candidate.pdf", original.bytes.data(), original.bytes.size());
    preserveStreamEncoding(candidate);
    auto pages = QPDFPageDocumentHelper::get(candidate).getAllPages();
    std::map<int, std::vector<PreparedEdit>> edits;
    std::set<std::string> targets;
    for (const auto& op : operations) {
        auto kind = op.at("op").get<std::string>();
        require(kind == "text.replace" || kind == "text.style" || kind == "path.style", "UNSUPPORTED_OPERATION", "Use a separate batch for crop; supported object edits: text.replace, text.style, path.style");
        int pageNo = integer(op.at("page"), "page", static_cast<int>(original.pages.size())-1);
        ensureMapping(original, pageNo);
        auto target = op.at("target").get<std::string>();
        require(targets.insert(target).second, "INVALID_ARGUMENT", "Combine a target's text/style changes in one operation");
        edits[pageNo].push_back(prepareEdit(original, pageNo, op, candidate, pages.at(pageNo)));
    }
    std::map<int, std::string> expectedContents;
    for (auto& [pageNo, list] : edits) {
        auto content = original.load(pageNo).mapping->content;
        std::sort(list.begin(), list.end(), [](const PreparedEdit& a, const PreparedEdit& b) { return a.begin > b.begin; });
        for (const auto& edit : list) content.replace(edit.begin, edit.end-edit.begin, edit.patch);
        // Replace only this page's reference. Font additions use a private
        // resource dictionary; original streams and other pages stay intact.
        pages.at(pageNo).getObjectHandle().replaceKey("/Contents", candidate.newStream(content));
        expectedContents[pageNo] = std::move(content);
    }
    auto beforeHashes = streamHashes(original.qpdf);
    auto output = request.at("output").get<std::string>(); save(candidate, output, true);
    Document check(output);
    require(check.pages.size() == original.pages.size(), "VERIFY_FAILED", "Page count changed");
    auto afterHashes = streamHashes(check.qpdf);
    require(std::includes(afterHashes.begin(), afterHashes.end(), beforeHashes.begin(), beforeHashes.end()), "VERIFY_FAILED", "An original content/resource stream changed");
    if (request.contains("textBounds")) {
        J issues = J::array();
        for (const auto& constraint : textBounds) {
            const auto& after = objects(check, constraint.page);
            auto found = std::find_if(after.begin(), after.end(), [&](const J& item) { return item.at("id") == constraint.target; });
            J issue = {{"page", constraint.page}, {"target", constraint.target}, {"withinRectPt", constraint.region.json()}};
            if (found == after.end() || !found->contains("boundsPt")) {
                issue["code"] = "MISSING_BOUNDS"; issue["boundsPt"] = nullptr; issues.push_back(issue); continue;
            }
            issue["boundsPt"] = found->at("boundsPt");
            Rect bounds{};
            try { bounds = regionRect(found->at("boundsPt")); }
            catch (const std::exception&) { issue["code"] = "INVALID_BOUNDS"; issues.push_back(issue); continue; }
            const auto& r = constraint.region;
            double left = std::max(0., r.x-bounds.x), top = std::max(0., r.y-bounds.y);
            double right = std::max(0., bounds.x+bounds.w-r.x-r.w), bottom = std::max(0., bounds.y+bounds.h-r.y-r.h);
            // Physical geometry tolerance only; pixelGate's AA margin does not apply.
            if (std::max({left, top, right, bottom}) > boundsTolerancePt) {
                issue["code"] = "TEXT_OUTSIDE_BOUNDS";
                issue["overflowPt"] = {{"left", left}, {"top", top}, {"right", right}, {"bottom", bottom}};
                issues.push_back(issue);
            }
        }
        if (!issues.empty()) throw Failure("TEXT_OUTSIDE_BOUNDS", "Edited text does not fit within its required bounds", {{"issues", issues}, {"tolerancePt", boundsTolerancePt}});
    }
    J changes = J::array(), gates = J::array(), fontExpansions = J::array(), fontReuses = J::array();
    size_t unchangedObjects = 0, whitespaceSourceChecks = 0;
    for (const auto& [pageNo, list] : edits) {
        require(pageContent(check.pages.at(pageNo)) == expectedContents.at(pageNo), "VERIFY_FAILED", "Saved content does not match planned patches");
        const auto& before = objects(original, pageNo); const auto& after = objects(check, pageNo);
        require(before.size() == after.size(), "VERIFY_FAILED", "Object count changed; text may have merged or split");
        std::map<std::string, J> expected;
        for (const auto& edit : list) {
            expected[edit.target] = edit.expected;
            if (!edit.fontExpansion.is_null()) { auto evidence = edit.fontExpansion; evidence["page"] = pageNo; evidence["target"] = edit.target; fontExpansions.push_back(evidence); }
            if (!edit.fontReuse.is_null()) { auto evidence = edit.fontReuse; evidence["page"] = pageNo; evidence["target"] = edit.target; fontReuses.push_back(evidence); }
        }
        const auto glyphTexts = actualGlyphTexts(check.load(pageNo), expected);
        std::vector<std::pair<J,J>> changed;
        for (size_t i = 0; i < before.size(); ++i) {
            auto id = before[i]["id"].get<std::string>();
            if (!expected.contains(id)) {
                auto oldShape = fingerprint(before[i]), newShape = fingerprint(after[i]);
                if (before[i].contains("textSource") && oldShape.contains("text") && newShape.contains("text") && oldShape["text"] != newShape["text"]) {
                    // The page text extractor may collapse adjacent spaces
                    // across objects. Verify exact source text through a new
                    // mapped probe before accepting only whitespace differences.
                    auto compact = [](std::string value) { std::erase_if(value, [](char c) { return c == ' ' || c == '\r' || c == '\n'; }); return value; };
                    if (compact(oldShape["text"]) == compact(newShape["text"])) {
                        ensureMapping(check, pageNo);
                        require(after[i].contains("textSource") && after[i]["textSource"] == before[i]["textSource"], "VERIFY_FAILED", "Untargeted source text changed: " + id);
                        newShape["text"] = oldShape["text"]; ++whitespaceSourceChecks;
                    }
                }
                require(nearJson(oldShape, newShape), "VERIFY_FAILED", "Untargeted object changed: " + id); ++unchangedObjects; continue;
            }
            const auto& e = expected.at(id);
            require(before[i]["type"] == after[i]["type"] && nearJson(before[i]["matrix"],after[i]["matrix"]), "VERIFY_FAILED", "Target type or anchor matrix changed");
            for (const auto& [key,value] : e.items()) {
                if (key == "textSource") {
                    // Ignore only characters PDFium explicitly identifies as
                    // generated, while retaining real spaces and punctuation.
                    require(glyphTexts.at(id) == value.get<std::string>(), "VERIFY_FAILED", "Reopened glyph text does not match replacement");
                } else if (key == "fill" || key == "stroke") {
                    auto c = after[i][key]["value"];
                    for (int k = 0; k < 3; ++k) require(std::abs(c[k].get<int>()-value[k].get<int>()) <= 1, "VERIFY_FAILED", "Saved color differs");
                } else require(after[i].contains(key) && nearJson(after[i][key],value), "VERIFY_FAILED", "Saved style differs: " + key);
            }
            J saved = after[i];
            if (e.contains("textSource")) saved["textSource"] = e["textSource"];
            changes.push_back({{"target", id}, {"page", pageNo}, {"before", before[i]}, {"after", saved}}); changed.emplace_back(before[i],after[i]);
        }
        gates.push_back(pixelGate(original, check, pageNo, changed));
    }
    // Untouched pages must keep their decoded contents, including shared streams.
    for (size_t i = 0; i < pages.size(); ++i) if (!edits.contains(static_cast<int>(i))) require(pageContent(original.pages[i]) == pageContent(check.pages[i]), "VERIFY_FAILED", "Untouched page content changed");
    require(!check.qpdf.anyWarnings(), "VERIFY_FAILED", "Saved PDF has parse warnings");
    J result = {{"changes", changes}, {"validation", {{"reopened", true}, {"originalRawStreamsPreserved", beforeHashes.size()}, {"patchedContentsVerified", true}, {"unchangedObjectsVerified", unchangedObjects}, {"whitespaceSourceChecks", whitespaceSourceChecks}, {"pixelGates", gates}, {"fontExpansions", fontExpansions}, {"fontReuses", fontReuses}, {"rasterized", false}}}};
    if (request.contains("textBounds")) {
        result["validation"]["textBounds"] = {{"checkedObjects", textBounds.size()}, {"tolerancePt", boundsTolerancePt}};
    }
    return result;
}
