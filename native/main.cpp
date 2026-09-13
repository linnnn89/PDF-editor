#include <windows.h>
#include <bcrypt.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <dwrite.h>
#include <fpdfview.h>
#include <fpdf_edit.h>
#include <fpdf_text.h>
#include <fpdf_transformpage.h>
#include <fpdf_save.h>
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>
#include <qpdf/QPDFPageObjectHelper.hh>
#include <qpdf/QPDFWriter.hh>
#include <json.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <thread>
#include <vector>

using J = nlohmann::json;
using OH = QPDFObjectHandle;
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

struct Failure : std::runtime_error {
    std::string code;
    J details;
    Failure(std::string c, std::string m, J d = nullptr) : std::runtime_error(std::move(m)), code(std::move(c)), details(std::move(d)) {}
};
void require(bool condition, const char* code, const std::string& message) {
    if (!condition) throw Failure(code, message);
}
std::wstring wide(const std::string& value) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    require(n > 0 || value.empty(), "INVALID_ARGUMENT", "Invalid UTF-8 path");
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), out.data(), n);
    return out;
}
std::string utf8(const wchar_t* value, int length) {
    int n = WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
    std::string out(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, length, out.data(), n, nullptr, nullptr);
    return out;
}
std::string digest(const unsigned char* data, size_t size) {
    require(size <= (std::numeric_limits<ULONG>::max)(), "RESOURCE_LIMIT", "Hash input exceeds 4 GiB");
    std::array<unsigned char, 32> hash{};
    auto result = BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, const_cast<PUCHAR>(data), static_cast<ULONG>(size), hash.data(), 32);
    require(result >= 0, "HASH_FAILED", "Windows SHA-256 failed");
    constexpr char hex[] = "0123456789abcdef";
    std::string out;
    for (auto b : hash) { out += hex[b >> 4]; out += hex[b & 15]; }
    return out;
}
double number(const J& value, const char* name) {
    require(value.is_number(), "INVALID_ARGUMENT", std::string(name) + " must be a number");
    double v = value.get<double>();
    require(std::isfinite(v), "INVALID_ARGUMENT", std::string(name) + " must be finite");
    return v;
}
int integer(const J& value, const char* name, int maximum) {
    require(value.is_number_integer(), "INVALID_ARGUMENT", std::string(name) + " must be an integer");
    auto n = value.get<int64_t>();
    require(n >= 0 && n <= maximum, "INVALID_ARGUMENT", std::string(name) + " is out of range");
    return static_cast<int>(n);
}
struct Rect {
    double x, y, w, h;
    J json() const { return { {"x", x}, {"y", y}, {"width", w}, {"height", h} }; }
};
Rect rect(const J& j) {
    Rect r{number(j.at("x"), "x"), number(j.at("y"), "y"), number(j.at("width"), "width"), number(j.at("height"), "height")};
    require(r.w > 0 && r.h > 0, "INVALID_ARGUMENT", "Rectangle dimensions must be positive");
    return r;
}
constexpr double boundsTolerancePt = .0002;
Rect regionRect(const J& j) {
    require(j.is_object() && j.size() == 4 && j.contains("x") && j.contains("y") && j.contains("width") && j.contains("height"),
            "INVALID_ARGUMENT", "Region must contain exactly x, y, width and height");
    auto r = rect(j);
    require(std::isfinite(r.x + r.w) && std::isfinite(r.y + r.h), "INVALID_ARGUMENT", "Region edges must be finite");
    return r;
}
void inside(Rect r, double width, double height) {
    require(r.x >= 0 && r.y >= 0 && r.x + r.w <= width + 1e-7 && r.y + r.h <= height + 1e-7,
            "OUTSIDE_PAGE", "Rectangle must fit within the visible page");
}
OH box(double l, double b, double r, double t) {
    return OH::newArray({OH::newReal(l, 8), OH::newReal(b, 8), OH::newReal(r, 8), OH::newReal(t, 8)});
}
struct Geometry {
    double l, b, r, t, unit, width, height;
    int rotation;
    std::pair<double, double> display(double x, double y) const {
        switch (rotation) {
        case 90: return {(y - b) * unit, (x - l) * unit};
        case 180: return {(r - x) * unit, (y - b) * unit};
        case 270: return {(t - y) * unit, (r - x) * unit};
        default: return {(x - l) * unit, (t - y) * unit};
        }
    }
    std::pair<double, double> source(double x, double y) const {
        switch (rotation) {
        case 90: return {l + y / unit, b + x / unit};
        case 180: return {r - x / unit, b + y / unit};
        case 270: return {r - y / unit, t - x / unit};
        default: return {l + x / unit, t - y / unit};
        }
    }
    OH sourceBox(Rect target) const {
        auto [x1, y1] = source(target.x, target.y);
        auto [x2, y2] = source(target.x + target.w, target.y + target.h);
        return box(std::min(x1, x2), std::min(y1, y2), std::max(x1, x2), std::max(y1, y2));
    }
};
Geometry geometry(QPDFPageObjectHelper ph) {
    auto media = ph.getMediaBox().getArrayAsRectangle();
    auto crop = ph.getCropBox().getArrayAsRectangle();
    Geometry g{};
    g.l = std::max(media.llx, crop.llx); g.b = std::max(media.lly, crop.lly);
    g.r = std::min(media.urx, crop.urx); g.t = std::min(media.ury, crop.ury);
    auto u = ph.getObjectHandle().getKey("/UserUnit");
    g.unit = u.isNumber() ? u.getNumericValue() : 1;
    auto rot = ph.getAttribute("/Rotate", false);
    g.rotation = rot.isInteger() ? ((rot.getIntValueAsInt() % 360) + 360) % 360 : 0;
    require(g.rotation % 90 == 0 && g.r > g.l && g.t > g.b && g.unit > 0 && std::isfinite(g.unit),
            "UNSUPPORTED_GEOMETRY", "Invalid page box, Rotate or UserUnit");
    g.width = (g.r - g.l) * g.unit; g.height = (g.t - g.b) * g.unit;
    if (g.rotation % 180) std::swap(g.width, g.height);
    require(std::isfinite(g.width) && std::isfinite(g.height), "UNSUPPORTED_GEOMETRY", "Page size is not finite");
    return g;
}
struct PageMapping;
struct LoadedPage {
    FPDF_PAGE page{};
    FPDF_TEXTPAGE text{};
    J objects;
    std::shared_ptr<PageMapping> mapping;
    ~LoadedPage() { if (text) FPDFText_ClosePage(text); if (page) FPDF_ClosePage(page); }
};
struct Document {
    std::vector<char> bytes;
    QPDF qpdf;
    FPDF_DOCUMENT pdf{};
    std::vector<QPDFPageObjectHelper> pages;
    std::map<int, std::unique_ptr<LoadedPage>> cache;
    std::string sha;
    bool hadWarnings = false;
    Document(const std::string& file, const std::string& expected = "") {
        std::ifstream input(fs::path(wide(file)), std::ios::binary | std::ios::ate);
        require(input.good(), "INPUT_UNREADABLE", "Cannot read PDF");
        auto size = input.tellg();
        require(size > 0 && size <= 256 * 1024 * 1024, "RESOURCE_LIMIT", "This alpha accepts PDFs up to 256 MiB");
        bytes.resize(static_cast<size_t>(size)); input.seekg(0); input.read(bytes.data(), size);
        require(input.good(), "INPUT_UNREADABLE", "Could not read the entire PDF");
        sha = digest(reinterpret_cast<unsigned char*>(bytes.data()), bytes.size());
        require(expected.empty() || sha == expected, "STALE_SOURCE", "Input changed before native open");
        initialize();
    }
    explicit Document(const std::shared_ptr<Buffer>& buffer) {
        bytes.assign(reinterpret_cast<const char*>(buffer->getBuffer()), reinterpret_cast<const char*>(buffer->getBuffer()) + buffer->getSize());
        initialize();
    }
    void initialize() {
        qpdf.setSuppressWarnings(true);
        qpdf.processMemoryFile("input.pdf", bytes.data(), bytes.size());
        require(!qpdf.isEncrypted(), "UNSUPPORTED_DOCUMENT", "Encrypted PDFs are not supported by this alpha");
        pages = QPDFPageDocumentHelper::get(qpdf).getAllPages();
        hadWarnings = qpdf.anyWarnings();
        pdf = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
        require(pdf != nullptr, "PDF_OPEN_FAILED", "PDFium could not open this document");
        if (FPDF_GetPageCount(pdf) != static_cast<int>(pages.size())) {
            FPDF_CloseDocument(pdf); pdf = nullptr;
            throw Failure("READER_DISAGREEMENT", "PDF readers disagree on page count");
        }
    }
    ~Document() { cache.clear(); if (pdf) FPDF_CloseDocument(pdf); }
    LoadedPage& load(int index) {
        require(index >= 0 && index < static_cast<int>(pages.size()), "PAGE_NOT_FOUND", "Page index is out of range (zero based)");
        if (!cache.contains(index)) {
            auto p = std::make_unique<LoadedPage>();
            p->page = FPDF_LoadPage(pdf, index);
            require(p->page != nullptr, "PAGE_LOAD_FAILED", "PDFium could not load the page");
            cache[index] = std::move(p);
        }
        return *cache.at(index);
    }
    J warnings() {
        J result = J::array();
        hadWarnings = hadWarnings || qpdf.anyWarnings();
        for (const auto& w : qpdf.getWarnings()) result.push_back(w.what());
        return result;
    }
};
void ensureText(LoadedPage& page) {
    if (!page.text) {
        page.text = FPDFText_LoadPage(page.page);
        require(page.text != nullptr, "TEXT_LOAD_FAILED", "PDFium could not load page text");
    }
}
using Matrix = std::array<double, 6>;
Matrix multiply(Matrix a, Matrix b) {
    return {a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]};
}
std::string objectText(FPDF_PAGEOBJECT obj, FPDF_TEXTPAGE page) {
    auto bytes = FPDFTextObj_GetText(obj, page, nullptr, 0);
    require(bytes <= 2 * 1024 * 1024, "RESOURCE_LIMIT", "Text object is too large");
    if (bytes < 2) return "";
    std::vector<FPDF_WCHAR> text(bytes / 2);
    auto written = FPDFTextObj_GetText(obj, page, text.data(), bytes);
    if (written < 2) return "";
    return utf8(reinterpret_cast<const wchar_t*>(text.data()), static_cast<int>(written / 2 - 1));
}
J color(FPDF_PAGEOBJECT obj, bool stroke) {
    unsigned int r, g, b, a;
    auto ok = stroke ? FPDFPageObj_GetStrokeColor(obj, &r, &g, &b, &a) : FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a);
    if (!ok) return nullptr;
    return J{{"space", "rendered-rgba"}, {"value", {r, g, b, a}}};
}
void indexObjects(LoadedPage& page, FPDF_PAGEOBJECT form, Matrix parent, const Geometry& g, const std::string& prefix, J& out, int depth) {
    require(depth <= 32, "RESOURCE_LIMIT", "Form nesting exceeds 32 levels");
    int count = form ? FPDFFormObj_CountObjects(form) : FPDFPage_CountObjects(page.page);
    require(count >= 0, "OBJECT_READ_FAILED", "Cannot enumerate objects");
    for (int i = 0; i < count; ++i) {
        require(out.size() < 100000, "RESOURCE_LIMIT", "Page exceeds 100000 objects");
        auto obj = form ? FPDFFormObj_GetObject(form, i) : FPDFPage_GetObject(page.page, i);
        require(obj != nullptr, "OBJECT_READ_FAILED", "Null page object");
        int type = FPDFPageObj_GetType(obj);
        std::string id = prefix + "/" + std::to_string(i);
        const char* typeName = type == FPDF_PAGEOBJ_TEXT ? "text" : type == FPDF_PAGEOBJ_PATH ? "path" : type == FPDF_PAGEOBJ_IMAGE ? "image" : type == FPDF_PAGEOBJ_FORM ? "form" : "other";
        J item = {{"id", id}, {"type", typeName}, {"depth", depth}, {"sourceMapping", "unmapped"}, {"editable", false}};
        FS_MATRIX fm{1, 0, 0, 1, 0, 0};
        FPDFPageObj_GetMatrix(obj, &fm);
        Matrix matrix = {fm.a, fm.b, fm.c, fm.d, fm.e, fm.f};
        item["matrix"] = matrix;
        float l, b, r, t;
        if (FPDFPageObj_GetBounds(obj, &l, &b, &r, &t)) {
            double minx = INFINITY, miny = INFINITY, maxx = -INFINITY, maxy = -INFINITY;
            for (auto x : {l, r}) for (auto y : {b, t}) {
                auto [dx, dy] = g.display(parent[0]*x + parent[2]*y + parent[4], parent[1]*x + parent[3]*y + parent[5]);
                minx = std::min(minx, dx); miny = std::min(miny, dy); maxx = std::max(maxx, dx); maxy = std::max(maxy, dy);
            }
            item["boundsPt"] = Rect{minx, miny, maxx-minx, maxy-miny}.json();
            item["boundsKind"] = "geometric-unclipped";
        }
        item["fill"] = color(obj, false); item["stroke"] = color(obj, true);
        if (type == FPDF_PAGEOBJ_TEXT) {
            item["text"] = objectText(obj, page.text);
            float size = 0; FPDFTextObj_GetFontSize(obj, &size);
            auto effective = multiply(parent, matrix);
            item["fontSizeRaw"] = size;
            item["fontSizeYPt"] = size * std::hypot(effective[2], effective[3]) * g.unit;
            auto font = FPDFTextObj_GetFont(obj);
            auto n = FPDFFont_GetBaseFontName(font, nullptr, 0);
            if (n && n < 65536) {
                std::string name(n, '\0'); FPDFFont_GetBaseFontName(font, name.data(), n); name.resize(n-1); item["font"] = name;
            }
            item["fontEmbedded"] = FPDFFont_GetIsEmbedded(font) == 1;
        } else if (type == FPDF_PAGEOBJ_PATH) {
            float width = 0; FPDFPageObj_GetStrokeWidth(obj, &width);
            item["strokeWidthRaw"] = width;
            item["segmentCount"] = FPDFPath_CountSegments(obj);
        } else if (type == FPDF_PAGEOBJ_IMAGE) {
            unsigned int width = 0, height = 0;
            if (FPDFImageObj_GetImagePixelSize(obj, &width, &height)) item["pixels"] = {width, height};
        }
        out.push_back(std::move(item));
        if (type == FPDF_PAGEOBJ_FORM) indexObjects(page, obj, multiply(parent, matrix), g, id, out, depth + 1);
    }
}
J& objects(Document& doc, int index) {
    auto& page = doc.load(index);
    if (page.objects.is_null()) {
        ensureText(page);
        J list = J::array();
        indexObjects(page, nullptr, {1,0,0,1,0,0}, geometry(doc.pages.at(index)), "p" + std::to_string(index), list, 0);
        page.objects = std::move(list);
    }
    return page.objects;
}
void countObjects(LoadedPage& page, FPDF_PAGEOBJECT form, J& counts, size_t& total, int depth) {
    require(depth <= 32, "RESOURCE_LIMIT", "Form nesting exceeds 32 levels");
    int count = form ? FPDFFormObj_CountObjects(form) : FPDFPage_CountObjects(page.page);
    require(count >= 0, "OBJECT_READ_FAILED", "Cannot enumerate objects");
    for (int i = 0; i < count; ++i) {
        require(total < 100000, "RESOURCE_LIMIT", "Page exceeds 100000 objects");
        auto obj = form ? FPDFFormObj_GetObject(form, i) : FPDFPage_GetObject(page.page, i);
        require(obj != nullptr, "OBJECT_READ_FAILED", "Null page object");
        int type = FPDFPageObj_GetType(obj);
        const char* typeName = type == FPDF_PAGEOBJ_TEXT ? "text" : type == FPDF_PAGEOBJ_PATH ? "path" : type == FPDF_PAGEOBJ_IMAGE ? "image" : type == FPDF_PAGEOBJ_FORM ? "form" : "other";
        counts[typeName] = counts.value(typeName, 0) + 1;
        ++total;
        if (type == FPDF_PAGEOBJ_FORM) countObjects(page, obj, counts, total, depth + 1);
    }
}
J stats(Document& doc, const J& request) {
    require(request.is_object(), "INVALID_ARGUMENT", "stats parameters must be an object");
    for (const auto& item : request.items())
        require(item.key() == "page", "INVALID_ARGUMENT", "Unknown stats parameter: " + item.key());
    int pageNo = request.contains("page") ? integer(request["page"], "page", 100000) : 0;
    auto& page = doc.load(pageNo);
    auto g = geometry(doc.pages.at(pageNo));
    J counts = J::object();
    size_t total = 0;
    countObjects(page, nullptr, counts, total, 0);
    return {{"page", pageNo}, {"pageCount", doc.pages.size()}, {"widthPt", g.width}, {"heightPt", g.height},
            {"rotation", g.rotation}, {"userUnit", g.unit}, {"coordinateSystem", "rotated-visible-page-top-left-pt"},
            {"pdfVersion", doc.qpdf.getPDFVersion()}, {"counts", counts}, {"totalObjects", total}, {"warnings", doc.warnings()}};
}
void ensureMapping(Document& doc, int index);
J inspect(Document& doc, const J& request) {
    const bool project = request.contains("fields");
    std::set<std::string> projection = {"id", "type"};
    if (project) {
        static const std::set<std::string> allowed = {"id", "type", "depth", "matrix", "boundsPt", "boundsKind",
            "fill", "stroke", "text", "fontSizeRaw", "fontSizeYPt", "font", "fontEmbedded", "strokeWidthRaw",
            "strokeWidthPt", "segmentCount", "pixels", "sourceMapping", "editable", "supportedOperations",
            "editReason", "sourceCommand", "textSource", "reusableCharacters"};
        require(request["fields"].is_array() && request["fields"].size() <= allowed.size(), "INVALID_ARGUMENT", "fields must be an array of at most 24 object field names");
        for (const auto& field : request["fields"]) {
            require(field.is_string() && allowed.contains(field.get<std::string>()), "INVALID_ARGUMENT", "Unknown or invalid object field");
            projection.insert(field.get<std::string>());
        }
    }
    int limit = request.contains("limit") ? integer(request["limit"], "limit", 10000) : 100;
    int offset = request.contains("offset") ? integer(request["offset"], "offset", 100000) : 0;
    int pageNo = request.contains("page") ? integer(request["page"], "page", 100000) : 0;
    if (request.value("mapping", true)) ensureMapping(doc, pageNo);
    const auto& all = objects(doc, pageNo);
    auto g = geometry(doc.pages.at(pageNo));
    const bool regional = request.contains("withinRectPt");
    Rect region{};
    if (regional) {
        region = regionRect(request["withinRectPt"]);
        inside(region, g.width, g.height);
    }
    J selected = J::array(), counts = J::object();
    int matches = 0;
    for (const auto& item : all) {
        auto type = item["type"].get<std::string>();
        counts[type] = counts.value(type, 0) + 1;
        if (request.contains("type") && request["type"] != item["type"]) continue;
        if (request.contains("text") && item.value("text", "").find(request["text"].get<std::string>()) == std::string::npos) continue;
        if (request.contains("id") && request["id"] != item["id"]) continue;
        if (request.contains("editable") && request["editable"] != item["editable"]) continue;
        if (regional) {
            if (!item.contains("boundsPt") || !item["boundsPt"].is_object()) continue;
            const auto& bounds = item["boundsPt"];
            bool valid = true;
            for (const char* key : {"x", "y", "width", "height"})
                if (!bounds.contains(key) || !bounds[key].is_number() || !std::isfinite(bounds[key].get<double>())) valid = false;
            if (!valid) continue;
            Rect b{bounds["x"].get<double>(), bounds["y"].get<double>(), bounds["width"].get<double>(), bounds["height"].get<double>()};
            if (b.w < 0 || b.h < 0 || !std::isfinite(b.x + b.w) || !std::isfinite(b.y + b.h)) continue;
            if (b.x < region.x - boundsTolerancePt || b.y < region.y - boundsTolerancePt ||
                b.x + b.w > region.x + region.w + boundsTolerancePt || b.y + b.h > region.y + region.h + boundsTolerancePt) continue;
        }
        if (matches >= offset && selected.size() < static_cast<size_t>(limit)) {
            if (!project) selected.push_back(item);
            else {
                // Project only the response. Mapping and edit verification must
                // always retain the complete cached object index.
                J fields = J::object();
                for (const auto& field : projection) if (item.contains(field)) fields[field] = item[field];
                selected.push_back(std::move(fields));
            }
        }
        ++matches;
    }
    return {{"page", pageNo}, {"pageCount", doc.pages.size()}, {"widthPt", g.width}, {"heightPt", g.height},
            {"rotation", g.rotation}, {"userUnit", g.unit}, {"coordinateSystem", "rotated-visible-page-top-left-pt"},
            {"pdfVersion", doc.qpdf.getPDFVersion()}, {"counts", counts}, {"matched", matches}, {"offset", offset},
            {"hasMore", matches > offset + static_cast<int>(selected.size())}, {"objects", selected}, {"warnings", doc.warnings()}};
}
void hr(HRESULT result) { require(SUCCEEDED(result), "PNG_WRITE_FAILED", "Windows PNG encoder failed: " + std::to_string(result)); }
void writePNG(const std::string& file, FPDF_BITMAP bitmap, int width, int height) {
    ComPtr<IWICImagingFactory> factory; ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> encoder; ComPtr<IWICBitmapFrameEncode> frame; ComPtr<IPropertyBag2> properties;
    hr(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
    hr(factory->CreateStream(&stream));
    hr(stream->InitializeFromFilename(wide(file).c_str(), GENERIC_WRITE));
    hr(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
    hr(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
    hr(encoder->CreateNewFrame(&frame, &properties)); hr(frame->Initialize(properties.Get()));
    hr(frame->SetSize(width, height));
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    hr(frame->SetPixelFormat(&format));
    require(IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA), "PNG_WRITE_FAILED", "Unexpected PNG pixel format");
    auto stride = FPDFBitmap_GetStride(bitmap);
    hr(frame->WritePixels(height, stride, stride * height, static_cast<BYTE*>(FPDFBitmap_GetBuffer(bitmap))));
    hr(frame->Commit()); hr(encoder->Commit());
}
J render(Document& doc, const J& request) {
    int index = request.contains("page") ? integer(request["page"], "page", 100000) : 0;
    auto& loaded = doc.load(index); auto g = geometry(doc.pages.at(index));
    double dpi = request.contains("dpi") ? number(request["dpi"], "dpi") : 144;
    require(dpi >= 36 && dpi <= 600, "INVALID_ARGUMENT", "dpi must be between 36 and 600");
    double fw = std::ceil(g.width * dpi / 72), fh = std::ceil(g.height * dpi / 72);
    require(fw > 0 && fh > 0 && fw * fh <= 40000000, "RESOURCE_LIMIT", "Render exceeds 40 megapixels; lower dpi");
    int width = static_cast<int>(fw), height = static_cast<int>(fh);
    auto bitmap = FPDFBitmap_Create(width, height, 1);
    require(bitmap != nullptr, "RENDER_FAILED", "Could not allocate bitmap");
    try {
        FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        FPDF_RenderPageBitmap(bitmap, loaded.page, 0, 0, width, height, 0, FPDF_ANNOT);
        writePNG(request.at("output").get<std::string>(), bitmap, width, height);
    } catch (...) { FPDFBitmap_Destroy(bitmap); throw; }
    FPDFBitmap_Destroy(bitmap);
    return {{"width", width}, {"height", height}, {"dpi", dpi}};
}
std::multiset<std::string> streamHashes(QPDF& q) {
    std::multiset<std::string> result;
    for (auto obj : q.getAllObjects()) {
        if (!obj.isStream()) continue;
        auto type = obj.getDict().getKey("/Type");
        if (type.isNameAndEquals("/XRef") || type.isNameAndEquals("/ObjStm")) continue;
        auto raw = obj.getRawStreamData();
        result.insert(digest(raw->getBuffer(), raw->getSize()));
    }
    return result;
}
void writable(Document& doc) {
    require(!doc.hadWarnings && !doc.qpdf.anyWarnings(), "REPAIRED_PDF_READ_ONLY", "QPDF reported parse warnings; editing is disabled for this file");
    for (auto object : doc.qpdf.getAllObjects()) {
        if (object.isDictionary() && object.getKey("/Type").isNameAndEquals("/Sig"))
            throw Failure("UNSUPPORTED_DOCUMENT", "This alpha does not modify signed PDFs");
    }
}
void preserveStreamEncoding(QPDF& doc) {
    // Freeze imported/source streams before adding new ones. Even an originally
    // uncompressed stream must retain its encoded bytes for preservation checks.
    for (auto object : doc.getAllObjects()) if (object.isStream()) object.setFilterOnWrite(false);
}
void save(QPDF& doc, const std::string& output, bool preserveAll, PDFVersion minimumVersion = {}) {
    require(!fs::exists(fs::path(wide(output))), "OUTPUT_EXISTS", "Candidate path already exists");
    QPDFWriter writer(doc, output.c_str());
    if (minimumVersion.getMajor()) writer.setMinimumPDFVersion(minimumVersion);
    writer.setCompressStreams(true); writer.setDecodeLevel(qpdf_dl_none);
    writer.setPreserveUnreferencedObjects(preserveAll); writer.write();
}
J crop(Document& original, const J& request) {
    writable(original);
    const auto& operations = request.at("operations");
    require(operations.is_array() && !operations.empty() && operations.size() <= 100, "INVALID_ARGUMENT", "Provide 1 to 100 crop operations");
    QPDF candidate; candidate.setSuppressWarnings(true);
    candidate.processMemoryFile("snapshot.pdf", original.bytes.data(), original.bytes.size());
    preserveStreamEncoding(candidate);
    auto pages = QPDFPageDocumentHelper::get(candidate).getAllPages();
    std::set<int> touched;
    J changes = J::array();
    // All mutations belong to a temporary document. The loaded source remains immutable.
    for (const auto& op : operations) {
        require(op.at("op") == "page.crop", "UNSUPPORTED_OPERATION", "Crop batches require page.crop operations");
        int index = integer(op.at("page"), "page", static_cast<int>(pages.size()) - 1);
        require(touched.insert(index).second, "INVALID_ARGUMENT", "Only one crop per page per batch");
        auto g = geometry(pages.at(index)); auto bounds = rect(op.at("rectPt"));
        inside(bounds, g.width, g.height);
        pages[index].getObjectHandle().replaceKey("/CropBox", g.sourceBox(bounds));
        changes.push_back({{"page", index}, {"rectPt", bounds.json()}});
    }
    auto before = streamHashes(original.qpdf);
    auto output = request.at("output").get<std::string>();
    save(candidate, output, true);
    Document check(output);
    require(check.pages.size() == original.pages.size(), "VERIFY_FAILED", "Page count changed");
    require(streamHashes(check.qpdf) == before, "VERIFY_FAILED", "Encoded content/resource streams changed");
    for (const auto& change : changes) {
        int i = change["page"];
        auto g = geometry(check.pages.at(i)); auto r = rect(change["rectPt"]);
        require(std::abs(g.width-r.w) < 0.00001 && std::abs(g.height-r.h) < 0.00001, "VERIFY_FAILED", "Saved CropBox dimensions differ");
        check.load(i);
    }
    require(!check.qpdf.anyWarnings(), "VERIFY_FAILED", "Saved PDF has parse warnings");
    return {{"changes", changes}, {"validation", {{"reopened", true}, {"rawStreamsPreserved", before.size()}, {"pageBoxesVerified", true}}}};
}
#include "editing.h"
J shareFontPrograms(QPDF& doc) {
    std::map<std::string, OH> canonical;
    std::map<QPDFObjGen, OH> replacements;
    size_t programs = 0, encodedBytes = 0;
    for (auto object : doc.getAllObjects()) {
        if (!object.isDictionary() || !object.getKey("/Type").isNameAndEquals("/FontDescriptor")) continue;
        auto program = object.getKey("/FontFile2");
        if (!program.isStream()) continue;
        auto id = program.getObjGen();
        if (replacements.contains(id)) {
            object.replaceKey("/FontFile2", replacements.at(id));
            continue;
        }
        auto dictionary = program.getDict().shallowCopy(); dictionary.removeKey("/Length");
        auto bytes = program.getRawStreamData();
        auto key = dictionary.unparse() + ":" + digest(bytes->getBuffer(), bytes->getSize());
        auto chosen = program;
        if (auto found = canonical.find(key); found != canonical.end()) {
            auto other = found->second.getRawStreamData();
            // Hashing finds candidates, but only exact encoded bytes and the
            // entire stream dictionary (except computed Length) permit reuse.
            if (bytes->getSize() == other->getSize() &&
                (!bytes->getSize() || std::equal(bytes->getBuffer(), bytes->getBuffer() + bytes->getSize(), other->getBuffer()))) {
                chosen = found->second;
                ++programs; encodedBytes += bytes->getSize();
            }
        } else canonical.emplace(key, program);
        replacements.emplace(id, chosen);
        // Font dictionaries, descriptors, widths and character maps stay separate.
        object.replaceKey("/FontFile2", chosen);
    }
    return {{"fontProgramsShared", programs}, {"encodedFontBytesShared", encodedBytes}};
}
J compose(const J& request) {
    double width = number(request.at("widthPt"), "widthPt"), height = number(request.at("heightPt"), "heightPt");
    require(width > 0 && height > 0 && width <= 14400 && height <= 14400, "INVALID_ARGUMENT", "Composition dimensions must be in (0, 14400] pt");
    const auto& panels = request.at("panels");
    require(panels.is_array() && !panels.empty() && panels.size() <= 32, "INVALID_ARGUMENT", "Provide 1 to 32 panels");
    QPDF result; result.emptyPDF();
    PDFVersion minimumVersion(1, 7);
    auto page = result.makeIndirectObject(OH::newDictionary());
    page.replaceKey("/Type", OH::newName("/Page")); page.replaceKey("/MediaBox", box(0, 0, width, height));
    auto resources = OH::newDictionary(), xobjects = OH::newDictionary();
    resources.replaceKey("/XObject", xobjects); page.replaceKey("/Resources", resources);
    QPDFPageObjectHelper ph(page);
    std::map<std::string, std::unique_ptr<Document>> sources;
    J placements = J::array(); std::string content;
    std::vector<OH> panelForms;
    int count = 0;
    for (const auto& panel : panels) {
        std::string file = panel.at("file"), expected = panel.at("sha256");
        if (!sources.contains(file)) sources[file] = std::make_unique<Document>(file, expected);
        auto& source = *sources.at(file); writable(source);
        minimumVersion.updateIfGreater(source.qpdf.getVersionAsPDFVersion());
        require(source.sha == expected, "STALE_SOURCE", "Inconsistent source digest");
        int index = integer(panel.at("page"), "page", static_cast<int>(source.pages.size()) - 1);
        auto g = geometry(source.pages.at(index));
        Rect region = panel.contains("sourceRectPt") ? rect(panel["sourceRectPt"]) : Rect{0,0,g.width,g.height};
        inside(region, g.width, g.height);
        auto target = rect(panel.at("targetRectPt")); inside(target, width, height);
        auto annots = source.pages.at(index).getObjectHandle().getKey("/Annots");
        int annotationCount = annots.isArray() ? annots.getArrayNItems() : 0;
        require(annotationCount == 0 || panel.value("annotations", "reject") == "exclude", "ANNOTATIONS_REQUIRE_CHOICE", "Panel has annotations. Explicit annotations: exclude is required to omit them");
        auto copy = source.pages.at(index).shallowCopyPage();
        auto sourceBox = g.sourceBox(region);
        copy.getObjectHandle().replaceKey("/CropBox", sourceBox);
        copy.getObjectHandle().replaceKey("/TrimBox", sourceBox);
        auto foreign = copy.getFormXObjectForPage(true);
        auto form = result.copyForeignObject(foreign);
        panelForms.push_back(form);
        std::string name = "/Panel" + std::to_string(++count);
        xobjects.replaceKey(name, form);
        OH::Rectangle destination(target.x, height-target.y-target.h, target.x+target.w, height-target.y);
        content += ph.placeFormXObject(form, name, destination, true, true, true);
        double scale = std::min(target.w / region.w, target.h / region.h);
        auto placed = Rect{target.x+(target.w-region.w*scale)/2, target.y+(target.h-region.h*scale)/2, region.w*scale, region.h*scale};
        placements.push_back({{"panel", count-1}, {"page", index}, {"sourceRectPt", region.json()}, {"placedRectPt", placed.json()},
                              {"scale", scale}, {"excludedAnnotations", annotationCount}});
    }
    // Imported image/font/nested-Form resources retain their original encoding.
    // Only the newly generated panel wrappers and placement stream may compress.
    preserveStreamEncoding(result);
    auto optimization = shareFontPrograms(result);
    for (auto form : panelForms) form.setFilterOnWrite(true);
    page.replaceKey("/Contents", result.newStream(content));
    QPDFPageDocumentHelper::get(result).addPage(ph, false);
    auto output = request.at("output").get<std::string>(); save(result, output, false, minimumVersion);
    Document check(output); check.load(0);
    auto imported = check.pages.at(0).getAttribute("/Resources", false).getKey("/XObject");
    require(imported.getKeys().size() == panels.size(), "VERIFY_FAILED", "Panel Form count differs");
    for (auto& name : imported.getKeys()) require(imported.getKey(name).getDict().getKey("/Subtype").isNameAndEquals("/Form"), "VERIFY_FAILED", "Panel is not a vector Form");
    require(!check.qpdf.anyWarnings(), "VERIFY_FAILED", "Composition has parse warnings");
    return {{"placements", placements}, {"optimization", optimization},
            {"validation", {{"reopened", true}, {"panelForms", panels.size()}, {"rasterized", false}}}};
}
struct ParentWatch {
    HANDLE parent{}, stop{}; std::thread watcher;
    explicit ParentWatch(DWORD pid) {
        parent = OpenProcess(SYNCHRONIZE, FALSE, pid); stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        require(parent && stop, "PARENT_BINDING_FAILED", "Cannot bind worker to its parent process");
        watcher = std::thread([this] {
            HANDLE handles[] = {stop, parent};
            if (WaitForMultipleObjects(2, handles, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) ExitProcess(122);
        });
    }
    ~ParentWatch() { SetEvent(stop); if (watcher.joinable()) watcher.join(); CloseHandle(parent); CloseHandle(stop); }
};
int main(int argc, char** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    try {
        require(argc == 3 && std::string(argv[1]) == "--parent-pid", "INVALID_ARGUMENT", "Start through the JavaScript API/CLI");
        ParentWatch parent(static_cast<DWORD>(std::stoul(argv[2])));
        hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
        FPDF_LIBRARY_CONFIG config{}; config.version = 2; FPDF_InitLibraryWithConfig(&config);
        std::unique_ptr<Document> doc;
        std::string line;
        while (std::getline(std::cin, line)) {
            J id = nullptr;
            const auto started = std::chrono::steady_clock::now();
            J reply;
            try {
                require(line.size() <= 4 * 1024 * 1024, "RESOURCE_LIMIT", "Request exceeds 4 MiB");
                const auto request = J::parse(line); id = request.at("id");
                auto method = request.at("method").get<std::string>(); const auto& params = request.at("params");
                J value;
                if (method == "hello") value = {{"version", APP_VERSION}, {"protocol", 1}, {"pid", GetCurrentProcessId()}, {"qpdf", QPDF::QPDFVersion()}, {"pdfium", "155.0.8044.0"}, {"capabilities", {"inspect", "query", "stats", "render", "page.crop", "compose", "text.replace", "text.style", "path.style"}}};
                else if (method == "open") {
                    auto next = std::make_unique<Document>(params.at("file"), params.at("sha256"));
                    value = {{"sha256", next->sha}, {"pageCount", next->pages.size()}, {"warnings", next->warnings()}};
                    doc = std::move(next);
                } else if (method == "compose") value = compose(params);
                else if (method == "close") { doc.reset(); value = {{"closed", true}}; }
                else {
                    require(doc != nullptr, "NO_DOCUMENT", "Open a document first");
                    if (method == "inspect" || method == "query") value = inspect(*doc, params);
                    else if (method == "stats") value = stats(*doc, params);
                    else if (method == "render") value = render(*doc, params);
                    else if (method == "apply") value = applyEdits(*doc, params);
                    else throw Failure("UNKNOWN_METHOD", "Unknown engine method");
                }
                reply = {{"id", id}, {"ok", true}, {"result", value}};
            } catch (const Failure& e) {
                reply = {{"id", id}, {"ok", false}, {"error", {{"code", e.code}, {"message", e.what()}}}};
                if (!e.details.is_null()) reply["error"]["details"] = e.details;
            }
            catch (const J::exception& e) { reply = {{"id", id}, {"ok", false}, {"error", {{"code", "INVALID_ARGUMENT"}, {"message", e.what()}}}}; }
            catch (const std::exception& e) { reply = {{"id", id}, {"ok", false}, {"error", {{"code", "PDF_ERROR"}, {"message", e.what()}}}}; }
            reply["engineMs"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
            std::cout << reply.dump(-1, ' ', false, J::error_handler_t::replace) << '\n' << std::flush;
        }
        doc.reset(); FPDF_DestroyLibrary(); CoUninitialize();
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
    return 0;
}
