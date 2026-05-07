#pragma once

// alignToAxisGreedy — literal port of static/js/alignment.js.
// Greedy axis-alignment sweep: merge close x-coords (then y-coords) into
// shared gridlines as long as doing so doesn't introduce edge crossings.

#include "graph.hpp"

#include <string>
#include <unordered_map>
#include <vector>

namespace planarvibe::alignment {

struct AlignResult {
    bool ok = false;
    std::string reason;
    bool changed = false;
    std::unordered_map<std::string, Point> positions;
    int merged_count_x = 0;
    int merged_count_y = 0;
};

AlignResult align_to_axis_greedy(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const std::unordered_map<std::string, Point>& pos);

} // namespace planarvibe::alignment
