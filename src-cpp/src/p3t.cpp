#include "layouts/p3t.hpp"

#include "geometry.hpp"
#include "planarity.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <unordered_map>
#include <vector>

namespace planarvibe::layouts {

namespace {

std::string clique_key(const std::string& a, const std::string& b, const std::string& c,
                       const std::unordered_map<std::string, int>& idx) {
    std::array<std::string, 3> arr{a, b, c};
    std::sort(arr.begin(), arr.end(), [&](const std::string& x, const std::string& y) {
        return idx.at(x) < idx.at(y);
    });
    return arr[0] + "|" + arr[1] + "|" + arr[2];
}

} // namespace

LayoutResult p3t(const Graph& g) {
    LayoutResult r;
    std::vector<std::string> ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> edges;
    for (const auto& [u, v] : g.edges) edges.emplace_back(g.node_names[u], g.node_names[v]);
    auto info = planarity::analyze_planar_3_tree(ids, edges);
    if (!info.ok) {
        r.ok = false;
        r.message = "P3T requires a planar 3-tree: " + info.reason;
        return r;
    }
    const auto& outer = info.outer_face;
    const auto& idx = info.embedding.index_by_id;

    std::unordered_map<std::string, std::string> parents2v;
    for (auto it = info.elimination.rbegin(); it != info.elimination.rend(); ++it) {
        parents2v[clique_key(it->parents[0], it->parents[1], it->parents[2], idx)] = it->vertex;
    }

    std::unordered_map<std::string, int> count_internals;
    std::function<int(const std::string&, const std::string&, const std::string&)> count_internal;
    count_internal = [&](const std::string& v0, const std::string& v1, const std::string& v2) -> int {
        std::string key = clique_key(v0, v1, v2, idx);
        auto it = parents2v.find(key);
        if (it == parents2v.end()) { count_internals[key] = 0; return 0; }
        const std::string& v = it->second;
        int c0 = count_internal(v1, v2, v);
        int c1 = count_internal(v2, v0, v);
        int c2 = count_internal(v0, v1, v);
        count_internals[key] = c0 + c1 + c2 + 1;
        return count_internals[key];
    };

    pg::PosByStr coord;
    for (int i = 0; i < (int)outer.size(); ++i) {
        double angle = 2.0 * M_PI * i / outer.size();
        coord[outer[outer.size() - i - 1]] = {1000 * std::cos(angle) + 2000, 1000 * std::sin(angle) + 2000};
    }
    count_internal(outer[0], outer[1], outer[2]);

    std::function<void(const std::string&, const std::string&, const std::string&)> process_clique;
    process_clique = [&](const std::string& v0, const std::string& v1, const std::string& v2) {
        std::string key = clique_key(v0, v1, v2, idx);
        auto it = parents2v.find(key);
        if (it == parents2v.end()) return;
        const std::string& v = it->second;
        std::string k0 = clique_key(v1, v2, v, idx);
        std::string k1 = clique_key(v2, v0, v, idx);
        std::string k2 = clique_key(v0, v1, v, idx);
        int a0 = (count_internals.count(k0) ? count_internals[k0] : 0) * 2 + 1;
        int a1 = (count_internals.count(k1) ? count_internals[k1] : 0) * 2 + 1;
        int a2 = (count_internals.count(k2) ? count_internals[k2] : 0) * 2 + 1;
        int total = a0 + a1 + a2;
        auto p0 = coord[v0], p1 = coord[v1], p2 = coord[v2];
        coord[v] = {(a0 * p0[0] + a1 * p1[0] + a2 * p2[0]) / total,
                    (a0 * p0[1] + a1 * p1[1] + a2 * p2[1]) / total};
        process_clique(v1, v2, v);
        process_clique(v2, v0, v);
        process_clique(v0, v1, v);
    };
    process_clique(outer[0], outer[1], outer[2]);

    // Normalize to viewport.
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = coord.find(g.node_names[i]);
        if (it != coord.end()) pm.put(i, it->second[0], it->second[1]);
    }
    auto normalized = geo::normalize_position_map_to_viewport(pm);
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        if (normalized.has(i)) r.positions.put(i, normalized.pos[i][0], normalized.pos[i][1]);
    }
    r.ok = true;
    r.message = "Applied P3T equal-face-area layout";
    return r;
}

} // namespace planarvibe::layouts
