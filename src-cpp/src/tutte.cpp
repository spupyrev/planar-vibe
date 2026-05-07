#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "linear_algebra.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <unordered_set>

namespace planarvibe::layouts {

namespace {

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

} // namespace

pg::PosByStr place_outer_face_vertices(
    const std::vector<std::string>& node_ids,
    const std::vector<std::string>& outer_face,
    const TutteOuterPlacement& opts) {
    pg::PosByStr pos;
    for (const auto& nid : node_ids) pos[nid] = {0.0, 0.0};
    if (outer_face.empty()) return pos;
    double gamma = 2.0 * M_PI / outer_face.size();
    double start_angle = opts.outer_rotation ? *opts.outer_rotation : (M_PI / 2.0 - gamma / 2.0);
    for (size_t i = 0; i < outer_face.size(); ++i) {
        double a = start_angle + gamma * i;
        pos[outer_face[i]] = {opts.cx + opts.R * std::cos(a), opts.cy + opts.R * std::sin(a)};
    }
    if (opts.fixed_outer_pos) {
        for (const auto& nid : outer_face) {
            auto it = opts.fixed_outer_pos->find(nid);
            if (it == opts.fixed_outer_pos->end()) continue;
            double x = it->second[0], y = it->second[1];
            if (std::isfinite(x) && std::isfinite(y)) pos[nid] = {x, y};
        }
    }
    return pos;
}

std::unordered_map<std::string, double> build_tutte_weights(
    const std::vector<std::pair<std::string,std::string>>& original_pairs,
    const std::vector<std::pair<std::string,std::string>>& augmented_pairs,
    const std::vector<std::string>& outer_dummy_ids) {
    std::unordered_map<std::string, double> weights;
    std::unordered_set<std::string> outer_dummy_set(outer_dummy_ids.begin(), outer_dummy_ids.end());
    std::unordered_set<std::string> original_edge_set;
    for (const auto& [u, v] : original_pairs) original_edge_set.insert(ekey(u, v));

    std::unordered_map<std::string, int> deg;
    for (const auto& [u, v] : augmented_pairs) { deg[u]++; deg[v]++; }

    for (const auto& [u, v] : augmented_pairs) {
        std::string k = ekey(u, v);
        bool touches_outer = outer_dummy_set.count(u) || outer_dummy_set.count(v);
        double base = (!original_edge_set.count(k) && touches_outer) ? 10.0 : 1.0;
        int du = std::max(1, deg.count(u) ? deg[u] : 0);
        int dv = std::max(1, deg.count(v) ? deg[v] : 0);
        base /= std::sqrt(double(du) * double(dv));
        weights[k] = base;
    }
    return weights;
}

BarycentricResult compute_barycentric_positions(
    const std::vector<std::string>& node_ids,
    const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
    const std::vector<std::string>& outer_face,
    const std::unordered_map<std::string, double>& weights,
    const TutteOuterPlacement& placement) {
    BarycentricResult r;
    if (node_ids.empty()) { r.message = "No vertices"; return r; }
    if (outer_face.size() < 3) { r.message = "Outer face is invalid"; return r; }

    auto pos = place_outer_face_vertices(node_ids, outer_face, placement);
    std::unordered_set<std::string> outer_set(outer_face.begin(), outer_face.end());
    std::vector<std::string> interior;
    std::unordered_map<std::string, int> interior_idx;
    for (const auto& nid : node_ids) {
        if (outer_set.count(nid)) continue;
        interior_idx[nid] = (int)interior.size();
        interior.push_back(nid);
    }
    if (interior.empty()) {
        r.ok = true;
        r.iters = 1;
        r.positions = pos;
        return r;
    }

    int n = (int)interior.size();
    std::vector<std::vector<double>> L(n, std::vector<double>(n, 0.0));
    std::vector<double> bx(n, 0.0), by(n, 0.0);
    for (int i = 0; i < n; ++i) {
        L[i][i] = 1.0;
        auto it = adjacency.find(interior[i]);
        if (it == adjacency.end()) continue;
        const auto& neighbors = it->second;
        std::vector<double> raw(neighbors.size(), 0.0);
        double sum = 0.0;
        for (size_t j = 0; j < neighbors.size(); ++j) {
            auto wit = weights.find(ekey(interior[i], neighbors[j]));
            double w = (wit != weights.end() && std::isfinite(wit->second) && wit->second > 0) ? wit->second : 1.0;
            raw[j] = w;
            sum += w;
        }
        if (!(sum > 0)) continue;
        for (size_t j = 0; j < neighbors.size(); ++j) {
            double w = raw[j] / sum;
            auto iit = interior_idx.find(neighbors[j]);
            if (iit == interior_idx.end()) {
                auto pit = pos.find(neighbors[j]);
                if (pit == pos.end()) continue;
                bx[i] += w * pit->second[0];
                by[i] += w * pit->second[1];
            } else {
                L[i][iit->second] -= w;
            }
        }
    }

    auto factor = la::lu_factorize(L);
    if (!factor) { r.message = "Exact barycentric solve failed"; return r; }
    auto solved = la::solve_lu_with_two_rhs(*factor, bx, by);
    if (!solved) { r.message = "Exact barycentric solve failed"; return r; }
    for (int i = 0; i < n; ++i) pos[interior[i]] = {solved->first[i], solved->second[i]};

    r.ok = true;
    r.iters = 1;
    r.positions = std::move(pos);
    return r;
}

LayoutResult tutte(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = "Tutte layout";
    cfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, cfg);
    if (!prep.ok) {
        r.ok = false;
        r.message = prep.message.empty() ? "Tutte failed" : prep.message;
        return r;
    }

    // Build adjacency for augmented graph.
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& nid : prep.augmented_node_ids) adjacency[nid] = {};
    for (const auto& [u, v] : prep.augmented_edge_pairs) {
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
    }

    auto weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);

    auto br = compute_barycentric_positions(prep.augmented_node_ids, adjacency,
                                            prep.augmented_outer_face, weights);
    if (!br.ok) {
        r.ok = false;
        r.message = br.message.empty() ? "Tutte failed" : br.message;
        return r;
    }

    r.iters = br.iters;
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = br.positions.find(g.node_names[i]);
        if (it != br.positions.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            r.positions.put(i, it->second[0], it->second[1]);
        }
    }
    if (geo::has_position_crossings(r.positions, g.edges)) {
        r.ok = false;
        r.message = "Tutte produced a non-plane drawing";
    } else {
        r.ok = true;
        r.message = "Tutte layout";
    }
    return r;
}

} // namespace planarvibe::layouts
