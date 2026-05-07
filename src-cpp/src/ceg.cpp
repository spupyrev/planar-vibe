#include "layouts/ceg.hpp"
#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>
#include <unordered_map>
#include <unordered_set>

namespace planarvibe::layouts {

namespace {

constexpr double BFS_BASE_WEIGHT = 1.0;
constexpr double BFS_DEPTH_RATIO = 1.35;
constexpr double XY_LAMBDA = 0.5;

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

struct CEGState {
    preprocessing::PreparedGraph prep;
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    std::string failure_label;
};

CEGState build_state(const Graph& g, const std::string& label, const pg::PosByStr* initial_positions) {
    CEGState s;
    s.failure_label = label;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = label;
    cfg.current_positions = initial_positions;
    s.prep = preprocessing::prepare_graph_data(g, cfg);
    if (!s.prep.ok) return s;
    for (const auto& nid : s.prep.augmented_node_ids) s.adjacency[nid] = {};
    for (const auto& [u, v] : s.prep.augmented_edge_pairs) {
        s.adjacency[u].push_back(v);
        s.adjacency[v].push_back(u);
    }
    return s;
}

std::unordered_map<std::string, double> bfs_depth_from_outer(
    const std::vector<std::string>& node_ids,
    const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
    const std::vector<std::string>& outer_face) {
    std::unordered_map<std::string, double> depth;
    for (const auto& nid : node_ids) depth[nid] = std::numeric_limits<double>::infinity();
    std::deque<std::string> q;
    for (const auto& r : outer_face) {
        depth[r] = 0;
        q.push_back(r);
    }
    while (!q.empty()) {
        std::string u = q.front(); q.pop_front();
        double du = depth[u];
        auto it = adjacency.find(u);
        if (it == adjacency.end()) continue;
        for (const auto& v : it->second) {
            if (depth[v] <= du + 1) continue;
            depth[v] = du + 1;
            q.push_back(v);
        }
    }
    for (const auto& nid : node_ids) if (!std::isfinite(depth[nid])) depth[nid] = 0;
    return depth;
}

std::unordered_map<std::string, double> build_depth_weights(
    const std::vector<std::pair<std::string,std::string>>& pairs,
    const std::unordered_map<std::string, double>& depth,
    double scale, double ratio) {
    std::unordered_map<std::string, double> out;
    for (const auto& [u, v] : pairs) {
        double du = depth.count(u) ? depth.at(u) : 0;
        double dv = depth.count(v) ? depth.at(v) : 0;
        double d = 1 + std::min(du, dv);
        if (!std::isfinite(d) || d < 0) d = 0;
        double w = scale / std::pow(ratio, d);
        if (!(w > 0)) w = 1.0;
        out[ekey(u, v)] = w;
    }
    return out;
}

bool has_vertical_spread_edge(
    const std::vector<std::pair<std::string,std::string>>& pairs,
    const pg::PosByStr& pos, double eps = 1e-7) {
    for (const auto& [u, v] : pairs) {
        auto ip = pos.find(u), iq = pos.find(v);
        if (ip == pos.end() || iq == pos.end()) continue;
        if (std::abs(ip->second[0] - iq->second[0]) <= eps) return true;
    }
    return false;
}

pg::PosByStr rotate_for_spread(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& pairs,
    const pg::PosByStr& pos) {
    Point center = geo::compute_face_centroid_names(pos, node_ids);
    static const double angles[] = {0, 1e-6, -1e-6, 1e-5, -1e-5, 1e-4, -1e-4,
                                     1e-3, -1e-3, 1e-2, -1e-2, M_PI / 180.0, -M_PI / 180.0};
    for (double ang : angles) {
        auto r = geo::rotate_position_map_names(pos, center, ang);
        if (!has_vertical_spread_edge(pairs, r)) return r;
    }
    return geo::rotate_position_map_names(pos, center, 1e-2);
}

std::vector<std::string> sorted_node_ids(
    const std::vector<std::string>& node_ids, const pg::PosByStr& pos, int axis_idx) {
    std::vector<std::string> v = node_ids;
    std::stable_sort(v.begin(), v.end(), [&](const std::string& a, const std::string& b) {
        auto ia = pos.find(a), ib = pos.find(b);
        double va = (ia != pos.end() && std::isfinite(ia->second[axis_idx])) ? ia->second[axis_idx] : 0;
        double vb = (ib != pos.end() && std::isfinite(ib->second[axis_idx])) ? ib->second[axis_idx] : 0;
        if (std::abs(va - vb) > 1e-9) return va < vb;
        return a < b;
    });
    return v;
}

struct Orientation {
    std::vector<std::string> sorted_ids;
    std::unordered_map<std::string, int> order;
    std::string source, sink;
    std::unordered_map<std::string, std::vector<std::string>> out_adj, in_adj;
    std::unordered_map<std::string, int> out_degree, in_degree;
    std::unordered_map<std::string, std::pair<std::string, std::string>> edge_dir;  // key -> (from, to)
};

Orientation build_spread_orientation(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& pairs,
    const pg::PosByStr& pos) {
    Orientation o;
    o.sorted_ids = sorted_node_ids(node_ids, pos, 0);
    for (int i = 0; i < (int)o.sorted_ids.size(); ++i) o.order[o.sorted_ids[i]] = i;
    for (const auto& nid : o.sorted_ids) {
        o.out_adj[nid] = {};
        o.in_adj[nid] = {};
        o.out_degree[nid] = 0;
        o.in_degree[nid] = 0;
    }
    for (const auto& [a, b] : pairs) {
        std::string u = (o.order[a] < o.order[b]) ? a : b;
        std::string v = (u == a) ? b : a;
        o.out_adj[u].push_back(v);
        o.in_adj[v].push_back(u);
        o.out_degree[u]++;
        o.in_degree[v]++;
        o.edge_dir[ekey(a, b)] = {u, v};
    }
    o.source = o.sorted_ids.front();
    o.sink = o.sorted_ids.back();
    return o;
}

struct Tree {
    bool ok = false;
    std::unordered_map<std::string, std::string> parent;
    std::unordered_map<std::string, std::vector<std::string>> children;
    std::unordered_map<std::string, double> dist;
};

Tree build_forward_tree(const std::vector<std::string>& sorted_ids,
                        const std::unordered_map<std::string, std::vector<std::string>>& in_adj,
                        const std::string& source) {
    Tree t;
    for (const auto& nid : sorted_ids) {
        t.dist[nid] = std::numeric_limits<double>::infinity();
        t.children[nid] = {};
    }
    t.dist[source] = 0;
    for (const auto& nid : sorted_ids) {
        if (nid == source) continue;
        auto it = in_adj.find(nid);
        if (it == in_adj.end()) return t;
        std::string best;
        double best_dist = std::numeric_limits<double>::infinity();
        for (const auto& pred : it->second) {
            if (t.dist[pred] < best_dist) { best_dist = t.dist[pred]; best = pred; }
        }
        if (best.empty() || !std::isfinite(best_dist)) return t;
        t.parent[nid] = best;
        t.dist[nid] = best_dist + 1;
        t.children[best].push_back(nid);
    }
    t.ok = true;
    return t;
}

Tree build_backward_tree(const std::vector<std::string>& sorted_ids,
                         const std::unordered_map<std::string, std::vector<std::string>>& out_adj,
                         const std::string& sink) {
    Tree t;
    for (const auto& nid : sorted_ids) {
        t.dist[nid] = std::numeric_limits<double>::infinity();
        t.children[nid] = {};
    }
    t.dist[sink] = 0;
    for (auto it = sorted_ids.rbegin(); it != sorted_ids.rend(); ++it) {
        if (*it == sink) continue;
        auto oit = out_adj.find(*it);
        if (oit == out_adj.end()) return t;
        std::string best;
        double best_dist = std::numeric_limits<double>::infinity();
        for (const auto& succ : oit->second) {
            if (t.dist[succ] < best_dist) { best_dist = t.dist[succ]; best = succ; }
        }
        if (best.empty() || !std::isfinite(best_dist)) return t;
        t.parent[*it] = best;
        t.dist[*it] = best_dist + 1;
        t.children[best].push_back(*it);
    }
    t.ok = true;
    return t;
}

std::unordered_map<std::string, double> forward_subtree_sums(
    const std::vector<std::string>& sorted_ids,
    const std::unordered_map<std::string, std::vector<std::string>>& children,
    const std::unordered_map<std::string, int>& values) {
    std::unordered_map<std::string, double> s;
    for (const auto& nid : sorted_ids) {
        auto vit = values.find(nid);
        s[nid] = (vit != values.end() && std::isfinite((double)vit->second)) ? vit->second : 0;
    }
    for (auto it = sorted_ids.rbegin(); it != sorted_ids.rend(); ++it) {
        auto cit = children.find(*it);
        if (cit == children.end()) continue;
        for (const auto& kid : cit->second) s[*it] += s[kid];
    }
    return s;
}

std::unordered_map<std::string, double> backward_subtree_sums(
    const std::vector<std::string>& sorted_ids,
    const std::unordered_map<std::string, std::string>& parent,
    const std::unordered_map<std::string, int>& values) {
    std::unordered_map<std::string, double> s;
    for (const auto& nid : sorted_ids) {
        auto vit = values.find(nid);
        s[nid] = (vit != values.end() && std::isfinite((double)vit->second)) ? vit->second : 0;
    }
    for (const auto& nid : sorted_ids) {
        auto pit = parent.find(nid);
        if (pit != parent.end()) s[pit->second] += s[nid];
    }
    return s;
}

std::unordered_map<std::string, double> rank_spaced_target_x(
    const std::vector<std::string>& sorted_ids, const pg::PosByStr& pos) {
    std::unordered_map<std::string, double> t;
    double mn = std::numeric_limits<double>::infinity(), mx = -mn;
    for (const auto& nid : sorted_ids) {
        auto it = pos.find(nid);
        if (it != pos.end() && std::isfinite(it->second[0])) {
            mn = std::min(mn, it->second[0]);
            mx = std::max(mx, it->second[0]);
        }
    }
    if (!(mx > mn)) {
        for (int i = 0; i < (int)sorted_ids.size(); ++i) t[sorted_ids[i]] = i;
        return t;
    }
    double step = (mx - mn) / std::max(1, (int)sorted_ids.size() - 1);
    for (int i = 0; i < (int)sorted_ids.size(); ++i) t[sorted_ids[i]] = mn + step * i;
    return t;
}

struct SpreadWeights {
    bool ok = false;
    std::string message;
    std::unordered_map<std::string, double> weights;
};

SpreadWeights build_spread_path_weights(const CEGState& s, const pg::PosByStr& working_pos) {
    SpreadWeights r;
    auto orient = build_spread_orientation(s.prep.augmented_node_ids, s.prep.augmented_edge_pairs, working_pos);
    auto fwd = build_forward_tree(orient.sorted_ids, orient.in_adj, orient.source);
    auto bwd = build_backward_tree(orient.sorted_ids, orient.out_adj, orient.sink);
    if (!fwd.ok || !bwd.ok) {
        r.message = s.failure_label + " could not build spread trees";
        return r;
    }
    auto tx = rank_spaced_target_x(orient.sorted_ids, working_pos);
    auto fs = forward_subtree_sums(orient.sorted_ids, fwd.children, orient.out_degree);
    auto bs = backward_subtree_sums(orient.sorted_ids, bwd.parent, orient.in_degree);
    for (const auto& [a, b] : s.prep.augmented_edge_pairs) {
        std::string k = ekey(a, b);
        auto eit = orient.edge_dir.find(k);
        if (eit == orient.edge_dir.end()) continue;
        const auto& [u, v] = eit->second;
        double delta = tx[v] - tx[u];
        if (!(delta > 1e-9)) delta = 1e-9;
        double count = 1;
        auto fp = fwd.parent.find(v);
        if (fp != fwd.parent.end() && fp->second == u) count += fs[v];
        auto bp = bwd.parent.find(u);
        if (bp != bwd.parent.end() && bp->second == v) count += bs[u];
        double w = count / delta;
        if (!std::isfinite(w) || !(w > 0)) w = 1.0;
        r.weights[k] = w;
    }
    r.ok = true;
    return r;
}

SpreadWeights build_spread_state(const CEGState& s, const pg::PosByStr& base_positions, double angle) {
    Point center = geo::compute_face_centroid_names(base_positions, s.prep.augmented_node_ids);
    auto rotated = geo::rotate_position_map_names(base_positions, center,
                                                   std::isfinite(angle) ? angle : 0);
    auto working = rotate_for_spread(s.prep.augmented_node_ids, s.prep.augmented_edge_pairs, rotated);
    return build_spread_path_weights(s, working);
}

std::unordered_map<std::string, double> combine_weights(
    const std::vector<std::pair<std::string,std::string>>& pairs,
    const std::unordered_map<std::string, double>& wa,
    const std::unordered_map<std::string, double>& wb,
    double lambda_a) {
    std::unordered_map<std::string, double> out;
    double lam = std::isfinite(lambda_a) ? std::max(0.0, std::min(1.0, lambda_a)) : 0.5;
    double lam_b = 1.0 - lam;
    for (const auto& [u, v] : pairs) {
        std::string k = ekey(u, v);
        double a = 1, b = 1;
        auto ait = wa.find(k); if (ait != wa.end() && std::isfinite(ait->second)) a = ait->second;
        auto bit = wb.find(k); if (bit != wb.end() && std::isfinite(bit->second)) b = bit->second;
        double w = lam * a + lam_b * b;
        if (!std::isfinite(w) || !(w > 0)) w = 1.0;
        out[k] = w;
    }
    return out;
}

LayoutResult finalize(const Graph& g, const CEGState& /*s*/,
                      const pg::PosByStr& positions, const std::string& label) {
    LayoutResult r;
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = positions.find(g.node_names[i]);
        if (it != positions.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            r.positions.put(i, it->second[0], it->second[1]);
        }
    }
    if (geo::has_position_crossings(r.positions, g.edges)) {
        r.ok = false;
        r.message = label + " produced a non-plane drawing";
        return r;
    }
    r.ok = true;
    r.message = label;
    return r;
}

} // namespace

LayoutResult ceg_bfs(const Graph& g, const pg::PosByStr* initial_positions) {
    auto s = build_state(g, "CEG-bfs", initial_positions);
    LayoutResult r;
    if (!s.prep.ok) {
        r.ok = false;
        r.message = s.prep.message.empty() ? "CEG-bfs failed" : s.prep.message;
        return r;
    }
    auto depth = bfs_depth_from_outer(s.prep.augmented_node_ids, s.adjacency, s.prep.augmented_outer_face);
    auto weights = build_depth_weights(s.prep.augmented_edge_pairs, depth, BFS_BASE_WEIGHT, BFS_DEPTH_RATIO);
    auto br = compute_barycentric_positions(s.prep.augmented_node_ids, s.adjacency,
                                             s.prep.augmented_outer_face, weights);
    if (!br.ok) {
        r.ok = false;
        r.message = br.message.empty() ? "CEG-bfs solver failed" : br.message;
        return r;
    }
    return finalize(g, s, br.positions, "CEG-bfs");
}

LayoutResult ceg_xy(const Graph& g, const pg::PosByStr* initial_positions) {
    auto s = build_state(g, "CEG-xy", initial_positions);
    LayoutResult r;
    if (!s.prep.ok) {
        r.ok = false;
        r.message = s.prep.message.empty() ? "CEG-xy failed" : s.prep.message;
        return r;
    }
    // Uniform baseline solve.
    std::unordered_map<std::string, double> uniform;
    for (const auto& [u, v] : s.prep.augmented_edge_pairs) uniform[ekey(u, v)] = 1.0;
    auto base = compute_barycentric_positions(s.prep.augmented_node_ids, s.adjacency,
                                               s.prep.augmented_outer_face, uniform);
    if (!base.ok) {
        r.ok = false;
        r.message = base.message.empty() ? "CEG-xy baseline solve failed" : base.message;
        return r;
    }
    auto xs = build_spread_state(s, base.positions, 0.0);
    if (!xs.ok) {
        r.ok = false;
        r.message = xs.message.empty() ? "CEG-xy x-spread failed" : xs.message;
        return r;
    }
    auto ys = build_spread_state(s, base.positions, M_PI / 2.0);
    if (!ys.ok) {
        r.ok = false;
        r.message = ys.message.empty() ? "CEG-xy y-spread failed" : ys.message;
        return r;
    }
    auto combined = combine_weights(s.prep.augmented_edge_pairs, xs.weights, ys.weights, XY_LAMBDA);
    pg::PosByStr fixed_outer;
    for (const auto& nid : s.prep.augmented_outer_face) {
        auto it = base.positions.find(nid);
        if (it != base.positions.end()) fixed_outer[nid] = it->second;
    }
    TutteOuterPlacement placement;
    placement.fixed_outer_pos = &fixed_outer;
    auto solve = compute_barycentric_positions(s.prep.augmented_node_ids, s.adjacency,
                                                s.prep.augmented_outer_face, combined, placement);
    if (!solve.ok) {
        r.ok = false;
        r.message = solve.message.empty() ? "CEG-xy solve failed" : solve.message;
        return r;
    }
    return finalize(g, s, solve.positions, "CEG-xy");
}

} // namespace planarvibe::layouts
