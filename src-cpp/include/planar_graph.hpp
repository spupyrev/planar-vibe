#pragma once

// Planar embedding helpers + augmentation. Literal port of
// static/js/planar-graph-utils.js via src-python/.../planar_graph.py.
//
// Works with string-id embeddings (matches JS schema exactly) since the
// PlanarEmbedding class mutates the vertex list (adding dummies) and we want
// the resulting "dummy_0" names etc. to round-trip to JSON cleanly.

#include "graph.hpp"
#include "planarity.hpp"

#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace planarvibe::pg {

using PosByStr = std::unordered_map<std::string, Point>;

// Cyclic-sequence comparisons over string faces.
bool same_cyclic_direction(const std::vector<std::string>& a,
                           const std::vector<std::string>& b);
bool same_cyclic_either_direction(const std::vector<std::string>& a,
                                  const std::vector<std::string>& b);

int find_face_index(const std::vector<std::vector<std::string>>& faces,
                    const std::vector<std::string>& face,
                    bool allow_reverse = false);
int find_outer_face_index(const std::vector<std::vector<std::string>>& faces,
                          const std::vector<std::string>& outer);

// Geometry-driven rotation: sort each neighbor list by angle around its vertex.
std::optional<std::unordered_map<std::string, std::vector<std::string>>>
build_rotation_from_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const PosByStr& pos);

// Extract faces from rotation map via half-edge traversal.
std::vector<std::vector<std::string>> extract_faces_from_rotation_map(
    const std::unordered_map<std::string, std::vector<std::string>>& rotation);

// Extract combinatorial embedding from (non-crossing) positions.
// Returns a StringEmbedding (same shape as planarity::compute_planar_embedding)
// or nullopt if positions cross or are non-finite.
std::optional<planarity::StringEmbedding> extract_embedding_from_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const PosByStr& pos);

// Insert `value` before `before_value` in `lst`. No-op if value already exists.
void insert_before(std::vector<std::string>& lst,
                   const std::string& before_value,
                   const std::string& value);

// Mutable planar embedding (augmentation). Maintains node_ids (with dummies),
// edge_pairs, rotation_by_id, and faces.
struct PlanarEmbedding {
    std::vector<std::string> node_ids;
    std::vector<std::pair<std::string,std::string>> edge_pairs;
    std::unordered_map<std::string,int> index_by_id;
    std::unordered_map<std::string, std::vector<std::string>> rotation_by_id;
    std::vector<std::vector<std::string>> faces;
    std::vector<std::string> outer_face;  // empty if unset
    std::unordered_set<std::string> edge_set;  // edge_key -> present

    static PlanarEmbedding from_embedding_object(
        const std::vector<std::string>& node_ids,
        const std::vector<std::pair<std::string,std::string>>& edge_pairs,
        const planarity::StringEmbedding& emb,
        const std::vector<std::string>& outer);

    static std::optional<PlanarEmbedding> from_drawing(
        const std::vector<std::string>& node_ids,
        const std::vector<std::pair<std::string,std::string>>& edge_pairs,
        const PosByStr& pos);

    void recompute_faces();
    bool has_face(const std::vector<std::string>& face) const;
    std::optional<std::vector<std::string>> get_face(const std::vector<std::string>& face) const;

    std::string next_dummy_id(const std::string& prefix) const;
    bool add_edge(const std::string& u, const std::string& v);  // returns false if dup
    void set_outer_face(const std::vector<std::string>& face);

    // Add outer face cycle augmentation (for Tutte / outer-cycle method).
    // Throws std::runtime_error on failure. Returns the created dummy ids.
    std::vector<std::string> add_outer_face_cycle(const std::vector<std::string>& face,
                                                  const std::string& outer_dummy_prefix = "@outerDummy");

    // Returns as a StringEmbedding (for consumption by apply_layout etc).
    planarity::StringEmbedding to_embedding_object() const;
};

// Analyze whether the embedding is internally triangulated (all non-outer faces have length 3).
struct TriangulationCheck {
    bool ok = false;
    std::string reason;
};
TriangulationCheck analyze_internally_triangulated(
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face);

// Longest-face selector for outer-cycle augmentation (prefers chord-free
// longest face from the embedding). Mirrors Python choose_longest_face_from_embedding.
std::vector<std::string> choose_longest_face_from_embedding(
    const planarity::StringEmbedding& emb);

// Triangulation entry points.
struct TriangulationResult {
    bool ok = false;
    std::string reason;
    int dummy_count = 0;
    planarity::StringEmbedding embedding;
    // Final graph (node_ids + edge_pairs) with dummies included.
    std::vector<std::string> node_ids;
    std::vector<std::pair<std::string,std::string>> edge_pairs;
    std::vector<std::string> outer_face;
    std::vector<std::string> outer_dummy_ids;
};

struct TriangulateOptions {
    bool triangulate_outer_face = false;
};

TriangulationResult triangulate_by_face_stellation(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face,
    const TriangulateOptions& opts = {});

TriangulationResult triangulate_by_outer_cycle(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face,
    const TriangulateOptions& opts = {});

// Largest-area face (for outer-face selection when we have positions).
std::optional<std::vector<std::string>> largest_area_face(
    const std::vector<std::vector<std::string>>& faces,
    const PosByStr& pos);

} // namespace planarvibe::pg
