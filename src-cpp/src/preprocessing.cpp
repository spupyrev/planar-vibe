#include "preprocessing.hpp"
#include "layouts/tutte.hpp"

namespace planarvibe::preprocessing {

namespace {

// Build string-id views from the int-keyed Graph.
void unpack(const Graph& graph,
            std::vector<std::string>& out_ids,
            std::vector<std::pair<std::string,std::string>>& out_edges) {
    out_ids = graph.node_names;
    out_edges.reserve(graph.edges.size());
    for (const auto& [u, v] : graph.edges) {
        out_edges.emplace_back(graph.node_names[u], graph.node_names[v]);
    }
}

} // namespace

PreparedGraph prepare_graph_data(const Graph& graph, const PrepareConfig& cfg) {
    PreparedGraph out;
    if (graph.n < 3) {
        out.message = cfg.failure_label + " requires at least 3 vertices";
        return out;
    }
    std::string method = cfg.augmentation_method.empty() ? std::string("outer-cycle")
                                                         : cfg.augmentation_method;
    if (method != "outer-cycle" && method != "face-stellation") {
        out.message = "Unknown augmentation method: " + method;
        return out;
    }

    std::vector<std::string> ids;
    std::vector<std::pair<std::string,std::string>> edges;
    unpack(graph, ids, edges);

    // Try to extract an embedding from current positions.
    std::optional<planarity::StringEmbedding> extracted;
    if (cfg.current_positions && !cfg.current_positions->empty()) {
        extracted = pg::extract_embedding_from_positions(ids, edges, *cfg.current_positions);
    }
    planarity::StringEmbedding base;
    if (extracted && extracted->ok) {
        base = *extracted;
    } else {
        base = planarity::compute_planar_embedding(ids, edges);
    }
    if (!base.ok) {
        out.message = cfg.failure_label + " requires a planar graph";
        return out;
    }

    std::vector<std::string> selected_outer;
    if (method == "outer-cycle") {
        if (extracted && extracted->ok && !extracted->outer_face.empty()) {
            selected_outer = extracted->outer_face;
        } else {
            selected_outer = pg::choose_longest_face_from_embedding(base);
        }
    } else {
        selected_outer = base.outer_face;
    }
    if (selected_outer.size() < 3) {
        out.message = "Could not determine outer boundary for " + cfg.failure_label;
        return out;
    }

    pg::TriangulateOptions topts;
    topts.triangulate_outer_face = cfg.triangulate_outer_face;
    pg::TriangulationResult aug;
    if (method == "outer-cycle") {
        aug = pg::triangulate_by_outer_cycle(ids, edges, base, selected_outer, topts);
    } else {
        aug = pg::triangulate_by_face_stellation(ids, edges, base, selected_outer, topts);
    }
    if (!aug.ok) {
        out.message = aug.reason.empty() ? (cfg.failure_label + " augmentation failed") : aug.reason;
        return out;
    }

    out.ok = true;
    out.node_names = ids;
    out.edge_pairs = edges;
    out.base_embedding = base;
    out.outer_face = selected_outer;
    out.augmented_node_ids = aug.node_ids;
    out.augmented_edge_pairs = aug.edge_pairs;
    out.augmented_embedding = aug.embedding;
    out.augmented_outer_face = aug.outer_face;
    out.outer_dummy_ids = aug.outer_dummy_ids;
    out.dummy_count = aug.dummy_count;
    return out;
}

PreparedWithLayout prepare_graph_and_layout_data(const Graph& graph, const PrepareConfig& cfg) {
    PreparedWithLayout out;
    static_cast<PreparedGraph&>(out) = prepare_graph_data(graph, cfg);
    if (!out.ok) return out;
    // Build adjacency for augmented graph, then run Tutte barycentric init.
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& nid : out.augmented_node_ids) adjacency[nid] = {};
    for (const auto& [u, v] : out.augmented_edge_pairs) {
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
    }
    auto weights = layouts::build_tutte_weights(out.edge_pairs, out.augmented_edge_pairs, out.outer_dummy_ids);
    auto br = layouts::compute_barycentric_positions(out.augmented_node_ids, adjacency,
                                                       out.augmented_outer_face, weights);
    if (!br.ok) {
        out.ok = false;
        out.message = br.message.empty() ? (cfg.failure_label + " initialization failed") : br.message;
        return out;
    }
    out.pos_by_id = std::move(br.positions);
    out.init_iters = br.iters;
    return out;
}

} // namespace planarvibe::preprocessing
