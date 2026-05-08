#pragma once
// Shared helpers for gpt + claude ensembles.
// Structural detectors (tree/unicyclic/grid/outerplanar/core-tree),
// position computers, evaluate/polish routines. Port of parts of
// src-python/planarvibe/layouts/{gpt,claude}.py that both share.

#include "graph.hpp"
#include "planar_graph.hpp"
#include "planarity.hpp"

#include <array>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace planarvibe::ensemble {

struct GraphInfo {
    std::unordered_map<std::string, int> degree;
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
};

GraphInfo build_graph_info(const std::vector<std::string>& node_ids,
                           const std::vector<std::pair<std::string,std::string>>& edge_pairs);

bool is_connected(const std::vector<std::string>& node_ids, const GraphInfo& info);
bool is_tree_graph(const std::vector<std::string>& node_ids,
                   const std::vector<std::pair<std::string,std::string>>& edge_pairs);

struct PositionResult {
    bool ok = false;
    std::string message;
    pg::PosByStr positions;  // keyed by string id
};

PositionResult compute_tree_positions(const std::vector<std::string>& node_ids,
                                      const std::vector<std::pair<std::string,std::string>>& edge_pairs);
PositionResult compute_radial_tree_positions(const std::vector<std::string>& node_ids,
                                              const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// Unicyclic
bool is_unicyclic_graph(const std::vector<std::string>& node_ids,
                        const std::vector<std::pair<std::string,std::string>>& edge_pairs);
PositionResult compute_unicyclic_positions(const std::vector<std::string>& node_ids,
                                            const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// Grid
bool has_rectangular_grid_signature(const std::vector<std::string>& node_ids,
                                     const std::vector<std::pair<std::string,std::string>>& edge_pairs);
PositionResult compute_rectangular_grid_positions(const std::vector<std::string>& node_ids,
                                                   const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// Outerplanar circle
bool is_outerplanar_graph(const std::vector<std::string>& node_ids,
                          const std::vector<std::pair<std::string,std::string>>& edge_pairs);
PositionResult compute_outerplanar_circle_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// Planar-3-tree detector (wraps planarity::analyze_planar_3_tree).
bool is_planar_3_tree(const std::vector<std::string>& node_ids,
                      const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// Core-tree info
struct TwoCoreInfo {
    bool ok = false;
    GraphInfo info;
    std::vector<std::string> core;
    std::unordered_map<std::string, bool> core_set;
    std::vector<std::string> core_node_ids;
    std::vector<std::pair<std::string,std::string>> core_edge_pairs;
};
TwoCoreInfo compute_two_core_info(const std::vector<std::string>& node_ids,
                                   const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                                   int core_tree_max_nodes, int core_tree_max_core_nodes);

// Compute core-tree positions given a ported core-layout (edgebalancer)
// result. `core_positions` is a PosByStr holding the positions for core nodes.
PositionResult compute_core_tree_positions_with_core(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const TwoCoreInfo& core_info,
    const pg::PosByStr& core_positions);

// Median edge length (finite) filtered by predicate.
std::optional<double> median_edge_length(
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::function<bool(const std::string&, const std::string&)>& pred = {});

std::optional<double> median_finite(std::vector<double> v);

// Leaf-spread helper (gpt specific).
struct LeafSpreadOptions {
    int min_leaves = 4;
};
PositionResult compute_leaf_spread_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& base_positions,
    const LeafSpreadOptions& opts);

// Evaluation: compute the 10-metric total used by both ensembles.
struct EvalResult {
    bool ok = false;
    std::string reason;
    double score = 0;
    std::unordered_map<std::string, double> metrics;
    pg::PosByStr positions;
    double rotation = 0;
    double stretch = 1;
};

// Graph accessor for angular-resolution metric (which takes a Graph& in C++).
// Callers pass a reference to the original Graph.
class GraphRef {
public:
    explicit GraphRef(const Graph& g) : g_(&g) {}
    const Graph& operator*() const { return *g_; }
    const Graph* operator->() const { return g_; }
private:
    const Graph* g_;
};

EvalResult evaluate_positions(const GraphRef& graph,
                              const std::vector<std::string>& node_ids,
                              const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                              const pg::PosByStr& pos,
                              bool assume_plane);

// Transform (rotate + anisotropic stretch) about centroid.
pg::PosByStr transform_positions(const pg::PosByStr& pos,
                                 const std::vector<std::string>& node_ids,
                                 double angle, double stretch);

// gpt-style best-transform search: tries rotationSamples rotations × stretches.
EvalResult best_transform_for_candidate(const GraphRef& graph,
                                         const std::vector<std::string>& node_ids,
                                         const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                                         const pg::PosByStr& pos,
                                         int rotation_samples,
                                         const std::vector<double>& stretch_factors);

// gpt polish (direction-sweep local moves).
struct PolishResult {
    bool ok = false;
    double score = 0;
    int moves = 0;
    int evaluations = 0;
    pg::PosByStr positions;
};
PolishResult compute_polished_positions_gpt(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& seed, double seed_score,
    int max_evaluations);

// claude-specific scoring (returns all-per-metric dict including 'total').
std::unordered_map<std::string, double> compute_scores_claude(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding);

// claude polish (DIRS8 steps, planarity-preserving).
struct ClaudePolishOptions {
    int max_passes = 2;
    double step_scale = 0.08;
    double min_step_scale = 0.005;
};
struct ClaudePolishResult {
    pg::PosByStr positions;
    std::unordered_map<std::string, double> scores;
    std::optional<planarity::StringEmbedding> embedding;
};
ClaudePolishResult polish_by_local_moves(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    const ClaudePolishOptions& opts);

// Convexity repair pass for claude.
ClaudePolishResult convexity_repair(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    int max_passes);

// Best-rotation search (claude): 19 samples in [0, pi/2].
struct RotResult { pg::PosByStr positions; std::unordered_map<std::string,double> scores; };
RotResult find_best_rotation_claude(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding);

// Seeded LCG matching Python _seeded_rng.
struct LCGRng {
    uint32_t state;
    explicit LCGRng(uint32_t seed) : state(seed == 0 ? 1u : seed) {}
    double next() {
        state = (uint32_t)(state * 1664525u + 1013904223u);
        return (double)state / 4294967296.0;
    }
};
LCGRng make_seeded_rng(const std::vector<std::string>& node_ids,
                       const std::vector<std::pair<std::string,std::string>>& edge_pairs);

// claude restart+perturb+polish.
ClaudePolishResult restart_perturb_and_polish(
    const GraphRef& graph,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    LCGRng& rng, double perturb_scale, int max_passes, double step_scale);

} // namespace planarvibe::ensemble
