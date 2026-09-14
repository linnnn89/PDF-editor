cmake_minimum_required(VERSION 3.24)
project(agent_pdf_editor LANGUAGES CXX)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Windows x64 is required")
endif()
file(READ "${CMAKE_SOURCE_DIR}/package.json" PACKAGE_JSON)
string(JSON APP_VERSION GET "${PACKAGE_JSON}" version)
set(QPDF_ROOT "${CMAKE_SOURCE_DIR}/vendor/qpdf/qpdf-12.4.1-msvc64")
set(PDFIUM_ROOT "${CMAKE_SOURCE_DIR}/vendor/pdfium")
if(NOT EXISTS "${QPDF_ROOT}/lib/qpdf.lib" OR NOT EXISTS "${PDFIUM_ROOT}/lib/pdfium.dll.lib")
  message(FATAL_ERROR "Run npm run setup first")
endif()
add_executable(pdf-engine native/main.cpp)
# Localized MSVC include output can lose dependency tracking in Ninja. Keep
# the engine's project headers explicit so a header edit always rebuilds it.
set_property(SOURCE native/main.cpp APPEND PROPERTY OBJECT_DEPENDS
  "${CMAKE_SOURCE_DIR}/native/editing.h"
  "${CMAKE_SOURCE_DIR}/native/font_extension.h"
  "${CMAKE_SOURCE_DIR}/native/glyph_names.h")
target_compile_features(pdf-engine PRIVATE cxx_std_20)
target_compile_definitions(pdf-engine PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN APP_VERSION="${APP_VERSION}")
target_compile_options(pdf-engine PRIVATE /W4 /EHsc /utf-8)
target_include_directories(pdf-engine PRIVATE "${QPDF_ROOT}/include" "${PDFIUM_ROOT}/include" vendor/json)
target_link_libraries(pdf-engine PRIVATE "${QPDF_ROOT}/lib/qpdf.lib" "${PDFIUM_ROOT}/lib/pdfium.dll.lib" bcrypt windowscodecs ole32 dwrite)
set_target_properties(pdf-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
file(GLOB QPDF_DLLS "${QPDF_ROOT}/bin/*.dll")
add_custom_command(TARGET pdf-engine POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${QPDF_DLLS} "${PDFIUM_ROOT}/bin/pdfium.dll" "$<TARGET_FILE_DIR:pdf-engine>"
  COMMAND_EXPAND_LISTS)
