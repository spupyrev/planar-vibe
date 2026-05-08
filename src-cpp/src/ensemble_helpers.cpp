// Ensemble helpers: port of the shared gpt/claude infrastructure from
// src-python/planarvibe/layouts/{gpt,claude}.py (ultimately from JS).

#include "layouts/ensemble_helpers.hpp"

#include "geometry.hpp"
#include "metrics.hpp"
#include "planar_graph.hpp"
#include "planarity.hpp"
#include "layouts/edgebalancer.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <queue>
#include <unordered_set>

namespace planarvibe::ensemble {

namespace {

constexpr double PI = 3.14159265358979323846;

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

pg::PosByStr copy_for_nodes(const pg::PosByStr& pos, const std::vector<std::string>& node_ids) {
    pg::PosByStr out;
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        if (it == pos.end() || !std::isfinite(it->second[0]) || !std::isfinite(it->second[1])) return {};
        out[nid] = it->second;
    }
    return out;
}

bool has_crossings(const pg::PosByStr& pos,
                   const std::vector<std::pair<std::string,std::string>>& edges) {
    // Build indexed form.
    std::unordered_map<std::string, int> idx;
    std::vector<std::string> ids;
    for (const auto& [u, v] : edges) {
        if (!idx.count(u)) { idx[u] = (int)ids.size(); ids.push_back(u); }
        if (!idx.count(v)) { idx[v] = (int)ids.size(); ids.push_back(v); }
    }
    for (const auto& kv : pos) {
        if (!idx.count(kv.first)) { idx[kv.first] = (int)ids.size(); ids.push_back(kv.first); }
    }
    PositionMap pm;
    pm.resize((int)ids.size());
    for (size_t i = 0; i < ids.size(); ++i) {
        auto it = pos.find(ids[i]);
        if (it != pos.end()) pm.put((int)i, it->second[0], it->second[1]);
    }
    std::vector<std::pair<int,int>> iedges;
    for (const auto& [u, v] : edges) iedges.emplace_back(idx[u], idx[v]);
    return geo::has_position_crossings(pm, iedges);
}

double polygon_area2_by_name(const std::vector<std::string>& face, const pg::PosByStr& pos) {
    if (face.size() < 3) return 0.0;
    double s = 0.0;
    int n = (int)face.size();
    for (int i = 0; i < n; ++i) {
        auto a = pos.find(face[i]), b = pos.find(face[(i + 1) % n]);
        if (a == pos.end() || b == pos.end()) return 0.0;
        s += a->second[0] * b->second[1] - b->second[0] * a->second[1];
    }
    return s;
}

std::string ordered_path_start(const std::vector<std::string>& node_ids, const GraphInfo& info) {
    std::string start;
    int endpoints = 0;
    for (const auto& nid : node_ids) {
        int d = info.degree.at(nid);
        if (d > 2) return "";
        if (d <= 1) { endpoints += 1; if (start.empty() || nid < start) start = nid; }
    }
    if (node_ids.size() > 1 && endpoints != 2) return "";
    if (start.empty()) start = node_ids[0];
    return start;
}

std::vector<std::string> ordered_path_nodes(const std::vector<std::string>& node_ids, const GraphInfo& info) {
    std::string start = ordered_path_start(node_ids, info);
    if (start.empty()) return {};
    std::vector<std::string> order;
    std::unordered_set<std::string> seen;
    std::string prev, cur = start;
    while (!cur.empty()) {
        order.push_back(cur);
        seen.insert(cur);
        std::vector<std::string> neighbors = info.adjacency.at(cur);
        std::sort(neighbors.begin(), neighbors.end());
        std::string nxt;
        for (const auto& c : neighbors) {
            if (c != prev && !seen.count(c)) { nxt = c; break; }
        }
        prev = cur;
        cur = nxt;
    }
    if (order.size() != node_ids.size()) return {};
    return order;
}

pg::PosByStr compute_path_snake_positions(const std::vector<std::string>& order) {
    pg::PosByStr out;
    int n = (int)order.size();
    if (n == 1) { out[order[0]] = {0, 0}; return out; }
    int width = std::max(2, (int)std::ceil(std::sqrt((double)n)));
    for (int i = 0; i < n; ++i) {
        int row = i / width;
        int col = i % width;
        double x = row % 2 == 0 ? col : width - 1 - col;
        out[order[i]] = {x, (double)row};
    }
    return out;
}

std::string find_tree_center(const std::vector<std::string>& node_ids, const GraphInfo& info) {
    std::unordered_map<std::string, int> deg;
    std::vector<std::string> leaves;
    int remaining = (int)node_ids.size();
    for (const auto& nid : node_ids) {
        deg[nid] = info.degree.at(nid);
        if (deg[nid] <= 1) leaves.push_back(nid);
    }
    std::sort(leaves.begin(), leaves.end());
    while (remaining > 2 && !leaves.empty()) {
        std::vector<std::string> nextL;
        remaining -= (int)leaves.size();
        for (const auto& leaf : leaves) {
            for (const auto& v : info.adjacency.at(leaf)) {
                deg[v] -= 1;
                if (deg[v] == 1) nextL.push_back(v);
            }
        }
        std::sort(nextL.begin(), nextL.end());
        leaves = nextL;
    }
    return leaves.empty() ? node_ids[0] : leaves[0];
}

struct RootedTree {
    bool ok = false;
    std::string root;
    std::unordered_map<std::string, std::string> parent;
    std::unordered_map<std::string, std::vector<std::string>> children;
    std::unordered_map<std::string, int> depth;
    std::vector<std::string> order;
};

RootedTree build_rooted_tree(const std::vector<std::string>& node_ids, const GraphInfo& info) {
    RootedTree R;
    R.root = find_tree_center(node_ids, info);
    R.parent[R.root] = "";
    R.depth[R.root] = 0;
    R.order.push_back(R.root);
    size_t qi = 0;
    while (qi < R.order.size()) {
        std::string u = R.order[qi++];
        R.children[u] = {};
        std::vector<std::string> nbrs = info.adjacency.at(u);
        std::sort(nbrs.begin(), nbrs.end());
        for (const auto& v : nbrs) {
            if (v == R.parent[u]) continue;
            R.parent[v] = u;
            R.depth[v] = R.depth[u] + 1;
            R.children[u].push_back(v);
            R.order.push_back(v);
        }
    }
    if (R.order.size() != node_ids.size()) return R;
    R.ok = true;
    return R;
}

void sort_children_by_leaves_helper(const std::string& u,
    std::unordered_map<std::string, std::vector<std::string>>& children,
    std::unordered_map<std::string, int>& leaf_count) {
    auto& kids = children[u];
    if (kids.empty()) { leaf_count[u] = 1; return; }
    int total = 0;
    for (const auto& k : kids) {
        sort_children_by_leaves_helper(k, children, leaf_count);
        total += leaf_count[k];
    }
    leaf_count[u] = total;
    std::sort(kids.begin(), kids.end(),
              [&](const std::string& a, const std::string& b) {
                  if (leaf_count[a] != leaf_count[b]) return leaf_count[a] > leaf_count[b];
                  return a < b;
              });
}

std::unordered_map<std::string, int> sort_children_by_leaves(
    std::unordered_map<std::string, std::vector<std::string>>& children, const std::string& root) {
    std::unordered_map<std::string, int> leaf_count;
    sort_children_by_leaves_helper(root, children, leaf_count);
    return leaf_count;
}

pg::PosByStr compute_layered_tree_positions_named(
    const std::vector<std::string>& node_ids, const GraphInfo& info) {
    auto rt = build_rooted_tree(node_ids, info);
    if (!rt.ok) return {};
    auto leaf_count = sort_children_by_leaves(rt.children, rt.root);
    pg::PosByStr positions;
    int next_x = 0, max_depth = 0;
    std::function<double(const std::string&)> assign = [&](const std::string& u) -> double {
        const auto& kids = rt.children[u];
        if (rt.depth[u] > max_depth) max_depth = rt.depth[u];
        if (kids.empty()) {
            positions[u] = {(double)next_x, (double)rt.depth[u]};
            next_x += 1;
            return positions[u][0];
        }
        for (const auto& k : kids) assign(k);
        double first_x = positions[kids.front()][0];
        double last_x = positions[kids.back()][0];
        positions[u] = {(first_x + last_x) / 2.0, (double)rt.depth[u]};
        return positions[u][0];
    };
    assign(rt.root);
    double width = std::max(1.0, (double)(next_x - 1));
    double level_gap = (width > 0 && max_depth > 0)
                       ? std::max(0.75, std::min(2.5, width / (max_depth + 1)))
                       : 1.0;
    for (auto& kv : positions) kv.second = {kv.second[0], kv.second[1] * level_gap};
    return positions;
}

std::vector<std::string> extract_unicyclic_cycle(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const GraphInfo& info) {
    if (node_ids.size() < 3 || edge_pairs.size() != node_ids.size() || !is_connected(node_ids, info)) return {};
    std::unordered_map<std::string, int> deg;
    std::unordered_set<std::string> removed;
    std::vector<std::string> queue;
    for (const auto& nid : node_ids) {
        deg[nid] = info.degree.at(nid);
        if (deg[nid] <= 1) queue.push_back(nid);
    }
    size_t qi = 0;
    while (qi < queue.size()) {
        std::string u = queue[qi++];
        if (removed.count(u)) continue;
        removed.insert(u);
        for (const auto& v : info.adjacency.at(u)) {
            if (removed.count(v)) continue;
            deg[v] -= 1;
            if (deg[v] == 1) queue.push_back(v);
        }
    }
    std::vector<std::string> core;
    std::unordered_set<std::string> in_core;
    for (const auto& nid : node_ids) {
        if (!removed.count(nid)) { core.push_back(nid); in_core.insert(nid); }
    }
    if (core.size() < 3) return {};
    for (const auto& nid : core) {
        int cd = 0;
        for (const auto& v : info.adjacency.at(nid)) if (in_core.count(v)) cd += 1;
        if (cd != 2) return {};
    }
    std::sort(core.begin(), core.end());
    std::string start = core[0];
    std::vector<std::string> order;
    std::unordered_set<std::string> seen;
    std::string prev, cur = start;
    for (size_t i = 0; i < core.size(); ++i) {
        order.push_back(cur);
        seen.insert(cur);
        std::vector<std::string> core_nbrs;
        for (const auto& v : info.adjacency.at(cur)) if (in_core.count(v)) core_nbrs.push_back(v);
        std::sort(core_nbrs.begin(), core_nbrs.end());
        std::string nxt;
        for (const auto& c : core_nbrs) if (c != prev) { nxt = c; break; }
        if (i == core.size() - 1) {
            if (nxt != start) return {};
            break;
        }
        if (nxt.empty() || seen.count(nxt)) return {};
        prev = cur;
        cur = nxt;
    }
    return order;
}

} // anonymous namespace

GraphInfo build_graph_info(const std::vector<std::string>& node_ids,
                           const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    GraphInfo info;
    for (const auto& nid : node_ids) { info.degree[nid] = 0; info.adjacency[nid] = {}; }
    for (const auto& [u, v] : edge_pairs) {
        if (!info.adjacency.count(u) || !info.adjacency.count(v)) continue;
        info.degree[u] += 1;
        info.degree[v] += 1;
        info.adjacency[u].push_back(v);
        info.adjacency[v].push_back(u);
    }
    return info;
}

bool is_connected(const std::vector<std::string>& node_ids, const GraphInfo& info) {
    if (node_ids.size() <= 1) return true;
    std::unordered_set<std::string> seen;
    seen.insert(node_ids[0]);
    std::vector<std::string> queue{node_ids[0]};
    size_t qi = 0;
    while (qi < queue.size()) {
        for (const auto& v : info.adjacency.at(queue[qi])) {
            if (!seen.count(v)) { seen.insert(v); queue.push_back(v); }
        }
        qi += 1;
    }
    return queue.size() == node_ids.size();
}

bool is_tree_graph(const std::vector<std::string>& node_ids,
                   const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    if (node_ids.empty() || edge_pairs.size() != node_ids.size() - 1) return false;
    return is_connected(node_ids, build_graph_info(node_ids, edge_pairs));
}

PositionResult compute_tree_positions(const std::vector<std::string>& node_ids,
                                      const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    PositionResult R;
    auto info = build_graph_info(node_ids, edge_pairs);
    if (edge_pairs.size() != node_ids.size() - 1 || !is_connected(node_ids, info)) { R.message = "Not a tree"; return R; }
    auto order = ordered_path_nodes(node_ids, info);
    pg::PosByStr positions;
    if (!order.empty()) positions = compute_path_snake_positions(order);
    else positions = compute_layered_tree_positions_named(node_ids, info);
    if (positions.empty()) { R.message = "Tree layout failed"; return R; }
    R.ok = true; R.positions = positions; R.message = "Computed tree layout";
    return R;
}

PositionResult compute_radial_tree_positions(const std::vector<std::string>& node_ids,
                                              const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    PositionResult R;
    auto info = build_graph_info(node_ids, edge_pairs);
    if (edge_pairs.size() != node_ids.size() - 1 || !is_connected(node_ids, info)) { R.message = "Not a tree"; return R; }
    if (node_ids.size() == 1) {
        R.ok = true; R.positions[node_ids[0]] = {0, 0}; R.message = "Computed radial tree layout";
        return R;
    }
    auto rt = build_rooted_tree(node_ids, info);
    if (!rt.ok) { R.message = "Radial tree rooting failed"; return R; }
    auto leaf_count = sort_children_by_leaves(rt.children, rt.root);
    pg::PosByStr positions;
    positions[rt.root] = {0, 0};
    double level_gap = 1.15;
    std::function<void(const std::string&, double, double)> assign = [&](const std::string& u, double s, double e) {
        const auto& kids = rt.children[u];
        if (kids.empty()) return;
        int total = 0;
        for (const auto& k : kids) total += leaf_count[k];
        double cursor = s;
        for (const auto& k : kids) {
            double span = (e - s) * leaf_count[k] / std::max(1, total);
            double a0 = cursor, a1 = cursor + span;
            double angle = (a0 + a1) / 2.0;
            double radius = level_gap * rt.depth[k];
            positions[k] = {radius * std::cos(angle), radius * std::sin(angle)};
            assign(k, a0, a1);
            cursor = a1;
        }
    };
    assign(rt.root, -PI, PI);
    R.ok = true; R.positions = positions; R.message = "Computed radial tree layout";
    return R;
}

bool is_unicyclic_graph(const std::vector<std::string>& node_ids,
                        const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    return !extract_unicyclic_cycle(node_ids, edge_pairs, build_graph_info(node_ids, edge_pairs)).empty();
}

PositionResult compute_unicyclic_positions(const std::vector<std::string>& node_ids,
                                            const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    PositionResult R;
    auto info = build_graph_info(node_ids, edge_pairs);
    auto cycle = extract_unicyclic_cycle(node_ids, edge_pairs, info);
    if (cycle.empty()) { R.message = "Not a connected unicyclic graph"; return R; }
    std::unordered_set<std::string> in_cycle(cycle.begin(), cycle.end());
    pg::PosByStr positions;
    int k = (int)cycle.size();
    double cycle_radius = std::max(1.2, 0.5 / std::sin(PI / k));
    for (int i = 0; i < k; ++i) {
        double angle = -PI / 2 + PI * 2 * i / k;
        positions[cycle[i]] = {cycle_radius * std::cos(angle), cycle_radius * std::sin(angle)};
    }
    std::unordered_map<std::string, std::vector<std::string>> children;
    std::function<void(const std::string&, const std::string&)> build_tree = [&](const std::string& u, const std::string& parent) {
        std::vector<std::string> kids;
        auto nbrs = info.adjacency.at(u);
        std::sort(nbrs.begin(), nbrs.end());
        for (const auto& v : nbrs) {
            if (v == parent || in_cycle.count(v)) continue;
            kids.push_back(v);
            build_tree(v, u);
        }
        children[u] = kids;
    };
    for (const auto& root : cycle) {
        std::vector<std::string> root_kids;
        auto nbrs = info.adjacency.at(root);
        std::sort(nbrs.begin(), nbrs.end());
        for (const auto& v : nbrs) {
            if (in_cycle.count(v)) continue;
            root_kids.push_back(v);
            build_tree(v, root);
        }
        children[root] = root_kids;
    }
    std::unordered_map<std::string, int> leaf_count;
    std::function<int(const std::string&)> count_leaves = [&](const std::string& u) -> int {
        auto& kids = children[u];
        if (kids.empty()) { leaf_count[u] = 1; return 1; }
        int total = 0;
        for (const auto& j : kids) total += count_leaves(j);
        leaf_count[u] = total;
        std::sort(kids.begin(), kids.end(), [&](const std::string& a, const std::string& b) {
            if (leaf_count[a] != leaf_count[b]) return leaf_count[a] > leaf_count[b];
            return a < b;
        });
        return total;
    };
    for (const auto& c : cycle) count_leaves(c);

    std::function<void(const std::string&, int, double, double)> assign_subtree =
        [&](const std::string& u, int depth, double s, double e) {
            auto& kids = children[u];
            if (kids.empty()) return;
            int total = 0;
            for (const auto& kid : kids) total += leaf_count[kid];
            double cursor = s;
            for (const auto& child : kids) {
                double span = (e - s) * leaf_count[child] / std::max(1, total);
                double a0 = cursor, a1 = cursor + span;
                double ca = (a0 + a1) / 2.0;
                double radius = cycle_radius + depth * 1.05;
                positions[child] = {radius * std::cos(ca), radius * std::sin(ca)};
                assign_subtree(child, depth + 1, a0, a1);
                cursor = a1;
            }
        };
    double base_sector = PI * 2 / k;
    for (const auto& c : cycle) {
        double angle = std::atan2(positions[c][1], positions[c][0]);
        double half = std::min(base_sector * 0.42, PI / 3);
        assign_subtree(c, 1, angle - half, angle + half);
    }
    R.ok = true; R.positions = positions; R.message = "Computed unicyclic layout";
    return R;
}

namespace {

struct GridDims { bool ok = false; int rows = 0, cols = 0; };

GridDims rectangular_grid_dimensions(const std::vector<std::string>& node_ids,
                                      const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    GridDims R;
    int n = (int)node_ids.size();
    int m = (int)edge_pairs.size();
    if (n < 4) return R;
    int side_sum = 2 * n - m;
    for (int r = 2; r * r <= n; ++r) {
        if (n % r == 0) {
            int c = n / r;
            if (r + c == side_sum) { R.ok = true; R.rows = r; R.cols = c; return R; }
        }
    }
    return R;
}

std::vector<std::string> trace_grid_boundary_path(const std::string& start, const std::string& nxt, const GraphInfo& info) {
    std::vector<std::string> path{start, nxt};
    std::string prev = start, cur = nxt;
    std::unordered_set<std::string> seen{start, nxt};
    while (info.degree.at(cur) != 2) {
        std::vector<std::string> cands;
        for (const auto& v : info.adjacency.at(cur)) {
            if (v != prev && !seen.count(v) && info.degree.at(v) < 4) cands.push_back(v);
        }
        if (cands.size() != 1) return {};
        std::sort(cands.begin(), cands.end());
        prev = cur;
        cur = cands[0];
        seen.insert(cur);
        path.push_back(cur);
    }
    return path;
}

std::unordered_map<std::string, int> multi_source_distances(
    const std::vector<std::string>& sources, const GraphInfo& info) {
    std::unordered_map<std::string, int> dist;
    std::vector<std::string> queue;
    for (const auto& s : sources) {
        if (dist.count(s) && dist[s] == 0) continue;
        dist[s] = 0;
        queue.push_back(s);
    }
    size_t qi = 0;
    while (qi < queue.size()) {
        std::string u = queue[qi++];
        for (const auto& v : info.adjacency.at(u)) {
            if (dist.count(v)) continue;
            dist[v] = dist[u] + 1;
            queue.push_back(v);
        }
    }
    return dist;
}

PositionResult compute_two_row_grid_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const GraphInfo& info, int columns) {
    PositionResult R;
    std::unordered_set<std::string> edge_set;
    for (const auto& [u, v] : edge_pairs) edge_set.insert(ekey(u, v));
    std::vector<std::string> corners;
    for (const auto& nid : node_ids) if (info.degree.at(nid) == 2) corners.push_back(nid);
    std::sort(corners.begin(), corners.end());
    for (const auto& top : corners) {
        std::vector<std::string> top_nbrs = info.adjacency.at(top);
        std::sort(top_nbrs.begin(), top_nbrs.end());
        for (const auto& bottom : top_nbrs) {
            if (info.degree.at(bottom) != 2) continue;
            pg::PosByStr positions;
            std::unordered_set<std::string> seen;
            std::string top_prev, bottom_prev, top_cur = top, bottom_cur = bottom;
            bool valid = true;
            for (int col = 0; col < columns; ++col) {
                if (seen.count(top_cur) || seen.count(bottom_cur)) { valid = false; break; }
                seen.insert(top_cur); seen.insert(bottom_cur);
                positions[top_cur] = {(double)col, 0.0};
                positions[bottom_cur] = {(double)col, 1.0};
                if (col == columns - 1) break;
                std::vector<std::string> top_next, bottom_next;
                for (const auto& n : info.adjacency.at(top_cur))
                    if (n != top_prev && n != bottom_cur && !seen.count(n)) top_next.push_back(n);
                for (const auto& n : info.adjacency.at(bottom_cur))
                    if (n != bottom_prev && n != top_cur && !seen.count(n)) bottom_next.push_back(n);
                if (top_next.size() != 1 || bottom_next.size() != 1 ||
                    !edge_set.count(ekey(top_next[0], bottom_next[0]))) { valid = false; break; }
                top_prev = top_cur; bottom_prev = bottom_cur;
                top_cur = top_next[0]; bottom_cur = bottom_next[0];
            }
            if (!valid || seen.size() != node_ids.size()) continue;
            for (const auto& [u, v] : edge_pairs) {
                auto a = positions.find(u), b = positions.find(v);
                if (a == positions.end() || b == positions.end() ||
                    std::abs(a->second[0] - b->second[0]) + std::abs(a->second[1] - b->second[1]) != 1) {
                    valid = false; break;
                }
            }
            if (valid) {
                R.ok = true; R.positions = positions; R.message = "Computed two-row grid layout";
                return R;
            }
        }
    }
    R.message = "Two-row grid coordinate recovery failed";
    return R;
}

} // anon

bool has_rectangular_grid_signature(const std::vector<std::string>& node_ids,
                                     const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    auto dims = rectangular_grid_dimensions(node_ids, edge_pairs);
    if (!dims.ok) return false;
    auto info = build_graph_info(node_ids, edge_pairs);
    int corners = 0;
    for (const auto& nid : node_ids) {
        int d = info.degree.at(nid);
        if (d > 4 || d < 2) return false;
        if (d == 2) corners += 1;
    }
    return corners == 4 && is_connected(node_ids, info);
}

PositionResult compute_rectangular_grid_positions(const std::vector<std::string>& node_ids,
                                                   const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    PositionResult R;
    if (!has_rectangular_grid_signature(node_ids, edge_pairs)) { R.message = "Not a rectangular grid"; return R; }
    auto info = build_graph_info(node_ids, edge_pairs);
    auto dims = rectangular_grid_dimensions(node_ids, edge_pairs);
    if (dims.ok && (dims.rows == 2 || dims.cols == 2)) {
        return compute_two_row_grid_positions(node_ids, edge_pairs, info, std::max(dims.rows, dims.cols));
    }
    std::vector<std::string> corners;
    for (const auto& nid : node_ids) if (info.degree.at(nid) == 2) corners.push_back(nid);
    std::sort(corners.begin(), corners.end());
    for (const auto& corner : corners) {
        std::vector<std::string> nbrs = info.adjacency.at(corner);
        std::sort(nbrs.begin(), nbrs.end());
        for (int flip = 0; flip < 2; ++flip) {
            if ((size_t)flip >= nbrs.size()) continue;
            auto px = trace_grid_boundary_path(corner, nbrs[flip], info);
            const std::string& other = ((size_t)(1 - flip) < nbrs.size()) ? nbrs[1 - flip] : nbrs[flip];
            auto py = trace_grid_boundary_path(corner, other, info);
            if (px.empty() || py.empty()) continue;
            int width = (int)px.size() - 1;
            int height = (int)py.size() - 1;
            if ((size_t)((width + 1) * (height + 1)) != node_ids.size()) continue;
            auto dist_to_y = multi_source_distances(py, info);
            auto dist_to_x = multi_source_distances(px, info);
            pg::PosByStr positions;
            std::unordered_set<std::string> occupied;
            bool valid = true;
            for (const auto& nid : node_ids) {
                if (!dist_to_y.count(nid) || !dist_to_x.count(nid)) { valid = false; break; }
                int x = dist_to_y[nid], y = dist_to_x[nid];
                if (x < 0 || y < 0 || x > width || y > height) { valid = false; break; }
                std::string key = std::to_string(x) + "," + std::to_string(y);
                if (occupied.count(key)) { valid = false; break; }
                occupied.insert(key);
                positions[nid] = {(double)x, (double)y};
            }
            if (!valid) continue;
            for (const auto& [u, v] : edge_pairs) {
                auto a = positions.find(u), b = positions.find(v);
                if (a == positions.end() || b == positions.end() ||
                    std::abs(a->second[0] - b->second[0]) + std::abs(a->second[1] - b->second[1]) != 1) {
                    valid = false; break;
                }
            }
            if (valid) {
                R.ok = true; R.positions = positions; R.message = "Computed rectangular grid layout";
                return R;
            }
        }
    }
    R.message = "Rectangular grid coordinate recovery failed";
    return R;
}

namespace {
std::vector<std::string> compute_outerplanar_order(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    if (node_ids.size() < 3) return {};
    std::unordered_set<std::string> id_set(node_ids.begin(), node_ids.end());
    std::string hub = "@cppOuterHub";
    int suffix = 1;
    while (id_set.count(hub)) hub = "@cppOuterHub" + std::to_string(suffix++);
    std::vector<std::string> all_ids = node_ids;
    all_ids.push_back(hub);
    std::vector<std::pair<std::string,std::string>> edges_plus = edge_pairs;
    for (const auto& nid : node_ids) edges_plus.emplace_back(hub, nid);
    auto emb = planarity::compute_planar_embedding(all_ids, edges_plus);
    if (!emb.ok) return {};
    auto it = emb.index_by_id.find(hub);
    if (it == emb.index_by_id.end()) return {};
    int hub_idx = it->second;
    if (hub_idx < 0 || hub_idx >= (int)emb.rotation.size()) return {};
    const auto& rot = emb.rotation[hub_idx];
    if (rot.size() != node_ids.size()) return {};
    std::unordered_set<std::string> seen;
    std::vector<std::string> order;
    for (const auto& r : rot) {
        if (!id_set.count(r) || seen.count(r)) return {};
        seen.insert(r);
        order.push_back(r);
    }
    if (order.size() != node_ids.size()) return {};
    return order;
}
} // anon

bool is_outerplanar_graph(const std::vector<std::string>& node_ids,
                          const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    return !compute_outerplanar_order(node_ids, edge_pairs).empty();
}

PositionResult compute_outerplanar_circle_positions(const std::vector<std::string>& node_ids,
                                                     const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    PositionResult R;
    auto order = compute_outerplanar_order(node_ids, edge_pairs);
    if (order.empty()) { R.message = "Not outerplanar"; return R; }
    int n = (int)order.size();
    double radius = std::max(1.0, n / (PI * 2));
    for (int i = 0; i < n; ++i) {
        double angle = -PI / 2 + PI * 2 * i / n;
        R.positions[order[i]] = {radius * std::cos(angle), radius * std::sin(angle)};
    }
    if (has_crossings(R.positions, edge_pairs)) {
        R.positions.clear();
        R.message = "Outerplanar circle drawing crossed edges";
        return R;
    }
    R.ok = true;
    R.message = "Computed outerplanar circle layout";
    return R;
}

bool is_planar_3_tree(const std::vector<std::string>& node_ids,
                      const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    auto info = planarity::analyze_planar_3_tree(node_ids, edge_pairs);
    return info.ok;
}

TwoCoreInfo compute_two_core_info(const std::vector<std::string>& node_ids,
                                   const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                                   int core_tree_max_nodes, int core_tree_max_core_nodes) {
    TwoCoreInfo R;
    if ((int)node_ids.size() > core_tree_max_nodes) return R;
    auto info = build_graph_info(node_ids, edge_pairs);
    if (!is_connected(node_ids, info)) return R;
    std::unordered_map<std::string, int> deg;
    std::unordered_set<std::string> removed;
    std::vector<std::string> queue;
    for (const auto& nid : node_ids) {
        deg[nid] = info.degree.at(nid);
        if (deg[nid] <= 1) queue.push_back(nid);
    }
    size_t qi = 0;
    while (qi < queue.size()) {
        std::string u = queue[qi++];
        if (removed.count(u)) continue;
        removed.insert(u);
        for (const auto& v : info.adjacency.at(u)) {
            if (removed.count(v)) continue;
            deg[v] -= 1;
            if (deg[v] == 1) queue.push_back(v);
        }
    }
    std::vector<std::string> core;
    std::unordered_map<std::string, bool> core_set;
    for (const auto& nid : node_ids) {
        if (!removed.count(nid)) { core.push_back(nid); core_set[nid] = true; }
    }
    if ((int)core.size() < 3 || core.size() == node_ids.size() || (int)core.size() > core_tree_max_core_nodes) return R;
    std::vector<std::pair<std::string,std::string>> core_edges;
    for (const auto& [u, v] : edge_pairs) {
        if (core_set.count(u) && core_set.count(v)) core_edges.emplace_back(u, v);
    }
    if (core_edges.size() < core.size()) return R;
    R.ok = true;
    R.info = info;
    R.core = core;
    R.core_set = core_set;
    R.core_node_ids = core;
    R.core_edge_pairs = core_edges;
    return R;
}

std::optional<double> median_finite(std::vector<double> v) {
    std::vector<double> out;
    for (double x : v) if (std::isfinite(x)) out.push_back(x);
    if (out.empty()) return std::nullopt;
    std::sort(out.begin(), out.end());
    size_t mid = out.size() / 2;
    if (out.size() % 2) return out[mid];
    return (out[mid - 1] + out[mid]) / 2.0;
}

std::optional<double> median_edge_length(
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::function<bool(const std::string&, const std::string&)>& pred) {
    std::vector<double> lengths;
    for (const auto& [u, v] : edge_pairs) {
        if (pred && !pred(u, v)) continue;
        auto pu = pos.find(u), pv = pos.find(v);
        if (pu == pos.end() || pv == pos.end()) continue;
        double d = std::hypot(pu->second[0] - pv->second[0], pu->second[1] - pv->second[1]);
        if (d > 0) lengths.push_back(d);
    }
    return median_finite(std::move(lengths));
}

PositionResult compute_core_tree_positions_with_core(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const TwoCoreInfo& core_info, const pg::PosByStr& core_positions) {
    PositionResult R;
    pg::PosByStr positions = copy_for_nodes(core_positions, core_info.core);
    if (positions.empty() || has_crossings(positions, core_info.core_edge_pairs)) {
        R.message = "CoreTree core drawing is not plane"; return R;
    }
    std::unordered_map<std::string, std::vector<std::string>> children;
    std::unordered_map<std::string, std::string> parent;
    std::vector<std::string> queue = core_info.core;
    std::sort(queue.begin(), queue.end());
    for (const auto& cid : core_info.core) { parent[cid] = ""; children[cid] = {}; }
    size_t qi = 0;
    while (qi < queue.size()) {
        std::string u = queue[qi++];
        auto nbrs = core_info.info.adjacency.at(u);
        std::sort(nbrs.begin(), nbrs.end());
        for (const auto& v : nbrs) {
            if (core_info.core_set.count(v) || parent.count(v)) continue;
            parent[v] = u;
            children[u].push_back(v);
            children[v] = {};
            queue.push_back(v);
        }
    }
    if (parent.size() != node_ids.size()) { R.message = "CoreTree attachment forest failed"; return R; }

    double cx = 0, cy = 0;
    for (const auto& cid : core_info.core) { cx += positions[cid][0]; cy += positions[cid][1]; }
    cx /= core_info.core.size(); cy /= core_info.core.size();
    auto med = median_edge_length(core_info.core_edge_pairs, positions);
    double level_gap = (med.value_or(1.0)) * 0.95;
    auto stable_outward_angle = [&](const std::string& cid) -> double {
        Point p = positions[cid];
        double dx = p[0] - cx, dy = p[1] - cy;
        double raw_angle = std::atan2(dy, dx);
        double radial = std::hypot(dx, dy);
        if (radial > std::max(1e-9, level_gap * 1e-8)) return raw_angle;

        std::vector<double> occupied;
        auto nbr_it = core_info.info.adjacency.find(cid);
        if (nbr_it != core_info.info.adjacency.end()) {
            for (const auto& nb : nbr_it->second) {
                if (!core_info.core_set.count(nb)) continue;
                auto qit = positions.find(nb);
                if (qit == positions.end()) continue;
                double a = std::atan2(qit->second[1] - p[1], qit->second[0] - p[0]);
                if (a < 0) a += 2 * PI;
                occupied.push_back(a);
            }
        }
        if (occupied.empty()) return 0.0;
        auto normalize_pi = [](double a) {
            while (a > PI) a -= 2 * PI;
            while (a <= -PI) a += 2 * PI;
            return a;
        };
        auto angle_dist = [&](double a, double b) {
            double d = std::fabs(a - b);
            while (d > 2 * PI) d -= 2 * PI;
            return std::min(d, 2 * PI - d);
        };
        double raw_norm = normalize_pi(raw_angle);
        double nearest = normalize_pi(occupied[0]);
        double nearest_dist = angle_dist(nearest, raw_norm);
        for (double a : occupied) {
            double an = normalize_pi(a);
            double d = angle_dist(an, raw_norm);
            if (d < nearest_dist) { nearest = an; nearest_dist = d; }
        }
        double side = normalize_pi(raw_norm - nearest);
        if (std::fabs(side) < 1e-12) side = 1.0;
        return normalize_pi(nearest + (side > 0 ? 1e-3 : -1e-3));

    };

    std::unordered_map<std::string, int> leaf_memo;
    std::function<int(const std::string&)> leaf_count = [&](const std::string& u) -> int {
        auto it = leaf_memo.find(u);
        if (it != leaf_memo.end()) return it->second;
        auto& kids = children[u];
        if (kids.empty()) { leaf_memo[u] = 1; return 1; }
        int t = 0;
        for (const auto& k : kids) t += leaf_count(k);
        leaf_memo[u] = t;
        return t;
    };

    std::function<void(const std::string&, Point, int, double, double)> assign_subtree =
        [&](const std::string& root, Point anchor, int depth, double s, double e) {
            auto kids = children[root];
            std::sort(kids.begin(), kids.end(), [&](const std::string& a, const std::string& b) {
                if (leaf_count(a) != leaf_count(b)) return leaf_count(a) > leaf_count(b);
                return a < b;
            });
            if (kids.empty()) return;
            int total = 0;
            for (const auto& k : kids) total += leaf_count(k);
            double cursor = s;
            for (const auto& k : kids) {
                double span = (e - s) * leaf_count(k) / std::max(1, total);
                double angle = cursor + span / 2;
                positions[k] = {anchor[0] + level_gap * depth * std::cos(angle),
                                anchor[1] + level_gap * depth * std::sin(angle)};
                assign_subtree(k, anchor, depth + 1, cursor, cursor + span);
                cursor += span;
            }
        };

    for (const auto& cid : core_info.core) {
        int ac = 0;
        for (const auto& r : children[cid]) if (!core_info.core_set.count(r)) ac += 1;
        if (ac == 0) continue;
        Point p = positions[cid];
        double outward = stable_outward_angle(cid);
        double half = std::min(PI * 0.72, std::max(PI / 5, ac * PI / 9));
        assign_subtree(cid, p, 1, outward - half, outward + half);
    }
    auto out = copy_for_nodes(positions, node_ids);
    if (out.empty() || has_crossings(out, edge_pairs)) {
        R.message = "CoreTree could not keep drawing plane"; return R;
    }
    R.ok = true; R.positions = out; R.message = "Computed core-tree layout";
    return R;
}

PositionResult compute_leaf_spread_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& base_positions, const LeafSpreadOptions& opts) {
    PositionResult R;
    auto info = build_graph_info(node_ids, edge_pairs);
    pg::PosByStr positions = copy_for_nodes(base_positions, node_ids);
    if (positions.empty() || has_crossings(positions, edge_pairs)) {
        R.message = "LeafSpread base is not plane"; return R;
    }
    std::unordered_map<std::string, bool> leaf_set;
    std::vector<std::string> leaves;
    std::unordered_map<std::string, std::vector<std::string>> parent_leaves;
    for (const auto& nid : node_ids) {
        if (info.degree.at(nid) != 1) continue;
        auto& adj = info.adjacency.at(nid);
        std::string parent = adj.empty() ? "" : adj[0];
        if (parent.empty() || !positions.count(parent)) continue;
        leaf_set[nid] = true;
        leaves.push_back(nid);
        parent_leaves[parent].push_back(nid);
    }
    if ((int)leaves.size() < opts.min_leaves) { R.message = "LeafSpread needs more leaves"; return R; }

    auto non_leaf_pred = [&](const std::string& u, const std::string& v) {
        return !leaf_set.count(u) && !leaf_set.count(v);
    };
    auto non_leaf_med = median_edge_length(edge_pairs, positions, non_leaf_pred);
    auto all_med = median_edge_length(edge_pairs, positions);
    double target_length = non_leaf_med.value_or(all_med.value_or(1.0));
    if (!(target_length > 0)) { R.message = "LeafSpread has no length scale"; return R; }

    struct Assign { std::string parent; double radius; double angle; };
    std::unordered_map<std::string, Assign> assignment;
    std::vector<std::string> parents;
    for (const auto& kv : parent_leaves) parents.push_back(kv.first);
    std::sort(parents.begin(), parents.end());
    double two_pi = PI * 2;
    for (const auto& parent : parents) {
        Point center = positions[parent];
        auto kids = parent_leaves[parent];
        std::sort(kids.begin(), kids.end());
        std::vector<double> occupied;
        auto nbrs = info.adjacency.at(parent);
        std::sort(nbrs.begin(), nbrs.end());
        for (const auto& neighbor : nbrs) {
            if (leaf_set.count(neighbor)) continue;
            auto it = positions.find(neighbor);
            if (it == positions.end()) continue;
            double a = std::atan2(it->second[1] - center[1], it->second[0] - center[0]);
            a = std::fmod(a, two_pi);
            if (a < 0) a += two_pi;
            occupied.push_back(a);
        }
        auto local_pred = [&](const std::string& u, const std::string& v) {
            return (u == parent || v == parent) && !leaf_set.count(u) && !leaf_set.count(v);
        };
        auto local_med = median_edge_length(edge_pairs, positions, local_pred);
        double radius = local_med.value_or(target_length);
        radius *= 1 + std::min(0.35, 0.04 * std::max(0, (int)kids.size() - 1));

        if (occupied.empty()) {
            for (size_t ki = 0; ki < kids.size(); ++ki) {
                assignment[kids[ki]] = {parent, radius, -PI + two_pi * (ki + 1) / (kids.size() + 1)};
            }
            continue;
        }
        std::sort(occupied.begin(), occupied.end());
        struct Gap { double start; double span; std::vector<std::string> leaves; };
        std::vector<Gap> gaps;
        for (size_t gi = 0; gi < occupied.size(); ++gi) {
            double s = occupied[gi];
            double e = occupied[(gi + 1) % occupied.size()];
            double span = e - s;
            if (span <= 0) span += two_pi;
            gaps.push_back({s, span, {}});
        }
        for (const auto& kid : kids) {
            Gap* best_gap = &gaps[0];
            double best_score = -std::numeric_limits<double>::infinity();
            for (auto& g : gaps) {
                double score = g.span / (g.leaves.size() + 1);
                if (score > best_score) { best_score = score; best_gap = &g; }
            }
            best_gap->leaves.push_back(kid);
        }
        for (auto& g : gaps) {
            if (g.leaves.empty()) continue;
            double margin = std::min(g.span * 0.18, PI / 8);
            double usable = std::max(g.span - 2 * margin, g.span * 0.35);
            double base = g.start + (g.span - usable) / 2;
            for (size_t ki = 0; ki < g.leaves.size(); ++ki) {
                assignment[g.leaves[ki]] = {parent, radius, base + usable * (ki + 1) / (g.leaves.size() + 1)};
            }
        }
    }

    std::vector<double> factors{1.15, 1, 0.85, 0.7, 0.55, 0.4, 0.28};
    for (double factor : factors) {
        pg::PosByStr out = copy_for_nodes(positions, node_ids);
        for (const auto& leaf : leaves) {
            auto it = assignment.find(leaf);
            if (it == assignment.end()) continue;
            const auto& a = it->second;
            Point center = positions[a.parent];
            double r = a.radius * factor;
            out[leaf] = {center[0] + r * std::cos(a.angle), center[1] + r * std::sin(a.angle)};
        }
        if (!has_crossings(out, edge_pairs)) {
            R.ok = true; R.positions = out; R.message = "Computed sparse leaf-spread layout";
            return R;
        }
    }
    R.message = "LeafSpread could not keep drawing plane";
    return R;
}

namespace {
double metric_value(const metrics::MetricResult& mr, const std::string& key) {
    if (!mr.ok) return 0;
    if (key == "edgeRatio") return mr.ratio.value_or(0);
    if (key == "face") return mr.quality.value_or(0);
    return mr.score.value_or(0);
}
} // anon

EvalResult evaluate_positions(const GraphRef& gr,
                              const std::vector<std::string>& node_ids,
                              const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                              const pg::PosByStr& pos, bool assume_plane) {
    EvalResult E;
    pg::PosByStr positions = copy_for_nodes(pos, node_ids);
    if (positions.empty()) { E.score = -std::numeric_limits<double>::infinity(); E.reason = "missing positions"; return E; }
    if (!assume_plane && has_crossings(positions, edge_pairs)) {
        E.score = -std::numeric_limits<double>::infinity(); E.reason = "non-plane drawing"; return E;
    }
    std::optional<planarity::StringEmbedding> emb;
    auto emb_opt = pg::extract_embedding_from_positions(node_ids, edge_pairs, positions);
    if (emb_opt) emb = emb_opt;

    const Graph& g = *gr;
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = positions.find(g.node_names[i]);
        if (it != positions.end()) pm.put(i, it->second[0], it->second[1]);
    }
    std::vector<std::pair<int,int>> iedges = g.edges;

    static const std::vector<std::string> METRIC_KEYS = {
        "angularResolution", "aspectRatio", "convexity",
        "edgeLengthDeviation", "edgeRatio", "edgeOrthogonality",
        "face", "nodeUniformity", "alignment", "spacing"
    };
    std::unordered_map<std::string, double> m;
    m["aspectRatio"] = metric_value(metrics::compute_aspect_ratio_score(g.n, pm), "aspectRatio");
    m["nodeUniformity"] = metric_value(metrics::compute_node_uniformity_score(g.n, pm), "nodeUniformity");
    m["edgeLengthDeviation"] = metric_value(metrics::compute_edge_length_deviation_score(iedges, pm), "edgeLengthDeviation");
    m["edgeRatio"] = metric_value(metrics::compute_edge_length_ratio(iedges, pm), "edgeRatio");
    m["spacing"] = metric_value(metrics::compute_spacing_uniformity_score(g.n, pm), "spacing");
    m["edgeOrthogonality"] = metric_value(metrics::compute_edge_orthogonality_score(iedges, pm), "edgeOrthogonality");
    m["alignment"] = metric_value(metrics::compute_axis_alignment_score(g.n, pm), "alignment");
    m["angularResolution"] = metric_value(metrics::compute_angular_resolution_score(g, pm), "angularResolution");
    if (emb) {
        metrics::FaceMetricInput fin{&emb->faces, &emb->outer_face};
        m["face"] = metric_value(metrics::compute_uniform_face_area_score(fin, positions), "face");
        m["convexity"] = metric_value(metrics::compute_convexity_score(fin, positions, node_ids), "convexity");
    } else {
        m["face"] = 0.0;
        m["convexity"] = 0.0;
    }
    double total = 0;
    for (const auto& k : METRIC_KEYS) total += m[k];
    E.ok = true;
    E.score = total / METRIC_KEYS.size();
    E.metrics = m;
    E.positions = positions;
    return E;
}

pg::PosByStr transform_positions(const pg::PosByStr& pos,
                                 const std::vector<std::string>& node_ids,
                                 double angle, double stretch) {
    double sxy = (std::isfinite(stretch) && stretch > 0) ? stretch : 1.0;
    if ((!std::isfinite(angle) || std::abs(angle) < 1e-12) && std::abs(sxy - 1) < 1e-12) {
        return copy_for_nodes(pos, node_ids);
    }
    double cx = 0, cy = 0;
    int n = 0;
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        if (it == pos.end()) return {};
        cx += it->second[0]; cy += it->second[1]; n += 1;
    }
    if (n == 0) return {};
    cx /= n; cy /= n;
    double c = std::cos(angle), s = std::sin(angle);
    double inv = 1.0 / sxy;
    pg::PosByStr out;
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        double dx = it->second[0] - cx, dy = it->second[1] - cy;
        double rx = c * dx - s * dy;
        double ry = s * dx + c * dy;
        out[nid] = {cx + sxy * rx, cy + inv * ry};
    }
    return out;
}

EvalResult best_transform_for_candidate(const GraphRef& gr,
                                         const std::vector<std::string>& node_ids,
                                         const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                                         const pg::PosByStr& pos, int rotation_samples,
                                         const std::vector<double>& stretch_factors) {
    EvalResult best;
    best.ok = false;
    pg::PosByStr base = copy_for_nodes(pos, node_ids);
    if (base.empty() || has_crossings(base, edge_pairs)) return best;
    int samples = std::max(1, rotation_samples);
    double period = PI;
    for (double stretch : stretch_factors) {
        for (int i = 0; i < samples; ++i) {
            double angle = period * i / samples;
            pg::PosByStr t = transform_positions(base, node_ids, angle, stretch);
            auto e = evaluate_positions(gr, node_ids, edge_pairs, t, true);
            if (!e.ok) continue;
            e.rotation = angle;
            e.stretch = stretch;
            if (!best.ok || e.score > best.score) best = std::move(e);
        }
    }
    return best;
}

PolishResult compute_polished_positions_gpt(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& seed, double seed_score,
    int max_evaluations) {
    PolishResult R;
    pg::PosByStr positions = copy_for_nodes(seed, node_ids);
    if (positions.empty() || has_crossings(positions, edge_pairs)) return R;
    auto best = evaluate_positions(gr, node_ids, edge_pairs, positions, false);
    if (!best.ok) return R;
    double original_score = std::isfinite(seed_score) ? seed_score : best.score;
    if (max_evaluations <= 0) return R;
    std::vector<std::string> ids = node_ids;
    std::sort(ids.begin(), ids.end());
    auto base_len = median_edge_length(edge_pairs, positions);
    double base_length = base_len.value_or(1.0);
    std::vector<double> step_factors{0.16, 0.09, 0.05, 0.028};
    std::vector<std::pair<double,double>> directions{
        {1,0},{-1,0},{0,1},{0,-1},{1,1},{1,-1},{-1,1},{-1,-1}
    };
    int evaluations = 0, moves = 0;

    for (double factor : step_factors) {
        bool improved = true;
        int pass_no = 0;
        while (improved && pass_no < 2) {
            improved = false;
            for (const auto& nid : ids) {
                if (evaluations >= max_evaluations) break;
                auto pit = positions.find(nid);
                if (pit == positions.end()) continue;
                Point p = pit->second;
                std::vector<std::pair<double,double>> local_dirs = directions;
                double rl = std::hypot(p[0], p[1]);
                if (rl > 1e-9) {
                    local_dirs.emplace_back(p[0] / rl, p[1] / rl);
                    local_dirs.emplace_back(-p[0] / rl, -p[1] / rl);
                }
                EvalResult local_best = best;
                bool has_move = false;
                pg::PosByStr local_positions;
                for (auto d : local_dirs) {
                    if (evaluations >= max_evaluations) break;
                    double norm = std::hypot(d.first, d.second);
                    if (norm == 0) norm = 1;
                    pg::PosByStr cand = copy_for_nodes(positions, node_ids);
                    if (cand.empty()) continue;
                    cand[nid] = {p[0] + base_length * factor * d.first / norm,
                                 p[1] + base_length * factor * d.second / norm};
                    evaluations += 1;
                    auto ev = evaluate_positions(gr, node_ids, edge_pairs, cand, false);
                    if (ev.ok && ev.score > local_best.score + 1e-6) {
                        local_best = ev;
                        local_positions = cand;
                        has_move = true;
                    }
                }
                if (has_move) {
                    positions = local_positions;
                    best = local_best;
                    moves += 1;
                    improved = true;
                }
            }
            pass_no += 1;
        }
    }
    if (moves == 0 || best.score <= original_score + 1e-6) return R;
    R.ok = true;
    R.score = best.score;
    R.moves = moves;
    R.evaluations = evaluations;
    R.positions = positions;
    return R;
}

std::unordered_map<std::string, double> compute_scores_claude(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding) {
    const Graph& g = *gr;
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = pos.find(g.node_names[i]);
        if (it != pos.end()) pm.put(i, it->second[0], it->second[1]);
    }
    std::vector<std::pair<int,int>> iedges = g.edges;

    auto aspect = metrics::compute_aspect_ratio_score(g.n, pm);
    auto node_u = metrics::compute_node_uniformity_score(g.n, pm);
    auto edge_dev = metrics::compute_edge_length_deviation_score(iedges, pm);
    auto edge_rat = metrics::compute_edge_length_ratio(iedges, pm);
    auto spacing = metrics::compute_spacing_uniformity_score(g.n, pm);
    auto orth = metrics::compute_edge_orthogonality_score(iedges, pm);
    auto align = metrics::compute_axis_alignment_score(g.n, pm);
    auto ang_res = metrics::compute_angular_resolution_score(g, pm);
    metrics::MetricResult face, conv;
    if (embedding) {
        metrics::FaceMetricInput fin{&embedding->faces, &embedding->outer_face};
        face = metrics::compute_uniform_face_area_score(fin, pos);
        conv = metrics::compute_convexity_score(fin, pos, node_ids);
    }
    std::unordered_map<std::string, double> m;
    m["angularResolution"] = ang_res.ok ? ang_res.score.value_or(0) : 0;
    m["aspectRatio"] = aspect.ok ? aspect.score.value_or(0) : 0;
    m["convexity"] = conv.ok ? conv.score.value_or(0) : 0;
    m["edgeLengthDeviation"] = edge_dev.ok ? edge_dev.score.value_or(0) : 0;
    m["edgeRatio"] = edge_rat.ok ? edge_rat.ratio.value_or(0) : 0;
    m["edgeOrthogonality"] = orth.ok ? orth.score.value_or(0) : 0;
    m["face"] = face.ok ? face.quality.value_or(0) : 0;
    m["nodeUniformity"] = node_u.ok ? node_u.score.value_or(0) : 0;
    m["alignment"] = align.ok ? align.score.value_or(0) : 0;
    m["spacing"] = spacing.ok ? spacing.score.value_or(0) : 0;
    static const std::vector<std::string> MK = {"angularResolution","aspectRatio","convexity","edgeLengthDeviation","edgeRatio","edgeOrthogonality","face","nodeUniformity","alignment","spacing"};
    double total = 0;
    for (const auto& k : MK) total += m[k];
    m["total"] = total / MK.size();
    return m;
}

namespace {
// Planarity check for a tentative move. Port of Python _move_breaks_planarity.
bool move_breaks_planarity(int v_idx, double nx, double ny,
                           const std::vector<Point>& pos_arr,
                           const std::vector<std::pair<int,int>>& edges,
                           const std::vector<std::vector<int>>& incident) {
    constexpr double EPS = 1e-9;
    Point pv{nx, ny};
    std::unordered_set<int> inc_set(incident[v_idx].begin(), incident[v_idx].end());
    const auto& inc_edges = incident[v_idx];

    for (int ei = 0; ei < (int)edges.size(); ++ei) {
        if (inc_set.count(ei)) continue;
        int a = edges[ei].first, b = edges[ei].second;
        Point pa = pos_arr[a], pb = pos_arr[b];
        if (std::abs(geo::triangle_area2(pa, pb, pv)) <= EPS && geo::point_on_segment_interior(pa, pb, pv, EPS)) return true;
        for (int ej : inc_edges) {
            int other = (edges[ej].first == v_idx) ? edges[ej].second : edges[ej].first;
            if (other == a || other == b) continue;
            if (geo::segments_intersect_or_touch(pv, pos_arr[other], pa, pb, EPS)) return true;
        }
    }

    for (int ek : inc_edges) {
        int other_k = (edges[ek].first == v_idx) ? edges[ek].second : edges[ek].first;
        Point po = pos_arr[other_k];
        for (int w = 0; w < (int)pos_arr.size(); ++w) {
            if (w == v_idx || w == other_k) continue;
            Point pw = pos_arr[w];
            if (std::abs(geo::triangle_area2(pv, po, pw)) <= EPS && geo::point_on_segment_interior(pv, po, pw, EPS)) return true;
        }
    }
    return false;
}

struct Scaffold {
    std::unordered_map<std::string, int> id_index;
    std::vector<std::vector<int>> incident;
    std::vector<std::pair<int,int>> edges;
    std::vector<Point> pos_arr;
    int n;
    double diag;
    std::vector<std::string> node_ids;
};

Scaffold build_scaffold(const std::vector<std::string>& node_ids,
                        const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                        const pg::PosByStr& pos) {
    Scaffold S;
    S.node_ids = node_ids;
    for (size_t i = 0; i < node_ids.size(); ++i) S.id_index[node_ids[i]] = (int)i;
    S.n = (int)node_ids.size();
    S.incident.assign(S.n, {});
    for (const auto& [u, v] : edge_pairs) {
        auto iu = S.id_index.find(u), iv = S.id_index.find(v);
        if (iu == S.id_index.end() || iv == S.id_index.end() || iu->second == iv->second) continue;
        int ei = (int)S.edges.size();
        S.edges.emplace_back(iu->second, iv->second);
        S.incident[iu->second].push_back(ei);
        S.incident[iv->second].push_back(ei);
    }
    S.pos_arr.assign(S.n, Point{0, 0});
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double max_x = -min_x, max_y = -min_y;
    for (int i = 0; i < S.n; ++i) {
        auto it = pos.find(S.node_ids[i]);
        if (it != pos.end()) {
            S.pos_arr[i] = it->second;
            if (it->second[0] < min_x) min_x = it->second[0];
            if (it->second[0] > max_x) max_x = it->second[0];
            if (it->second[1] < min_y) min_y = it->second[1];
            if (it->second[1] > max_y) max_y = it->second[1];
        }
    }
    double dx = max_x - min_x, dy = max_y - min_y;
    S.diag = std::sqrt(dx * dx + dy * dy);
    if (!(S.diag > 0)) S.diag = 1.0;
    return S;
}

pg::PosByStr snapshot(const Scaffold& S) {
    pg::PosByStr out;
    for (int i = 0; i < S.n; ++i) out[S.node_ids[i]] = S.pos_arr[i];
    return out;
}
} // anon

ClaudePolishResult polish_by_local_moves(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    const ClaudePolishOptions& opts) {
    static const std::vector<std::pair<double,double>> DIRS8 = {
        {1,0},{-1,0},{0,1},{0,-1},
        {0.707,0.707},{-0.707,0.707},{0.707,-0.707},{-0.707,-0.707}
    };
    Scaffold S = build_scaffold(node_ids, edge_pairs, pos);
    auto scores_now = [&]() { return compute_scores_claude(gr, node_ids, edge_pairs, snapshot(S), embedding); };
    double best_total = scores_now()["total"];
    double scale = opts.step_scale;
    for (int pass = 0; pass < opts.max_passes; ++pass) {
        double step = scale * S.diag;
        if (step < opts.min_step_scale * S.diag) break;
        bool improved = false;
        for (int vi = 0; vi < S.n; ++vi) {
            double px = S.pos_arr[vi][0], py = S.pos_arr[vi][1];
            double best_dx = 0, best_dy = 0;
            for (auto d : DIRS8) {
                double dx = d.first * step, dy = d.second * step;
                if (move_breaks_planarity(vi, px + dx, py + dy, S.pos_arr, S.edges, S.incident)) continue;
                S.pos_arr[vi] = {px + dx, py + dy};
                auto sc = scores_now();
                S.pos_arr[vi] = {px, py};
                if (sc["total"] > best_total + 1e-8) {
                    best_total = sc["total"];
                    best_dx = dx; best_dy = dy;
                    improved = true;
                }
            }
            if (best_dx != 0 || best_dy != 0) {
                S.pos_arr[vi] = {px + best_dx, py + best_dy};
            }
        }
        if (!improved) scale *= 0.5;
    }
    ClaudePolishResult R;
    R.positions = snapshot(S);
    R.embedding = embedding;
    R.scores = compute_scores_claude(gr, node_ids, edge_pairs, R.positions, embedding);
    return R;
}

ClaudePolishResult convexity_repair(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    int max_passes) {
    Scaffold S = build_scaffold(node_ids, edge_pairs, pos);
    auto scores_now = [&]() { return compute_scores_claude(gr, node_ids, edge_pairs, snapshot(S), embedding); };
    double best_total = scores_now()["total"];

    auto reflex_indices = [&](const std::vector<std::string>& face) -> std::vector<int> {
        std::vector<int> result;
        if (face.size() < 4) return result;
        std::vector<Point> pts;
        for (const auto& k : face) {
            auto it = S.id_index.find(k);
            if (it == S.id_index.end()) return {};
            pts.push_back(S.pos_arr[it->second]);
        }
        double s_area = 0;
        for (size_t k = 0; k < pts.size(); ++k) {
            Point a = pts[k], b = pts[(k + 1) % pts.size()];
            s_area += a[0] * b[1] - b[0] * a[1];
        }
        int orient = s_area >= 0 ? 1 : -1;
        double eps = S.diag * 1e-9;
        for (size_t k = 0; k < pts.size(); ++k) {
            Point prev = pts[(k + pts.size() - 1) % pts.size()];
            Point cur = pts[k];
            Point nxt = pts[(k + 1) % pts.size()];
            double turn = (cur[0] - prev[0]) * (nxt[1] - cur[1]) - (cur[1] - prev[1]) * (nxt[0] - cur[0]);
            if (std::abs(turn) <= eps) continue;
            int ts = turn > 0 ? 1 : -1;
            if (ts != orient) result.push_back(S.id_index.at(face[k]));
        }
        return result;
    };

    for (int pass = 0; pass < max_passes; ++pass) {
        if (!embedding || !embedding->ok) break;
        int outer_idx = pg::find_outer_face_index(embedding->faces, embedding->outer_face);
        bool improved = false;
        for (size_t fi = 0; fi < embedding->faces.size(); ++fi) {
            if ((int)fi == outer_idx) continue;
            const auto& face = embedding->faces[fi];
            if (face.size() < 4) continue;
            auto reflex = reflex_indices(face);
            if (reflex.empty()) continue;
            double cx = 0, cy = 0;
            int m = 0;
            bool valid = true;
            for (const auto& fk : face) {
                auto it = S.id_index.find(fk);
                if (it == S.id_index.end()) { valid = false; break; }
                cx += S.pos_arr[it->second][0];
                cy += S.pos_arr[it->second][1];
                m += 1;
            }
            if (!valid || m == 0) continue;
            cx /= m; cy /= m;
            for (int v_idx : reflex) {
                double px = S.pos_arr[v_idx][0], py = S.pos_arr[v_idx][1];
                double ddx = cx - px, ddy = cy - py;
                double dlen = std::hypot(ddx, ddy);
                if (!(dlen > 0)) continue;
                ddx /= dlen; ddy /= dlen;
                std::vector<double> steps{0.4, 0.2, 0.1, 0.05, 0.02};
                double best_dx = 0, best_dy = 0;
                for (double s : steps) {
                    double dist = std::min(dlen * s, 0.15 * S.diag);
                    double nx = px + ddx * dist;
                    double ny = py + ddy * dist;
                    if (move_breaks_planarity(v_idx, nx, ny, S.pos_arr, S.edges, S.incident)) continue;
                    S.pos_arr[v_idx] = {nx, ny};
                    auto sc = scores_now();
                    S.pos_arr[v_idx] = {px, py};
                    if (sc["total"] > best_total + 1e-8) {
                        best_total = sc["total"];
                        best_dx = ddx * dist;
                        best_dy = ddy * dist;
                    }
                }
                if (best_dx != 0 || best_dy != 0) {
                    S.pos_arr[v_idx] = {px + best_dx, py + best_dy};
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    ClaudePolishResult R;
    R.positions = snapshot(S);
    R.embedding = embedding;
    R.scores = compute_scores_claude(gr, node_ids, edge_pairs, R.positions, embedding);
    return R;
}

namespace {
pg::PosByStr rotate_positions(const pg::PosByStr& pos, double theta) {
    if (pos.empty()) return {};
    double cx = 0, cy = 0;
    for (const auto& kv : pos) { cx += kv.second[0]; cy += kv.second[1]; }
    cx /= pos.size(); cy /= pos.size();
    double c = std::cos(theta), s = std::sin(theta);
    pg::PosByStr out;
    for (const auto& kv : pos) {
        double dx = kv.second[0] - cx, dy = kv.second[1] - cy;
        out[kv.first] = {cx + dx * c - dy * s, cy + dx * s + dy * c};
    }
    return out;
}
} // anon

RotResult find_best_rotation_claude(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding) {
    RotResult R;
    R.positions = pos;
    bool first = true;
    for (int i = 0; i < 19; ++i) {
        double theta = (i / 18.0) * (PI / 2);
        pg::PosByStr cand = (i == 0) ? pos : rotate_positions(pos, theta);
        auto s = compute_scores_claude(gr, node_ids, edge_pairs, cand, embedding);
        if (first || s["total"] > R.scores["total"]) {
            R.positions = cand;
            R.scores = s;
            first = false;
        }
    }
    return R;
}

LCGRng make_seeded_rng(const std::vector<std::string>& node_ids,
                       const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    std::vector<std::string> sids = node_ids;
    std::sort(sids.begin(), sids.end());
    std::string key;
    for (size_t i = 0; i < sids.size(); ++i) { if (i) key += ","; key += sids[i]; }
    key += "|";
    std::vector<std::string> se;
    for (const auto& [a, b] : edge_pairs) {
        std::string mn = std::min(a, b), mx = std::max(a, b);
        se.push_back(mn + "-" + mx);
    }
    std::sort(se.begin(), se.end());
    for (size_t i = 0; i < se.size(); ++i) { if (i) key += ";"; key += se[i]; }
    uint32_t h = 2166136261u;
    for (char ch : key) {
        h ^= (uint32_t)(unsigned char)ch;
        h = (uint32_t)(h * 16777619u);
    }
    return LCGRng(h);
}

ClaudePolishResult restart_perturb_and_polish(
    const GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding,
    LCGRng& rng, double perturb_scale, int max_passes, double step_scale) {
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double max_x = -min_x, max_y = -min_y;
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        if (it == pos.end()) continue;
        if (it->second[0] < min_x) min_x = it->second[0];
        if (it->second[0] > max_x) max_x = it->second[0];
        if (it->second[1] < min_y) min_y = it->second[1];
        if (it->second[1] > max_y) max_y = it->second[1];
    }
    double diag = std::hypot(max_x - min_x, max_y - min_y);
    if (!(diag > 0)) diag = 1.0;
    pg::PosByStr perturbed;
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        if (it == pos.end()) return {pos, compute_scores_claude(gr, node_ids, edge_pairs, pos, embedding), embedding};
        perturbed[nid] = {
            it->second[0] + (rng.next() * 2 - 1) * perturb_scale * diag,
            it->second[1] + (rng.next() * 2 - 1) * perturb_scale * diag
        };
    }
    if (has_crossings(perturbed, edge_pairs)) {
        ClaudePolishResult R;
        R.positions = pos;
        R.embedding = embedding;
        R.scores = compute_scores_claude(gr, node_ids, edge_pairs, pos, embedding);
        return R;
    }
    ClaudePolishOptions o;
    o.max_passes = max_passes;
    o.step_scale = step_scale;
    o.min_step_scale = 0.0005;
    return polish_by_local_moves(gr, node_ids, edge_pairs, perturbed, embedding, o);
}

} // namespace planarvibe::ensemble
