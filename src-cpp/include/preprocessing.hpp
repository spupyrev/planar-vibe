#pragma once

// Layout preprocessing. Literal port of static/js/layout-preprocessing.js.

#include "graph.hpp"
#include "planar_graph.hpp"
#include "planarity.hpp"

#include <string>
#include <vector>

namespace planarvibe::preprocessing {

struct PreparedGraph {
    bool ok = false;
    std::string message;
    // Original graph inputs.
    std::vector<std::string> node_names;
    std::vector<std::pair<std::string,std::string>> edge_pairs;
    // Combinatorial planar embedding of the original graph.
    planarity::StringEmbedding base_embedding;
    // Outer face selected for the original graph (length >= 3).
    std::vector<std::string> outer_face;
    // Augmented graph: node_ids / edge_pairs include dummies, embedding is triangulated.
    std::vector<std::string> augmented_node_ids;
    std::vector<std::pair<std::string,std::string>> augmented_edge_pairs;
    planarity::StringEmbedding augmented_embedding;
    std::vector<std::string> augmented_outer_face;
    std::vector<std::string> outer_dummy_ids;
    int dummy_count = 0;
};

struct PrepareConfig {
    std::string failure_label = "Layout";
    // "outer-cycle" (default) or "face-stellation"
    std::string augmentation_method = "outer-cycle";
    const pg::PosByStr* current_positions = nullptr;
    // Forwarded to the triangulation step.
    bool triangulate_outer_face = false;
};

PreparedGraph prepare_graph_data(const Graph& graph, const PrepareConfig& cfg);

// Extended prepared graph that also includes Tutte-barycentric positions on the
// augmented graph (used by ForceDir / air / reweight for an initial seed).
struct PreparedWithLayout : PreparedGraph {
    pg::PosByStr pos_by_id;
    int init_iters = 0;
};

PreparedWithLayout prepare_graph_and_layout_data(const Graph& graph, const PrepareConfig& cfg);

} // namespace planarvibe::preprocessing
