#include "layouts/schnyder.hpp"

#include "geometry.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <deque>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace planarvibe::layouts {

namespace {

using StrVec = std::vector<std::string>;
using StrSet = std::unordered_set<std::string>;
using Adj = std::unordered_map<std::string, StrVec>;

Adj build_rotation_by_id(const planarity::StringEmbedding& emb) {
    Adj out;
    for (size_t i = 0; i < emb.id_by_index.size(); ++i) {
        out[emb.id_by_index[i]] = (i < emb.rotation.size()) ? emb.rotation[i] : StrVec{};
    }
    return out;
}

StrVec contract(const StrVec& node_ids, const Adj& adjacency,
                const std::string& a, const std::string& b, const std::string& c) {
    int N = 0;
    for (const auto& nid : node_ids) {
        auto it = adjacency.find(nid);
        if (it != adjacency.end()) N += (int)it->second.size();
    }
    N /= 2;
    std::unordered_map<std::string, bool> marked;
    std::unordered_map<std::string, int> deg;
    for (const auto& nid : node_ids) { marked[nid] = false; deg[nid] = 0; }
    marked[a] = marked[b] = marked[c] = true;
    deg[a] = deg[b] = deg[c] = N;

    auto ait = adjacency.find(a);
    const StrVec& an = (ait != adjacency.end()) ? ait->second : StrVec{};
    for (const auto& x : an) {
        marked[x] = true;
        auto xit = adjacency.find(x);
        if (xit == adjacency.end()) continue;
        for (const auto& y : xit->second) deg[y]++;
    }
    std::deque<std::string> candidates;
    for (const auto& x : an) if (deg[x] <= 2) candidates.push_back(x);

    StrVec L;
    while (!candidates.empty()) {
        std::string u = candidates.front();
        candidates.pop_front();
        if (deg[u] != 2) continue;
        L.insert(L.begin(), u);
        deg[u] = N;
        auto uit = adjacency.find(u);
        if (uit == adjacency.end()) continue;
        for (const auto& nb : uit->second) {
            deg[nb]--;
            if (!marked[nb]) {
                marked[nb] = true;
                auto nit = adjacency.find(nb);
                if (nit != adjacency.end()) {
                    for (const auto& t : nit->second) deg[t]++;
                }
                if (deg[nb] <= 2) candidates.push_back(nb);
            } else if (deg[nb] == 2) {
                candidates.push_back(nb);
            }
        }
    }
    return L;
}

struct RealizerOut {
    bool ok = false;
    std::string reason;
    std::unordered_map<std::string, int> ord;
    std::unordered_map<int, Adj> out_adj_by_label;  // label 1/2/3 -> src -> [dst]
};

void add_labeled_edge(RealizerOut& r, const std::string& src, const std::string& dst, int label) {
    r.out_adj_by_label[label][src].push_back(dst);
}

RealizerOut realizer(const StrVec& node_ids, const StrVec& L,
                     const std::string& a, const std::string& b, const std::string& c,
                     const Adj& rotation_by_id, const Adj& adjacency) {
    RealizerOut r;
    r.ord[b] = 0;
    r.ord[c] = 1;
    int i = 2;
    for (const auto& x : L) r.ord[x] = i++;
    r.ord[a] = i;

    for (int label : {1, 2, 3}) {
        r.out_adj_by_label[label] = {};
        for (const auto& nid : node_ids) r.out_adj_by_label[label][nid] = {};
    }

    auto ord_of = [&](const std::string& x) {
        auto it = r.ord.find(x);
        return (it != r.ord.end()) ? it->second : 0;
    };

    for (const auto& v : L) {
        auto rit = rotation_by_id.find(v);
        if (rit == rotation_by_id.end() || rit->second.empty()) {
            r.reason = "Missing rotation at vertex " + v;
            return r;
        }
        const auto& rot = rit->second;
        int first_idx = -1;
        for (int j = 0; j < (int)rot.size(); ++j) {
            if (ord_of(rot[j]) > ord_of(v)) { first_idx = j; break; }
        }
        if (first_idx < 0) {
            r.reason = "Could not find higher-order neighbor at vertex " + v;
            return r;
        }
        int idx1 = first_idx;
        while (ord_of(rot[idx1]) > ord_of(v)) idx1 = (idx1 + 1) % (int)rot.size();
        add_labeled_edge(r, rot[idx1], v, 2);

        int idx2 = first_idx;
        while (ord_of(rot[idx2]) > ord_of(v)) idx2 = (idx2 - 1 + (int)rot.size()) % (int)rot.size();
        add_labeled_edge(r, rot[idx2], v, 3);

        int walk = (idx1 + 1) % (int)rot.size();
        while (walk != idx2) {
            add_labeled_edge(r, v, rot[walk], 1);
            walk = (walk + 1) % (int)rot.size();
        }
    }

    auto ait = adjacency.find(a);
    if (ait != adjacency.end()) {
        for (const auto& x : ait->second) add_labeled_edge(r, a, x, 1);
    }
    add_labeled_edge(r, b, a, 2);
    add_labeled_edge(r, b, c, 2);
    add_labeled_edge(r, c, a, 3);
    add_labeled_edge(r, c, b, 3);
    r.ok = true;
    return r;
}

// Non-recursive subtree sizes. Mirrors the Python recursive DFS in which a
// recursive call on a currently-visiting vertex returns 1 (cycle guard).
// Iterative form: post-order walk; on-stack kids contribute 1 directly to
// their parent's sum rather than being pushed again.
std::unordered_map<std::string, int> subtree_sizes(const Adj& adj, const std::string& root) {
    std::unordered_map<std::string, int> memo;
    std::vector<std::pair<std::string, int>> stk;  // (node, child index)
    std::unordered_set<std::string> on_stack;
    stk.push_back({root, 0});
    on_stack.insert(root);
    while (!stk.empty()) {
        auto& [v, ci] = stk.back();
        auto it = adj.find(v);
        const StrVec& kids = (it != adj.end()) ? it->second : StrVec{};
        if (ci < (int)kids.size()) {
            const auto& w = kids[ci++];
            if (!memo.count(w) && !on_stack.count(w)) {
                stk.push_back({w, 0});
                on_stack.insert(w);
            }
            // If w is on_stack (cycle) or already memoized, we don't push;
            // we'll pick it up in the parent's sum below (memo[w] = 1 for
            // cycle kids since Python's dfs returns 1 for `visiting[v]`).
        } else {
            int s = 0;
            for (const auto& w : kids) {
                auto mit = memo.find(w);
                if (mit != memo.end()) s += mit->second;
                else s += 1;  // cycle guard: Python returns 1 for on-stack kids
            }
            memo[v] = s + 1;
            on_stack.erase(v);
            stk.pop_back();
        }
    }
    return memo;
}

std::unordered_map<std::string, double> prefix_sum(const Adj& adj, const std::string& root,
                                                    const std::unordered_map<std::string, double>& val) {
    std::unordered_map<std::string, double> summed;
    std::deque<std::string> queue{root};
    auto vroot = val.find(root);
    summed[root] = (vroot != val.end()) ? vroot->second : 0.0;
    while (!queue.empty()) {
        std::string v = queue.front();
        queue.pop_front();
        auto it = adj.find(v);
        if (it == adj.end()) continue;
        for (const auto& w : it->second) {
            if (summed.count(w)) continue;
            auto vit = val.find(w);
            summed[w] = (vit != val.end() ? vit->second : 0.0) + summed[v];
            queue.push_back(w);
        }
    }
    return summed;
}

struct SchnyderCoords {
    std::unordered_map<std::string, double> x, y;
};

SchnyderCoords compute_coordinates(const StrVec& node_ids, const RealizerOut& ro,
                                    const std::string& a, const std::string& b, const std::string& c) {
    const auto& L1 = ro.out_adj_by_label.at(1);
    const auto& L2 = ro.out_adj_by_label.at(2);
    const auto& L3 = ro.out_adj_by_label.at(3);
    auto t1 = subtree_sizes(L1, a);
    auto t2 = subtree_sizes(L2, b);
    std::unordered_map<std::string, double> ones;
    for (const auto& nid : node_ids) ones[nid] = 1.0;
    auto p1 = prefix_sum(L1, a, ones);
    (void)p1;
    auto p3 = prefix_sum(L3, c, ones);
    // x
    std::unordered_map<std::string, double> t1d;
    for (const auto& [k, v] : t1) t1d[k] = double(v);
    auto sum1 = prefix_sum(L2, b, t1d);
    sum1[a] = double(t1.count(a) ? t1.at(a) : 1);
    auto sum2 = prefix_sum(L3, c, t1d);
    sum2[a] = double(t1.count(a) ? t1.at(a) : 1);
    SchnyderCoords out;
    for (const auto& v : node_ids) {
        double r1 = (sum1.count(v) ? sum1.at(v) : 0) + (sum2.count(v) ? sum2.at(v) : 0) - (t1.count(v) ? t1.at(v) : 1);
        out.x[v] = r1 - (p3.count(v) ? p3.at(v) : 1);
    }
    // y
    std::unordered_map<std::string, double> t2d;
    for (const auto& [k, v] : t2) t2d[k] = double(v);
    sum1 = prefix_sum(L3, c, t2d);
    sum1[b] = double(t2.count(b) ? t2.at(b) : 1);
    sum2 = prefix_sum(L1, a, t2d);
    sum2[b] = double(t2.count(b) ? t2.at(b) : 1);
    auto p1b = prefix_sum(L1, a, ones);
    for (const auto& v : node_ids) {
        double r2 = (sum1.count(v) ? sum1.at(v) : 0) + (sum2.count(v) ? sum2.at(v) : 0) - (t2.count(v) ? t2.at(v) : 1);
        out.y[v] = r2 - (p1b.count(v) ? p1b.at(v) : 1);
    }
    return out;
}

std::optional<pg::PosByStr> build_screen_positions(const SchnyderCoords& c, const StrVec& node_ids) {
    double min_x = std::numeric_limits<double>::infinity(), max_y = -min_x;
    for (const auto& nid : node_ids) {
        auto xit = c.x.find(nid), yit = c.y.find(nid);
        if (xit == c.x.end() || yit == c.y.end()) return std::nullopt;
        if (!std::isfinite(xit->second) || !std::isfinite(yit->second)) return std::nullopt;
        if (xit->second < min_x) min_x = xit->second;
        if (yit->second > max_y) max_y = yit->second;
    }
    const double SCALE = 30.0;
    pg::PosByStr out;
    for (const auto& nid : node_ids) {
        out[nid] = {(c.x.at(nid) - min_x) * SCALE + 20, (max_y - c.y.at(nid)) * SCALE + 20};
    }
    return out;
}

std::vector<StrVec> group_overlaps(const pg::PosByStr& pos) {
    std::unordered_map<std::string, StrVec> buckets;
    for (const auto& [nid, p] : pos) {
        if (!std::isfinite(p[0]) || !std::isfinite(p[1])) continue;
        char buf[80];
        std::snprintf(buf, sizeof(buf), "%.17g,%.17g", p[0], p[1]);
        buckets[buf].push_back(nid);
    }
    std::vector<StrVec> out;
    for (auto& [_, v] : buckets) {
        if (v.size() > 1) {
            std::sort(v.begin(), v.end());
            out.push_back(std::move(v));
        }
    }
    return out;
}

// Port of Python _resolve_overlaps_without_crossings. Tries to move
// overlapping points onto a small ring around the anchor, picking the first
// configuration that has no remaining overlaps AND no edge crossings.
std::optional<pg::PosByStr> resolve_overlaps_without_crossings(
    const pg::PosByStr& pos,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    auto groups = group_overlaps(pos);
    if (groups.empty()) return pos;
    pg::PosByStr cur = pos;
    const int DIRS = 24;
    std::vector<std::pair<double,double>> ring;
    ring.reserve(DIRS);
    for (int a = 0; a < DIRS; ++a) {
        double th = 2.0 * M_PI * a / DIRS;
        ring.emplace_back(std::cos(th), std::sin(th));
    }
    static const double radii[] = {0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0};

    // Helper: does trial have any crossings on edge_pairs?
    auto has_crossings = [&](const pg::PosByStr& trial) {
        // Build local int index over the trial's nodes.
        std::unordered_map<std::string,int> idx;
        for (const auto& [nid, _] : trial) { idx[nid] = (int)idx.size(); }
        PositionMap pm;
        pm.resize((int)idx.size());
        for (const auto& [nid, p] : trial) pm.put(idx[nid], p[0], p[1]);
        std::vector<std::pair<int,int>> eints;
        for (const auto& [u, v] : edge_pairs) {
            auto iu = idx.find(u), iv = idx.find(v);
            if (iu == idx.end() || iv == idx.end()) continue;
            eints.emplace_back(iu->second, iv->second);
        }
        return geo::has_position_crossings(pm, eints);
    };

    for (const auto& group : groups) {
        auto anchor = cur[group[0]];
        bool placed = false;
        for (double radius : radii) {
            if (placed) break;
            for (int phase = 0; phase < (int)ring.size() && !placed; ++phase) {
                pg::PosByStr trial = cur;
                for (size_t i = 0; i < group.size(); ++i) {
                    int idxr = (phase + (int)((i * ring.size()) / group.size())) % (int)ring.size();
                    trial[group[i]] = {anchor[0] + ring[idxr].first * radius,
                                        anchor[1] + ring[idxr].second * radius};
                }
                if (!group_overlaps(trial).empty()) continue;
                if (has_crossings(trial)) continue;
                cur = trial;
                placed = true;
            }
        }
        if (!placed) return std::nullopt;
    }
    if (!group_overlaps(cur).empty()) return std::nullopt;
    if (has_crossings(cur)) return std::nullopt;
    return cur;
}

int count_overlap_extras(const std::vector<StrVec>& groups) {
    int n = 0;
    for (const auto& g : groups) n += (int)g.size() - 1;
    return n;
}

std::vector<std::tuple<std::string, std::string, std::string>>
candidate_outer_triples(const planarity::StringEmbedding& emb, const Adj& rotation_by_id) {
    std::vector<std::tuple<std::string, std::string, std::string>> out;
    if (emb.edges.empty()) return out;
    const auto& e0 = emb.edges[0];
    std::string a = e0.first, b = e0.second;
    auto rit = rotation_by_id.find(b);
    if (rit == rotation_by_id.end()) return out;
    const auto& rot_b = rit->second;
    auto ait = std::find(rot_b.begin(), rot_b.end(), a);
    if (ait == rot_b.end()) return out;
    int idx_a = (int)(ait - rot_b.begin());
    std::string c = rot_b[(idx_a - 1 + (int)rot_b.size()) % rot_b.size()];
    out.emplace_back(a, b, c);
    out.emplace_back(a, c, b);
    return out;
}

} // namespace

LayoutResult schnyder(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = "Schnyder";
    cfg.current_positions = initial_positions;
    cfg.triangulate_outer_face = true;
    auto prep = preprocessing::prepare_graph_data(g, cfg);
    if (!prep.ok) {
        r.ok = false;
        r.message = prep.message.empty() ? "Schnyder failed" : prep.message;
        return r;
    }

    auto rotation_by_id = build_rotation_by_id(prep.augmented_embedding);
    Adj adjacency;
    for (const auto& nid : prep.augmented_node_ids) adjacency[nid] = {};
    for (const auto& [u, v] : prep.augmented_edge_pairs) {
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
    }

    pg::PosByStr best_pos;
    int best_overlap = std::numeric_limits<int>::max();
    bool have = false;
    auto candidates = candidate_outer_triples(prep.augmented_embedding, rotation_by_id);
    if (candidates.empty() && prep.augmented_embedding.outer_face.size() >= 3) {
        const auto& of = prep.augmented_embedding.outer_face;
        candidates.emplace_back(of[0], of[1], of[2]);
    }

    for (const auto& [a, b, c] : candidates) {
        auto L = contract(prep.augmented_node_ids, adjacency, a, b, c);
        if ((int)L.size() != (int)prep.augmented_node_ids.size() - 3) continue;
        auto ro = realizer(prep.augmented_node_ids, L, a, b, c, rotation_by_id, adjacency);
        if (!ro.ok) continue;
        auto coords = compute_coordinates(prep.augmented_node_ids, ro, a, b, c);
        auto screen = build_screen_positions(coords, g.node_names);
        if (!screen) continue;
        // Check crossings on the original graph only.
        PositionMap pm;
        pm.resize(g.n);
        for (int i = 0; i < g.n; ++i) {
            auto it = screen->find(g.node_names[i]);
            if (it != screen->end()) pm.put(i, it->second[0], it->second[1]);
        }
        if (geo::has_position_crossings(pm, g.edges)) continue;
        auto groups = group_overlaps(*screen);
        pg::PosByStr pos_use = *screen;
        if (!groups.empty()) {
            auto resolved = resolve_overlaps_without_crossings(*screen,
                [&]{ std::vector<std::pair<std::string,std::string>> eps;
                     for (const auto& [u, v] : g.edges) eps.emplace_back(g.node_names[u], g.node_names[v]);
                     return eps;
                }());
            if (resolved) {
                pos_use = *resolved;
                groups = group_overlaps(pos_use);
            }
        }
        int overlap = count_overlap_extras(groups);
        if (overlap < best_overlap) {
            best_overlap = overlap;
            best_pos = pos_use;
            have = true;
        }
        if (overlap == 0) break;
    }

    if (!have) {
        r.ok = false;
        r.message = "Schnyder failed to find crossing-free embedding";
        return r;
    }

    // Normalize to viewport.
    PositionMap pm;
    pm.resize((int)g.node_names.size());
    for (int i = 0; i < g.n; ++i) {
        auto it = best_pos.find(g.node_names[i]);
        if (it != best_pos.end()) pm.put(i, it->second[0], it->second[1]);
    }
    auto normalized = geo::normalize_position_map_to_viewport(pm);
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        if (normalized.has(i)) r.positions.put(i, normalized.pos[i][0], normalized.pos[i][1]);
    }
    r.ok = true;
    r.message = "Schnyder layout";
    return r;
}

} // namespace planarvibe::layouts
