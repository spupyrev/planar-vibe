#pragma once

// Tutte barycentric layout. Literal port of static/js/layout-tutte.js.

#include "graph.hpp"
#include "layout_result.hpp"
#include "planar_graph.hpp"

#include <optional>
#include <unordered_map>

namespace planarvibe::layouts {

LayoutResult tutte(const Graph& g, const pg::PosByStr* initial_positions = nullptr);

// Outer-placement options; also used by reweight to pin outer-face positions.
struct TutteOuterPlacement {
    double cx = 450.0;
    double cy = 310.0;
    double R = 300.0;
    std::optional<double> outer_rotation;
    // If set, overrides circle placement for specified ids.
    const pg::PosByStr* fixed_outer_pos = nullptr;
};

// Place outer face vertices on a circle (or via fixed_outer_pos overrides).
pg::PosByStr place_outer_face_vertices(
    const std::vector<std::string>& node_ids,
    const std::vector<std::string>& outer_face,
    const TutteOuterPlacement& opts = {});

// Build standard Tutte edge weights for a (possibly augmented) graph.
// Keys are `edge_key_str(a, b)` (sorted).
std::unordered_map<std::string, double> build_tutte_weights(
    const std::vector<std::pair<std::string,std::string>>& original_pairs,
    const std::vector<std::pair<std::string,std::string>>& augmented_pairs,
    const std::vector<std::string>& outer_dummy_ids);

// Exact barycentric solve with caller-supplied adjacency and edge weights.
// Used by reweight (custom weights), fpp, schnyder, and Tutte itself.
struct BarycentricResult {
    bool ok = false;
    std::string message;
    pg::PosByStr positions;
    int iters = 0;
};
BarycentricResult compute_barycentric_positions(
    const std::vector<std::string>& node_ids,
    const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
    const std::vector<std::string>& outer_face,
    const std::unordered_map<std::string, double>& weights,
    const TutteOuterPlacement& placement = {});

} // namespace planarvibe::layouts
