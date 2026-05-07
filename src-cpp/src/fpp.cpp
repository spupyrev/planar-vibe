#include "layouts/fpp.hpp"

#include "geometry.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <optional>
#include <unordered_map>
#include <unordered_set>

namespace planarvibe::layouts {

namespace {

std::string edge_key(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

// Walk rotation[v] from `start` to `end` (inclusive, CCW). Returns empty optional
// if either endpoint is missing. Matches Python rotation_path_inclusive.
std::optional<std::vector<std::string>> rotation_path_inclusive(
    const std::unordered_map<std::string, std::vector<std::string>>& rotation,
    const std::string& v, const std::string& start, const std::string& end) {
    auto it = rotation.find(v);
    if (it == rotation.end() || it->second.empty()) return std::nullopt;
    const auto& nbrs = it->second;
    auto is = std::find(nbrs.begin(), nbrs.end(), start);
    auto ie = std::find(nbrs.begin(), nbrs.end(), end);
    if (is == nbrs.end() || ie == nbrs.end()) return std::nullopt;
    int i_start = (int)(is - nbrs.begin());
    int i_end = (int)(ie - nbrs.begin());
    std::vector<std::string> out{start};
    int cur = i_start;
    while (cur != i_end) {
        cur = (cur + 1) % (int)nbrs.size();
        out.push_back(nbrs[cur]);
        if ((int)out.size() > (int)nbrs.size() + 1) return std::nullopt;
    }
    return out;
}

int score_replacement_path(const std::optional<std::vector<std::string>>& path,
                           const std::unordered_set<std::string>& outer_set,
                           const std::unordered_set<std::string>& remaining) {
    if (!path || path->size() < 2) return -1;
    int score = 0;
    for (size_t s = 1; s + 1 < path->size(); ++s) {
        const auto& x = (*path)[s];
        if (remaining.count(x) && !outer_set.count(x)) score += 2;
        else if (remaining.count(x)) score += 1;
    }
    return score;
}

std::vector<std::string> choose_replacement_path(
    const std::unordered_map<std::string, std::vector<std::string>>& rotation,
    const std::string& v, const std::string& pred, const std::string& succ,
    const std::unordered_set<std::string>& outer_set,
    const std::unordered_set<std::string>& remaining) {
    auto path_a = rotation_path_inclusive(rotation, v, pred, succ);
    auto path_b = rotation_path_inclusive(rotation, v, succ, pred);
    if (path_b) std::reverse(path_b->begin(), path_b->end());
    int sa = score_replacement_path(path_a, outer_set, remaining);
    int sb = score_replacement_path(path_b, outer_set, remaining);
    if (sa > sb && path_a) return *path_a;
    if (sb > sa && path_b) return *path_b;
    if (path_a && path_b) {
        if (path_a->size() != path_b->size()) {
            return path_a->size() > path_b->size() ? *path_a : *path_b;
        }
        // Lex-compare with '\x01' separator per Python.
        std::string ka, kb;
        for (const auto& x : *path_a) { ka += '\x01'; ka += x; }
        for (const auto& x : *path_b) { kb += '\x01'; kb += x; }
        return ka <= kb ? *path_a : *path_b;
    }
    if (path_a) return *path_a;
    if (path_b) return *path_b;
    return {pred, succ};
}

std::vector<std::string> sanitize_replacement_path(
    const std::vector<std::string>& path, const std::string& pred, const std::string& succ,
    const std::unordered_set<std::string>& outer_set,
    const std::unordered_set<std::string>& remaining) {
    if (path.size() < 2 || path.front() != pred || path.back() != succ) return {pred, succ};
    std::vector<std::string> out{pred};
    std::unordered_set<std::string> seen{pred};
    for (size_t i = 1; i + 1 < path.size(); ++i) {
        const auto& x = path[i];
        if (!remaining.count(x) || outer_set.count(x) || seen.count(x)) continue;
        out.push_back(x);
        seen.insert(x);
    }
    out.push_back(succ);
    return out;
}

std::optional<std::vector<std::string>> build_next_outer_cycle(
    const std::vector<std::string>& outer_cycle, int remove_idx,
    const std::vector<std::string>& replacement_path) {
    int n = (int)outer_cycle.size();
    int succ_idx = (remove_idx + 1) % n;
    int pred_idx = (remove_idx - 1 + n) % n;
    const std::string& pred = outer_cycle[pred_idx];
    std::vector<std::string> interior(replacement_path.begin() + 1, replacement_path.end() - 1);
    std::vector<std::string> walk;
    int t = succ_idx;
    while (t != remove_idx) {
        walk.push_back(outer_cycle[t]);
        t = (t + 1) % n;
    }
    if (walk.empty() || walk.back() != pred) return std::nullopt;
    for (const auto& x : interior) walk.push_back(x);
    return walk;
}

std::unordered_map<std::string, int> compute_chord_counts(
    const std::vector<std::string>& outer_cycle,
    const std::unordered_set<std::string>& remaining,
    const std::unordered_map<std::string, std::unordered_set<std::string>>& adjacency) {
    std::unordered_set<std::string> outer_set(outer_cycle.begin(), outer_cycle.end());
    std::unordered_set<std::string> boundary_edges;
    int n = (int)outer_cycle.size();
    for (int i = 0; i < n; ++i) {
        boundary_edges.insert(edge_key(outer_cycle[i], outer_cycle[(i + 1) % n]));
    }
    std::unordered_map<std::string, int> chords;
    for (const auto& v : outer_cycle) {
        int count = 0;
        std::unordered_set<std::string> seen;
        auto it = adjacency.find(v);
        if (it == adjacency.end()) { chords[v] = 0; continue; }
        for (const auto& u : it->second) {
            if (!remaining.count(u) || !outer_set.count(u) || u == v) continue;
            std::string ek = edge_key(v, u);
            if (boundary_edges.count(ek) || seen.count(u)) continue;
            seen.insert(u);
            ++count;
        }
        chords[v] = count;
    }
    return chords;
}

struct Canonical {
    bool ok = false;
    std::string reason;
    std::vector<std::string> order;
    std::vector<std::string> outer_face;  // [v1, v2, v3]
    std::unordered_map<std::string, std::vector<std::string>> contour_neighbors_by_vertex;
};

Canonical compute_canonical_ordering(const preprocessing::PreparedGraph& prep) {
    Canonical r;
    const auto& embedding = prep.augmented_embedding;
    if (!embedding.ok) { r.reason = "Missing embedding"; return r; }
    const auto& node_ids = embedding.id_by_index;
    if (node_ids.size() < 3) { r.reason = "Need at least 3 vertices"; return r; }
    if (embedding.outer_face.size() != 3) { r.reason = "Triangulated embedding must have triangular outer face"; return r; }

    // rotation_by_id from embedding.rotation (index-aligned with id_by_index).
    std::unordered_map<std::string, std::vector<std::string>> rotation;
    for (size_t i = 0; i < node_ids.size(); ++i) {
        rotation[node_ids[i]] = (i < embedding.rotation.size()) ? embedding.rotation[i] : std::vector<std::string>{};
    }
    // Build adjacency_sets from augmented edge pairs.
    std::unordered_map<std::string, std::unordered_set<std::string>> adjacency;
    for (const auto& nid : node_ids) adjacency[nid] = {};
    for (const auto& [u, v] : prep.augmented_edge_pairs) {
        adjacency[u].insert(v);
        adjacency[v].insert(u);
    }

    std::string v1 = embedding.outer_face[0], v2 = embedding.outer_face[1], vn = embedding.outer_face[2];
    std::unordered_set<std::string> remaining(node_ids.begin(), node_ids.end());
    std::vector<std::string> outer_cycle{v1, vn, v2};
    std::vector<std::string> removed;
    std::unordered_map<std::string, bool> mark{{v1, true}, {v2, true}};
    std::unordered_map<std::string, bool> out_flag{{v1, true}, {v2, true}, {vn, true}};

    while ((int)remaining.size() > 3) {
        std::unordered_set<std::string> outer_set(outer_cycle.begin(), outer_cycle.end());
        auto chords = compute_chord_counts(outer_cycle, remaining, adjacency);
        std::string chosen;
        int chosen_idx = -1;

        if ((int)remaining.size() == (int)node_ids.size()) {
            chosen = vn;
            auto it = std::find(outer_cycle.begin(), outer_cycle.end(), vn);
            chosen_idx = (int)(it - outer_cycle.begin());
        } else {
            for (int c = 0; c < (int)outer_cycle.size(); ++c) {
                const auto& cand = outer_cycle[c];
                auto mit = mark.find(cand);
                auto oit = out_flag.find(cand);
                if ((mit != mark.end() && mit->second) || oit == out_flag.end() || !oit->second) continue;
                if (cand == v1 || cand == v2) continue;
                if (chords[cand] == 0) { chosen = cand; chosen_idx = c; break; }
            }
        }
        if (chosen_idx == -1) {
            r.reason = "Could not find shelling vertex for canonical ordering";
            return r;
        }

        const std::string& pred = outer_cycle[(chosen_idx - 1 + (int)outer_cycle.size()) % outer_cycle.size()];
        const std::string& succ = outer_cycle[(chosen_idx + 1) % outer_cycle.size()];
        auto rp = choose_replacement_path(rotation, chosen, pred, succ, outer_set, remaining);
        rp = sanitize_replacement_path(rp, pred, succ, outer_set, remaining);
        r.contour_neighbors_by_vertex[chosen] = rp;

        auto next_cycle = build_next_outer_cycle(outer_cycle, chosen_idx, rp);
        if (!next_cycle || next_cycle->size() < 2) {
            r.reason = "Failed to update outer cycle during canonical ordering";
            return r;
        }
        mark[chosen] = true;
        for (size_t i = 1; i + 1 < rp.size(); ++i) out_flag[rp[i]] = true;

        // Remove chosen from adjacency
        for (const auto& nb : adjacency[chosen]) {
            auto ait = adjacency.find(nb);
            if (ait != adjacency.end()) ait->second.erase(chosen);
        }
        adjacency[chosen].clear();
        remaining.erase(chosen);
        removed.push_back(chosen);
        outer_cycle = *next_cycle;
    }

    std::vector<std::string> base(remaining.begin(), remaining.end());
    if (base.size() != 3) { r.reason = "Canonical reduction did not end with 3 vertices"; return r; }
    if (std::find(base.begin(), base.end(), v1) == base.end()
        || std::find(base.begin(), base.end(), v2) == base.end()) {
        r.reason = "Canonical base does not contain fixed outer edge";
        return r;
    }
    std::string v3;
    for (const auto& b : base) if (b != v1 && b != v2) { v3 = b; break; }
    if (v3.empty()) { r.reason = "Canonical base triangle is invalid"; return r; }

    r.order = {v1, v2, v3};
    for (auto it = removed.rbegin(); it != removed.rend(); ++it) r.order.push_back(*it);
    if (r.order.size() != node_ids.size()) {
        r.reason = "Canonical ordering has duplicate or missing vertices";
        return r;
    }
    std::unordered_set<std::string> order_set(r.order.begin(), r.order.end());
    if (order_set.size() != node_ids.size()) {
        r.reason = "Canonical ordering has duplicate or missing vertices";
        return r;
    }
    r.outer_face = {v1, v2, v3};
    r.ok = true;
    return r;
}

// Find `neighbor_path` (or its reverse) as a contiguous subsequence of `contour`.
std::optional<std::pair<int,int>> find_neighbor_segment(
    const std::vector<std::string>& contour, const std::vector<std::string>& path) {
    int n = (int)contour.size();
    if (n == 0 || path.size() < 2) return std::nullopt;
    auto match = [&](const std::vector<std::string>& p) -> std::optional<std::pair<int,int>> {
        int m = (int)p.size();
        if (m > n) return std::nullopt;
        for (int s = 0; s + m <= n; ++s) {
            bool ok = true;
            for (int i = 0; i < m; ++i) if (contour[s + i] != p[i]) { ok = false; break; }
            if (ok) return std::make_pair(s, s + m - 1);
        }
        return std::nullopt;
    };
    if (auto r = match(path)) return r;
    std::vector<std::string> rev(path.rbegin(), path.rend());
    return match(rev);
}

struct FPPPlacement {
    bool ok = false;
    std::string message;
    pg::PosByStr positions;
};

FPPPlacement compute_fpp_positions(const Canonical& canonical) {
    FPPPlacement r;
    const auto& order = canonical.order;
    if (order.size() < 3) { r.message = "Canonical ordering is too short for FPP"; return r; }
    pg::PosByStr coords;
    std::unordered_map<std::string, std::unordered_set<std::string>> layers;

    const std::string& v1 = order[0], v2 = order[1], v3 = order[2];
    coords[v1] = {0.0, 0.0};
    coords[v2] = {2.0, 0.0};
    coords[v3] = {1.0, 1.0};
    double base_y = 0.0;
    layers[v1] = {v1};
    layers[v2] = {v2};
    layers[v3] = {v3};

    std::vector<std::string> contour{v1, v3, v2};

    auto collect_layer = [&](int from_idx, int to_idx_inclusive) {
        std::unordered_set<std::string> out;
        if (from_idx > to_idx_inclusive) return out;
        for (int a = from_idx; a <= to_idx_inclusive; ++a) {
            auto it = layers.find(contour[a]);
            if (it == layers.end()) continue;
            for (const auto& x : it->second) out.insert(x);
        }
        return out;
    };
    auto shift = [&](const std::unordered_set<std::string>& vs, double dx) {
        for (const auto& v : vs) {
            auto it = coords.find(v);
            if (it != coords.end()) it->second[0] += dx;
        }
    };

    for (size_t i = 3; i < order.size(); ++i) {
        const std::string& vk = order[i];
        auto nit = canonical.contour_neighbors_by_vertex.find(vk);
        if (nit == canonical.contour_neighbors_by_vertex.end() || nit->second.size() < 2) {
            r.message = "Missing contour neighbors for vertex " + vk;
            return r;
        }
        auto seg = find_neighbor_segment(contour, nit->second);
        if (!seg) {
            r.message = "Could not find consecutive contour segment for vertex " + vk;
            return r;
        }
        int p = seg->first, q = seg->second;
        const std::string& wp = contour[p];
        const std::string& wq = contour[q];
        auto wpit = coords.find(wp), wqit = coords.find(wq);
        if (wpit == coords.end() || wqit == coords.end()) {
            r.message = "Missing endpoint coordinates for vertex " + vk;
            return r;
        }

        auto inner = collect_layer(p + 1, q - 1);
        auto right = collect_layer(q, (int)contour.size() - 1);
        shift(inner, 1);
        shift(right, 2);

        double xq = coords[wq][0], yq = coords[wq][1];
        double xp = coords[wp][0], yp = coords[wp][1];
        double x = (xq + yq + xp - yp) / 2.0;
        double y = (xq + yq - xp + yp) / 2.0;
        if (y < base_y) {
            r.message = "FPP invariant violated: vertex " + vk + " placed below base edge";
            return r;
        }
        coords[vk] = {x, y};
        auto vk_layer = inner;
        vk_layer.insert(vk);
        layers[vk] = std::move(vk_layer);
        for (int c = p + 1; c < q; ++c) layers[contour[c]].clear();
        std::vector<std::string> new_contour(contour.begin(), contour.begin() + p + 1);
        new_contour.push_back(vk);
        new_contour.insert(new_contour.end(), contour.begin() + q, contour.end());
        contour = std::move(new_contour);
    }

    const double SCALE = 30.0;
    double max_y = 0.0;
    for (const auto& nid : order) {
        auto it = coords.find(nid);
        if (it != coords.end() && it->second[1] > max_y) max_y = it->second[1];
    }
    pg::PosByStr screen;
    for (const auto& nid : order) {
        auto it = coords.find(nid);
        if (it == coords.end()) continue;
        double cx = it->second[0], cy = it->second[1];
        screen[nid] = {cx * SCALE + 20, (max_y - cy) * SCALE + 20};
    }

    // Normalize to viewport.
    PositionMap tmp_map;
    std::vector<std::string> ids_for_map(order.begin(), order.end());
    tmp_map.resize((int)ids_for_map.size());
    for (size_t i = 0; i < ids_for_map.size(); ++i) {
        auto it = screen.find(ids_for_map[i]);
        if (it != screen.end()) tmp_map.put((int)i, it->second[0], it->second[1]);
    }
    auto normalized = geo::normalize_position_map_to_viewport(tmp_map);
    r.positions.reserve(ids_for_map.size());
    for (size_t i = 0; i < ids_for_map.size(); ++i) {
        if (normalized.has((int)i)) r.positions[ids_for_map[i]] = normalized.pos[i];
    }
    r.ok = true;
    return r;
}

} // namespace

LayoutResult fpp(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = "FPP";
    cfg.current_positions = initial_positions;
    cfg.triangulate_outer_face = true;
    auto prep = preprocessing::prepare_graph_data(g, cfg);
    if (!prep.ok) {
        r.ok = false;
        r.message = prep.message.empty() ? "FPP failed" : prep.message;
        return r;
    }
    auto canonical = compute_canonical_ordering(prep);
    if (!canonical.ok) {
        r.ok = false;
        r.message = canonical.reason;
        return r;
    }
    auto placed = compute_fpp_positions(canonical);
    if (!placed.ok) {
        r.ok = false;
        r.message = placed.message;
        return r;
    }
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = placed.positions.find(g.node_names[i]);
        if (it != placed.positions.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            r.positions.put(i, it->second[0], it->second[1]);
        }
    }
    r.ok = true;
    r.message = "FPP layout";
    return r;
}

} // namespace planarvibe::layouts
