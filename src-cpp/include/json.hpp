#pragma once

// Minimal JSON writer for apply_layout output. We only need object/array of
// number/string/bool/null; no parsing. Uses std::ostream. Keeps the schema
// identical to src-python/scripts/apply_layout.py for harness interop.

#include <cmath>
#include <cstdio>
#include <ostream>
#include <sstream>
#include <string>
#include <vector>

namespace planarvibe::json {

inline void write_string(std::ostream& os, const std::string& s) {
    os << '"';
    for (char c : s) {
        switch (c) {
            case '"':  os << "\\\""; break;
            case '\\': os << "\\\\"; break;
            case '\b': os << "\\b"; break;
            case '\f': os << "\\f"; break;
            case '\n': os << "\\n"; break;
            case '\r': os << "\\r"; break;
            case '\t': os << "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    os << buf;
                } else {
                    os << c;
                }
        }
    }
    os << '"';
}

inline void write_double(std::ostream& os, double v) {
    if (std::isnan(v) || std::isinf(v)) { os << "null"; return; }
    // Use 17 sig digits (round-trip for double).
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    os << buf;
}

} // namespace planarvibe::json
