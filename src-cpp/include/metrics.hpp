#pragma once

// Drawing-quality metrics. Literal port of static/js/metrics.js.
// Each function returns a MetricResult { ok, score, ... }.

#include "graph.hpp"
#include "geometry.hpp"

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace planarvibe::metrics {

// All functions return an `ok` flag and on success an optional `score`.
// Callers (apply_layout) pick out `score` — see also the embedding-dependent
// face/convexity variants where `quality` is the score.
struct MetricResult {
    bool ok = false;
    std::string reason;
    std::optional<double> score;    // main quality score
    std::optional<double> quality;  // face/convexity use this
    std::optional<double> ratio;    // edge_length_ratio uses this
};

MetricResult compute_angular_resolution_score(const Graph& g, const PositionMap& pos);
MetricResult compute_axis_alignment_score(int n, const PositionMap& pos);
MetricResult compute_aspect_ratio_score(int n, const PositionMap& pos);
MetricResult compute_node_uniformity_score(int n, const PositionMap& pos);
MetricResult compute_edge_length_deviation_score(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos);
MetricResult compute_edge_length_ratio(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos);
MetricResult compute_edge_orthogonality_score(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos);
MetricResult compute_spacing_uniformity_score(int n, const PositionMap& pos);

// face / convexity require an embedding. `emb` is StringEmbedding.rotation +
// faces; `pos` must map string ids -> (x, y).
struct FaceMetricInput {
    const std::vector<std::vector<std::string>>* faces;
    const std::vector<std::string>* outer_face;
};
MetricResult compute_uniform_face_area_score(
    const FaceMetricInput& in,
    const std::unordered_map<std::string, Point>& pos_by_name);
MetricResult compute_convexity_score(
    const FaceMetricInput& in,
    const std::unordered_map<std::string, Point>& pos_by_name,
    const std::vector<std::string>& node_ids);

} // namespace planarvibe::metrics
