#pragma once

#include "graph.hpp"

#include <map>
#include <string>
#include <variant>

namespace planarvibe {

// Matches JS buildLayoutResult. `extras` holds per-layout extra fields that
// don't appear on every layout (edgeLengthDeviation, minAngleRatio, etc.).
struct LayoutResult {
    bool ok = false;
    std::string message;
    PositionMap positions;
    std::map<std::string, double> metrics;  // camelCase keys, matches JS schema
    bool is_plane = false;
    std::optional<double> E;
    std::optional<int> iters;
    std::string stop_reason;
    // Catch-all for layout-specific extras. Key -> string or double.
    std::map<std::string, std::variant<double, std::string>> extras;
};

} // namespace planarvibe
