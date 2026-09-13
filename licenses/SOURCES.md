# Third-party notices for the packaged native runtime

These files accompany the unchanged qpdf 12.4.1 Windows x64 DLL and its statically
linked dependencies. This software is based in part on the work of the
Independent JPEG Group.

Retrieved on 2026-09-13 from the following upstream release tags:

| Local file | Upstream source |
| --- | --- |
| qpdf-LICENSE.txt | https://raw.githubusercontent.com/qpdf/qpdf/v12.4.1/LICENSE.txt |
| qpdf-NOTICE.md | https://raw.githubusercontent.com/qpdf/qpdf/v12.4.1/NOTICE.md |
| openssl-LICENSE.txt | https://raw.githubusercontent.com/openssl/openssl/openssl-3.6.3/LICENSE.txt |
| libjpeg-turbo-LICENSE.md | https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.2.0/LICENSE.md |
| libjpeg-turbo-README.ijg | https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.2.0/README.ijg |
| zlib-LICENSE.txt | https://raw.githubusercontent.com/madler/zlib/v1.3.2/LICENSE |

The qpdf v12.4.1 `vcpkg-setup-win` and `build-scripts/package-vcpkg` select
OpenSSL, libjpeg-turbo, and zlib for static linking. The distributed qpdf30.dll
contains the version strings `3.6.3`, `libjpeg-turbo version 3.2.0 (build
20260827)`, and `deflate 1.3.2 Copyright 1995-2026 Jean-loup Gailly and Mark
Adler`. Running the upstream qpdf executable with `--show-crypto` reports
`openssl` and `native`. The OpenSSL version is inferred from the binary version
string together with that provider and the upstream dependency list; it is not
a build provenance attestation. The upstream build downloads a rotating vcpkg
cache rather than pinning these dependency versions in the release source.

PDFium's package-level LICENSE and complete licenses directory, and the
nlohmann JSON MIT license, are copied separately from the locked vendor inputs
by the packaging script.

The unmodified Microsoft Visual C++ runtime DLLs supplied with the upstream
qpdf Windows archive are Microsoft software, not covered by qpdf's Apache
license. Their redistribution remains subject to the applicable Visual Studio
license terms. Microsoft's distributable-code list permits licensed Visual
Studio users to redistribute the applicable release runtime files unchanged;
debug and preview exclusions apply. This notice does not grant additional
rights. No separate runtime license text was present in the qpdf archive.

- https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution
- https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files

Node.js is an external prerequisite and is not included in the runtime package.
