#pragma once

// PDFium creates a separate font-resource document. Only its font dictionary is
// imported; QPDF remains the sole writer of the user's existing PDF.
struct ExpandedFont {
    std::unique_ptr<Document> resource;
    FontMap map;
    FPDF_FONT rendered{};
    J evidence;
};
std::string postScriptName(std::string name) {
    if (!name.empty() && name.front() == '/') name.erase(0, 1);
    if (name.size() > 7 && name[6] == '+' && std::all_of(name.begin(), name.begin()+6, [](char c) { return c >= 'A' && c <= 'Z'; })) name.erase(0, 7);
    return name;
}
OH fontDescriptor(OH font) {
    if (font.getKey("/Subtype").isNameAndEquals("/Type0")) font = font.getKey("/DescendantFonts").getArrayItem(0);
    return font.getKey("/FontDescriptor");
}
bool hasFontCharacters(const FontMap& font, const std::wstring& text) {
    return font.codeBytes > 0 && std::all_of(text.begin(), text.end(), [&](wchar_t u) {
        return std::count_if(font.unicode.begin(), font.unicode.end(), [&](const auto& pair) { return pair.second == u; }) == 1;
    });
}
struct FontMemoryWriter : FPDF_FILEWRITE {
    std::string bytes;
    FontMemoryWriter() {
        version = 1;
        WriteBlock = [](FPDF_FILEWRITE* self, const void* data, unsigned long length) -> int {
            auto& out = static_cast<FontMemoryWriter*>(self)->bytes;
            if (out.size()+length > 64 * 1024 * 1024) return 0;
            try { out.append(static_cast<const char*>(data), length); return 1; } catch (...) { return 0; }
        };
    }
};
void normalizeGeneratedFont(QPDF& pdf, OH font) {
    auto descendant = font.getKey("/DescendantFonts").getArrayItem(0);
    auto originalGlyphMap = descendant.getKey("/CIDToGIDMap");
    require(originalGlyphMap.isNull() || originalGlyphMap.isNameAndEquals("/Identity"), "FONT_EXTENSION_FAILED", "Generated font has an unexpected glyph encoding");
    // PDFium assigns CID = glyph ID and can emit multiple Unicode aliases for
    // that CID (space/NBSP, hyphen/soft hyphen). Give each Unicode its own CID;
    // preserve the engine-provided glyph IDs and widths without parsing TTF.
    std::map<unsigned, unsigned> glyphs;
    readUnicodeMap(font.getKey("/ToUnicode"), 2, [&](unsigned glyph, wchar_t unicode) {
        require(!glyphs.contains(unicode) || glyphs.at(unicode) == glyph, "FONT_EXTENSION_FAILED", "Unicode maps to conflicting generated glyphs");
        if (glyph != 0) glyphs[unicode] = glyph;
    });
    require(!glyphs.empty() && glyphs.contains(32), "FONT_EXTENSION_FAILED", "Generated font has no supported glyph map");
    std::map<unsigned, OH> widths;
    auto entries = descendant.getKey("/W").getArrayAsVector();
    for (size_t i = 0; i < entries.size();) {
        require(i+1 < entries.size() && entries[i].isInteger(), "FONT_EXTENSION_FAILED", "Invalid generated glyph widths");
        unsigned first = entries[i++].getUIntValueAsUInt(); auto value = entries[i++];
        if (value.isArray()) {
            auto values = value.getArrayAsVector();
            require(first+values.size() <= 65536, "FONT_EXTENSION_FAILED", "Generated glyph range is too large");
            for (size_t k = 0; k < values.size(); ++k) widths[first+static_cast<unsigned>(k)] = values[k];
        } else {
            require(value.isInteger() && i < entries.size(), "FONT_EXTENSION_FAILED", "Invalid generated glyph range");
            unsigned last = value.getUIntValueAsUInt();
            require(last >= first && last < 65536, "FONT_EXTENSION_FAILED", "Generated glyph range is too large");
            auto width = entries[i++];
            for (unsigned g = first; g <= last; ++g) widths[g] = width;
        }
    }
    auto newWidths = OH::newArray();
    auto defaultWidth = descendant.getKey("/DW"); if (!defaultWidth.isNumber()) defaultWidth = OH::newInteger(1000);
    std::string gidMap((glyphs.rbegin()->first+1)*2, '\0');
    std::string cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /APE-Unicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
    size_t count = 0;
    for (const auto& [unicode, glyph] : glyphs) {
        gidMap[unicode*2] = static_cast<char>(glyph >> 8); gidMap[unicode*2+1] = static_cast<char>(glyph & 255);
        auto width = widths.contains(glyph) ? widths.at(glyph) : defaultWidth;
        require(width.isNumber() && width.getNumericValue() >= 0, "FONT_EXTENSION_FAILED", "Invalid generated glyph width");
        newWidths.appendItem(OH::newInteger(unicode)); newWidths.appendItem(OH::newArray({width}));
        if (count % 100 == 0) cmap += std::to_string(std::min<size_t>(100, glyphs.size()-count)) + " beginbfchar\n";
        const char* digits = "0123456789ABCDEF";
        std::string code = "<0000>";
        for (int k = 0; k < 4; ++k) code[4-k] = digits[(unicode >> (k*4)) & 15];
        cmap += code + " " + code + "\n";
        if (++count % 100 == 0 || count == glyphs.size()) cmap += "endbfchar\n";
    }
    cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    font.replaceKey("/ToUnicode", pdf.newStream(cmap));
    descendant.replaceKey("/CIDToGIDMap", pdf.newStream(gidMap));
    descendant.replaceKey("/W", newWidths);
}
std::shared_ptr<ExpandedFont> loadFontResource(const std::string& bytes, const std::string& name, J evidence) {
    struct Handles {
        FPDF_DOCUMENT doc = FPDF_CreateNewDocument();
        FPDF_PAGE page{}; FPDF_FONT font{};
        ~Handles() { if (font) FPDFFont_Close(font); if (page) FPDF_ClosePage(page); if (doc) FPDF_CloseDocument(doc); }
    } handles;
    require(handles.doc && !bytes.empty() && bytes.size() <= 16 * 1024 * 1024, "FONT_EXTENSION_FAILED", "Invalid font resource size");
    handles.font = FPDFText_LoadFont(handles.doc, reinterpret_cast<const unsigned char*>(bytes.data()), static_cast<uint32_t>(bytes.size()), FPDF_FONT_TRUETYPE, true);
    require(handles.font != nullptr, "FONT_EXTENSION_FAILED", "Cannot load the TrueType character map");
    handles.page = FPDFPage_New(handles.doc, 0, 100, 100);
    require(handles.page != nullptr, "FONT_EXTENSION_FAILED", "Cannot create the font resource page");
    auto text = FPDFPageObj_CreateTextObj(handles.doc, handles.font, 12);
    require(text != nullptr, "FONT_EXTENSION_FAILED", "Cannot create the font resource reference");
    const FPDF_WCHAR space[] = {32, 0};
    if (!FPDFText_SetText(text, space)) { FPDFPageObj_Destroy(text); throw Failure("FONT_EXTENSION_FAILED", "Font cannot encode a space"); }
    FPDFPage_InsertObject(handles.page, text);
    require(FPDFPage_GenerateContent(handles.page), "FONT_EXTENSION_FAILED", "Cannot generate the font resource reference");
    FontMemoryWriter saved;
    require(FPDF_SaveAsCopy(handles.doc, &saved, FPDF_NO_INCREMENTAL), "FONT_EXTENSION_FAILED", "Cannot serialize the isolated font resource");
    // Some original subsets omit their name table. Preserve the PDF face name.
    QPDF named; named.processMemoryFile("font.pdf", saved.bytes.data(), saved.bytes.size());
    auto fonts = QPDFPageDocumentHelper::get(named).getAllPages().at(0).getAttribute("/Resources", false).getKey("/Font");
    require(fonts.getKeys().size() == 1, "FONT_EXTENSION_FAILED", "Unexpected generated font resource count");
    auto font = fonts.getKey(*fonts.getKeys().begin());
    normalizeGeneratedFont(named, font);
    QPDFPageDocumentHelper::get(named).getAllPages().at(0).getObjectHandle().replaceKey("/Contents",
        named.newStream("BT " + *fonts.getKeys().begin() + " 12 Tf <0020> Tj ET\n"));
    font.replaceKey("/BaseFont", OH::newName("/" + name));
    font.getKey("/DescendantFonts").getArrayItem(0).replaceKey("/BaseFont", OH::newName("/" + name));
    fontDescriptor(font).replaceKey("/FontName", OH::newName("/" + name));
    auto result = std::make_shared<ExpandedFont>();
    result->resource = std::make_unique<Document>(memoryPDF(named));
    auto resources = result->resource->pages[0].getAttribute("/Resources", false).getKey("/Font");
    result->map = readFont(resources.getKey(*resources.getKeys().begin()));
    require(result->map.codeBytes == 2, "FONT_EXTENSION_FAILED", "Generated font has no supported Unicode map: " + result->map.reason);
    result->rendered = FPDFTextObj_GetFont(FPDFPage_GetObject(result->resource->load(0).page, 0));
    evidence["postScriptName"] = name;
    evidence["fontProgramSha256"] = digest(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size());
    evidence["fontProgramBytes"] = bytes.size();
    result->evidence = std::move(evidence);
    return result;
}
std::pair<std::string, J> installedFontProgram(const std::string& name, OH descriptor) {
    ComPtr<IDWriteFactory> factory;
    hr(DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(factory.GetAddressOf())));
    ComPtr<IDWriteFontCollection> collection; hr(factory->GetSystemFontCollection(&collection, FALSE));
    std::vector<UINT32> families;
    auto familyName = descriptor.getKey("/FontFamily");
    if (familyName.isString()) {
        UINT32 index = 0; BOOL exists = FALSE;
        hr(collection->FindFamilyName(wide(familyName.getUTF8Value()).c_str(), &index, &exists));
        if (exists) families.push_back(index);
    }
    if (families.empty()) for (UINT32 i = 0; i < collection->GetFontFamilyCount(); ++i) families.push_back(i);
    for (auto familyIndex : families) {
        ComPtr<IDWriteFontFamily> family; hr(collection->GetFontFamily(familyIndex, &family));
        for (UINT32 i = 0; i < family->GetFontCount(); ++i) {
            ComPtr<IDWriteFont> font; hr(family->GetFont(i, &font));
            ComPtr<IDWriteLocalizedStrings> names; BOOL exists = FALSE;
            hr(font->GetInformationalStrings(DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME, &names, &exists));
            if (!exists || !names) continue;
            bool matches = false;
            for (UINT32 k = 0; k < names->GetCount(); ++k) {
                UINT32 length = 0; hr(names->GetStringLength(k, &length));
                require(length < 4096, "FONT_EXTENSION_FAILED", "Font name is too long");
                std::wstring value(length+1, L'\0'); hr(names->GetString(k, value.data(), length+1)); value.resize(length);
                if (value == wide(name)) matches = true;
            }
            if (!matches) continue;
            ComPtr<IDWriteFontFace> face; hr(font->CreateFontFace(&face));
            require(face->GetType() == DWRITE_FONT_FACE_TYPE_TRUETYPE && face->GetIndex() == 0 && face->GetSimulations() == DWRITE_FONT_SIMULATIONS_NONE,
                    "FONT_EXTENSION_UNSUPPORTED", "Font extension requires a nonsimulated, standalone TrueType face");
            const void* table = nullptr; UINT32 tableSize = 0; void* context = nullptr; BOOL hasTable = FALSE;
            hr(face->TryGetFontTable(DWRITE_MAKE_OPENTYPE_TAG('O','S','/','2'), &table, &tableSize, &context, &hasTable));
            unsigned flags = 0xffff;
            if (hasTable && tableSize >= 10) { auto p = static_cast<const unsigned char*>(table); flags = p[8]*256 + p[9]; }
            if (context) face->ReleaseFontTable(context);
            require(flags != 0xffff && !(flags & (0x0002 | 0x0200)) && (!(flags & 0x000c) || (flags & 0x0008)),
                    "FONT_EMBEDDING_RESTRICTED", "Installed font does not permit editable outline embedding");
            UINT32 count = 0; hr(face->GetFiles(&count, nullptr));
            require(count == 1, "FONT_EXTENSION_UNSUPPORTED", "Font uses multiple files");
            ComPtr<IDWriteFontFile> file; hr(face->GetFiles(&count, file.GetAddressOf()));
            const void* key = nullptr; UINT32 keySize = 0; hr(file->GetReferenceKey(&key, &keySize));
            ComPtr<IDWriteFontFileLoader> loader; hr(file->GetLoader(&loader));
            ComPtr<IDWriteLocalFontFileLoader> local; hr(loader.As(&local));
            UINT32 length = 0; hr(local->GetFilePathLengthFromKey(key, keySize, &length));
            require(length < 32768, "FONT_EXTENSION_FAILED", "Font path is too long");
            std::wstring filePath(length+1, L'\0'); hr(local->GetFilePathFromKey(key, keySize, filePath.data(), length+1)); filePath.resize(length);
            std::ifstream input(fs::path(filePath), std::ios::binary | std::ios::ate);
            require(input.good(), "FONT_EXTENSION_FAILED", "Cannot read the matched local font");
            auto size = input.tellg(); require(size > 0 && size <= 16*1024*1024, "FONT_EXTENSION_UNSUPPORTED", "Font exceeds 16 MiB");
            std::string bytes(static_cast<size_t>(size), '\0'); input.seekg(0); input.read(bytes.data(), size);
            require(input.good(), "FONT_EXTENSION_FAILED", "Incomplete font read");
            return {std::move(bytes), {{"source", "matching-installed-font"}, {"file", utf8(filePath.data(), static_cast<int>(filePath.size()))}, {"embeddingFsType", flags}}};
        }
    }
    throw Failure("FONT_FACE_UNAVAILABLE", "No installed font has the exact PostScript name: " + name);
}
bool equalGlyphOutline(FPDF_FONT a, FPDF_FONT b, wchar_t u) {
    auto pa = FPDFFont_GetGlyphPath(a, u, 1000), pb = FPDFFont_GetGlyphPath(b, u, 1000);
    int na = FPDFGlyphPath_CountGlyphSegments(pa), nb = FPDFGlyphPath_CountGlyphSegments(pb);
    if (u == 32 && na <= 0 && nb <= 0) return true;
    if (na <= 0 || na != nb || na > 100000) return false;
    for (int i = 0; i < na; ++i) {
        auto sa = FPDFGlyphPath_GetGlyphPathSegment(pa, i), sb = FPDFGlyphPath_GetGlyphPathSegment(pb, i);
        if (FPDFPathSegment_GetType(sa) != FPDFPathSegment_GetType(sb) || FPDFPathSegment_GetClose(sa) != FPDFPathSegment_GetClose(sb)) return false;
        float ax, ay, bx, by;
        if (!FPDFPathSegment_GetPoint(sa, &ax, &ay) || !FPDFPathSegment_GetPoint(sb, &bx, &by) || std::abs(ax-bx) > .00001 || std::abs(ay-by) > .00001) return false;
    }
    return true;
}
std::shared_ptr<ExpandedFont> expandFont(FontMap& original, FPDF_FONT rendered, const std::wstring& text) {
    auto descriptor = fontDescriptor(original.dictionary);
    require(descriptor.isDictionary(), "FONT_CODE_UNVERIFIED", "Unobserved characters require an embedded TrueType font for exact-face verification");
    auto embedded = descriptor.getKey("/FontFile2");
    require(embedded.isStream() && FPDFFont_GetIsEmbedded(rendered) == 1, "FONT_CODE_UNVERIFIED", "Unobserved characters require an embedded TrueType font for exact-face verification");
    if (original.expansion && hasFontCharacters(original.expansion->map, text)) return original.expansion;
    auto name = postScriptName(original.dictionary.getKey("/BaseFont").getName());
    std::shared_ptr<ExpandedFont> result;
    try { result = loadFontResource(decoded(embedded), name, {{"source", "embedded-font-program"}}); } catch (const Failure&) {}
    if (!result || !hasFontCharacters(result->map, text)) {
        auto [bytes, evidence] = installedFontProgram(name, descriptor);
        result = loadFontResource(bytes, name, evidence);
    }
    require(hasFontCharacters(result->map, text), "FONT_GLYPH_UNAVAILABLE", "The exact font has no unique mapping for a requested character");
    size_t verified = 0;
    for (const auto& [u, codes] : original.observed) {
        require(codes.size() == 1 && hasFontCharacters(result->map, std::wstring(1, u)), "FONT_FACE_MISMATCH", "Cannot verify all observed source glyphs against the complete font");
        float width = 0;
        require(FPDFFont_GetGlyphWidth(result->rendered, u, 1000, &width) && std::abs(width-glyphWidth(original, *codes.begin(), rendered)) <= .001 && equalGlyphOutline(rendered, result->rendered, u),
                "FONT_FACE_MISMATCH", "Matched font has a different glyph outline or advance for Unicode " + std::to_string(u));
        ++verified;
    }
    result->evidence["observedGlyphsVerified"] = verified;
    original.expansion = result;
    return result;
}
