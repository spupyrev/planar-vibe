#include "layouts/forcedir.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "metrics.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct FDConfig {
    int eval_every = 10;
    double alpha = 1.2;
    double initial_step_factor = 0.02;
    double min_step_factor = 1e-5;
    int min_iters_before_stop = 30;
    int stable_iter_limit = 8;
    double movement_stop_tol_factor = 1e-4;
    double avg_movement_stop_tol_factor = 2e-5;
    double epsilon = 1e-9;
    double repulsion_eps = 1e-6;
    double repulsion_power = 2;
    int max_iters = 400;
    double beta = 0.45;
    int alpha_grow_every = 120;
    double alpha_grow_factor = 1.15;
    double alpha_cap = 4.0;
    double step_decay = 0.5;
    double max_force = 9.0;
    double eta = 1.2;
    double zeta = 3.2;
    double collision_boost = 6.0;
    int k_nearest = 4;
};

double median(std::vector<double> v) {
    if (v.empty()) return 1.0;
    std::sort(v.begin(), v.end());
    size_t mid = v.size() / 2;
    if (v.size() % 2) return v[mid];
    return 0.5 * (v[mid - 1] + v[mid]);
}

bool would_introduce_crossing(
    const std::string& v, Point new_pos, const pg::PosByStr& pos,
    const std::vector<std::pair<std::string,std::string>>& edges,
    const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
    double eps) {
    auto ait = adjacency.find(v);
    if (ait == adjacency.end()) return false;
    for (const auto& other : ait->second) {
        auto pit = pos.find(other);
        if (pit == pos.end()) continue;
        for (const auto& [a, b] : edges) {
            if (a == v || b == v || a == other || b == other) continue;
            auto ia = pos.find(a), ib = pos.find(b);
            if (ia == pos.end() || ib == pos.end()) continue;
            if (geo::segments_intersect_or_touch(new_pos, pit->second, ia->second, ib->second, eps)) return true;
        }
    }
    return false;
}

struct NNData {
    std::unordered_map<std::string, std::pair<std::string, double>> nn_by_id;
    double mean_dist = 0;
    std::unordered_map<std::string, std::vector<std::pair<std::string, double>>> knearest_by_id;
    double mean_k_dist = 0;
};

NNData compute_nearest_neighbor_data(const std::vector<std::string>& node_ids,
                                      const pg::PosByStr& pos, int k_nearest) {
    NNData r;
    double ssum = 0; int cnt = 0, cnt_k = 0;
    double sum_k = 0;
    int k = std::max(1, k_nearest);
    for (size_t i = 0; i < node_ids.size(); ++i) {
        const auto& v = node_ids[i];
        auto pv = pos.find(v);
        if (pv == pos.end()) continue;
        std::vector<std::pair<std::string, double>> cands;
        for (size_t j = 0; j < node_ids.size(); ++j) {
            if (i == j) continue;
            auto pu = pos.find(node_ids[j]);
            if (pu == pos.end()) continue;
            double dx = pv->second[0] - pu->second[0];
            double dy = pv->second[1] - pu->second[1];
            cands.emplace_back(node_ids[j], std::sqrt(dx * dx + dy * dy));
        }
        std::stable_sort(cands.begin(), cands.end(), [](const auto& a, const auto& b){ return a.second < b.second; });
        if (!cands.empty()) {
            r.nn_by_id[v] = cands[0];
            if (cands[0].second > 1e-12) { ssum += cands[0].second; ++cnt; }
        }
        int kk = std::min(k, (int)cands.size());
        std::vector<std::pair<std::string, double>> local_k;
        for (int c = 0; c < kk; ++c) {
            local_k.push_back(cands[c]);
            if (cands[c].second > 1e-12) { sum_k += cands[c].second; ++cnt_k; }
        }
        r.knearest_by_id[v] = std::move(local_k);
    }
    r.mean_dist = cnt > 0 ? ssum / cnt : 0;
    r.mean_k_dist = cnt_k > 0 ? sum_k / cnt_k : 0;
    return r;
}

double evaluate_spacing_quality(
    const Graph& orig, const std::vector<std::pair<std::string,std::string>>& edges,
    const pg::PosByStr& pos) {
    PositionMap pm;
    pm.resize(orig.n);
    for (int i = 0; i < orig.n; ++i) {
        auto it = pos.find(orig.node_names[i]);
        if (it != pos.end()) pm.put(i, it->second[0], it->second[1]);
    }
    if (geo::has_position_crossings(pm, orig.edges)) return std::numeric_limits<double>::quiet_NaN();
    auto s = metrics::compute_spacing_uniformity_score(orig.n, pm);
    if (!s.ok || !s.score || !std::isfinite(*s.score)) return std::numeric_limits<double>::quiet_NaN();
    return *s.score;
    (void)edges;
}

} // namespace

LayoutResult forcedir(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    FDConfig C;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = "ForceDir";
    cfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_and_layout_data(g, cfg);
    if (!prep.ok) {
        r.ok = false;
        r.message = prep.message.empty() ? "ForceDir failed" : prep.message;
        return r;
    }
    // ForceDir iterates over the ORIGINAL graph (JS runtime uses pre-augment view).
    std::vector<std::string> ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> pairs;
    for (const auto& [u, v] : g.edges) pairs.emplace_back(g.node_names[u], g.node_names[v]);
    if (pairs.size() < 3) {
        r.ok = false;
        r.message = "ForceDir requires at least 3 edges";
        return r;
    }
    // Filter pos to original node ids.
    pg::PosByStr pos;
    for (const auto& nid : ids) {
        auto it = prep.pos_by_id.find(nid);
        if (it != prep.pos_by_id.end()) pos[nid] = it->second;
    }
    // Build adjacency on the ORIGINAL graph.
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& nid : ids) adjacency[nid] = {};
    for (const auto& [u, v] : pairs) {
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
    }
    auto movable = gh::collect_movable_vertex_names(ids, prep.outer_face);

    // Target edge length = median edge length.
    std::vector<double> lengths;
    for (const auto& [u, v] : pairs) {
        auto pu = pos.find(u), pv = pos.find(v);
        if (pu == pos.end() || pv == pos.end()) continue;
        double dx = pu->second[0] - pv->second[0];
        double dy = pu->second[1] - pv->second[1];
        double l = std::sqrt(dx * dx + dy * dy);
        if (l > 1e-9) lengths.push_back(l);
    }
    double target_length = median(lengths);

    // Drawing diameter as a scale.
    PositionMap pm_scale;
    pm_scale.resize((int)ids.size());
    for (int i = 0; i < (int)ids.size(); ++i) {
        auto it = pos.find(ids[i]);
        if (it != pos.end()) pm_scale.put(i, it->second[0], it->second[1]);
    }
    double diameter = geo::compute_drawing_diameter((int)ids.size(), pm_scale);
    double h = std::max(1e-8, C.initial_step_factor * diameter);
    double h_min = std::max(1e-10, C.min_step_factor * diameter);

    gh::MovementTrackerConfig tcfg;
    tcfg.min_iters_before_stop = C.min_iters_before_stop;
    tcfg.stable_iter_limit = C.stable_iter_limit;
    tcfg.max_move_tol = C.movement_stop_tol_factor * diameter;
    tcfg.avg_move_tol = C.avg_movement_stop_tol_factor * diameter;
    gh::MovementTracker tracker(tcfg);

    double alpha = C.alpha;
    double best_score = -std::numeric_limits<double>::infinity();
    pg::PosByStr best_pos;
    bool have_best = false;
    int performed_iters = 0;
    std::string stop_reason = "max-iters";
    int accepted_total = 0, rejected_total = 0;

    for (int it = 1; it <= C.max_iters; ++it) {
        if (h < h_min) { stop_reason = "step-too-small"; break; }
        performed_iters = it;
        pg::PosByStr prev = pos;
        int accepted = 0, rejected = 0;
        double uniformity_boost = 1 + 2.0 * (it / (double)std::max(1, C.max_iters));
        auto nn = compute_nearest_neighbor_data(ids, pos, C.k_nearest);
        double scale_len = std::max(target_length, 1e-6);

        for (const auto& v : movable) {
            auto pv = pos.find(v);
            if (pv == pos.end()) continue;
            double fx = 0, fy = 0;
            auto nit = adjacency.find(v);
            if (nit != adjacency.end()) {
                for (const auto& u : nit->second) {
                    auto pu = pos.find(u);
                    if (pu == pos.end()) continue;
                    double rdx = pv->second[0] - pu->second[0];
                    double rdy = pv->second[1] - pu->second[1];
                    double rlen = std::sqrt(rdx * rdx + rdy * rdy);
                    if (rlen < 1e-12) continue;
                    double coeff_s = 2 * (rlen - target_length) / (rlen + C.repulsion_eps);
                    fx += -C.beta * coeff_s * rdx;
                    fy += -C.beta * coeff_s * rdy;
                }
            }
            for (const auto& o : ids) {
                if (o == v) continue;
                auto po = pos.find(o);
                if (po == pos.end()) continue;
                double dx = pv->second[0] - po->second[0];
                double dy = pv->second[1] - po->second[1];
                double dxn = dx / scale_len;
                double dyn = dy / scale_len;
                double d2 = dxn * dxn + dyn * dyn;
                if (d2 < 1e-18) continue;
                // Python uses `(d2+eps)**(repPower/2+1)`. With repPower=2 this
                // is `(d2+eps)**2` which Python optimizes to x*x; std::pow may
                // use a different code path. Match Python's x*x exactly here.
                double base = d2 + C.repulsion_eps;
                double denom = (C.repulsion_power == 2)
                    ? base * base
                    : std::pow(base, C.repulsion_power / 2 + 1);
                double coeff_r = C.repulsion_power / denom;
                fx += alpha * coeff_r * dxn;
                fy += alpha * coeff_r * dyn;
            }

            if (C.eta > 0 && nn.mean_dist > 1e-9) {
                auto nnit = nn.nn_by_id.find(v);
                if (nnit != nn.nn_by_id.end() && nnit->second.second > 1e-12) {
                    auto pnp = pos.find(nnit->second.first);
                    if (pnp != pos.end()) {
                        double vx = pv->second[0] - pnp->second[0];
                        double vy = pv->second[1] - pnp->second[1];
                        double inv = 1 / nnit->second.second;
                        double ux = vx * inv, uy = vy * inv;
                        double delta = nn.mean_dist - nnit->second.second;
                        double cap = 0.8 * nn.mean_dist;
                        delta = std::max(-cap, std::min(cap, delta));
                        fx += (C.eta * uniformity_boost) * delta * ux;
                        fy += (C.eta * uniformity_boost) * delta * uy;
                    }
                }
            }
            if (C.zeta > 0 && nn.mean_k_dist > 1e-9) {
                auto kit = nn.knearest_by_id.find(v);
                if (kit != nn.knearest_by_id.end()) {
                    for (const auto& kn : kit->second) {
                        auto pk = pos.find(kn.first);
                        if (pk == pos.end() || !(kn.second > 1e-12)) continue;
                        double kvx = pv->second[0] - pk->second[0];
                        double kvy = pv->second[1] - pk->second[1];
                        double kinv = 1 / kn.second;
                        double kux = kvx * kinv, kuy = kvy * kinv;
                        double kdelta = nn.mean_k_dist - kn.second;
                        double kcap = 0.7 * nn.mean_k_dist;
                        kdelta = std::max(-kcap, std::min(kcap, kdelta));
                        fx += (C.zeta * uniformity_boost) * kdelta * kux;
                        fy += (C.zeta * uniformity_boost) * kdelta * kuy;
                    }
                }
            }
            if (C.collision_boost > 0 && nn.mean_dist > 1e-9) {
                auto kit = nn.knearest_by_id.find(v);
                if (kit != nn.knearest_by_id.end()) {
                    double threshold = 0.75 * nn.mean_dist;
                    for (const auto& nbr : kit->second) {
                        if (!(nbr.second > 1e-12) || nbr.second >= threshold) continue;
                        auto pnb = pos.find(nbr.first);
                        if (pnb == pos.end()) continue;
                        double bdx = pv->second[0] - pnb->second[0];
                        double bdy = pv->second[1] - pnb->second[1];
                        double binv = 1 / nbr.second;
                        double bux = bdx * binv, buy = bdy * binv;
                        double strength = (C.collision_boost * uniformity_boost)
                            * ((threshold - nbr.second) / std::max(threshold, 1e-9));
                        fx += strength * bux;
                        fy += strength * buy;
                    }
                }
            }

            double f_norm = std::sqrt(fx * fx + fy * fy);
            if (f_norm > C.max_force) {
                double s = C.max_force / f_norm;
                fx *= s; fy *= s;
            }
            Point candidate = {pv->second[0] + h * fx, pv->second[1] + h * fy};
            if (would_introduce_crossing(v, candidate, pos, pairs, adjacency, C.epsilon)) {
                ++rejected;
                continue;
            }
            pos[v] = candidate;
            ++accepted;
        }
        accepted_total += accepted;
        rejected_total += rejected;

        auto mv = gh::compute_position_move_stats(movable, prev, pos);
        auto ts = tracker.update(mv, it);
        if ((int)movable.size() > 0 && rejected > (int)movable.size() * 0.5) h *= C.step_decay;
        if (ts.converged) {
            stop_reason = ts.reason.empty() ? "movement-converged" : ts.reason;
            break;
        }
        if (it % C.alpha_grow_every == 0 && alpha < C.alpha_cap) {
            alpha = std::min(C.alpha_cap, alpha * C.alpha_grow_factor);
        }
        if (it % C.eval_every == 0 || it == 1 || it == C.max_iters) {
            double q = evaluate_spacing_quality(g, pairs, pos);
            if (std::isfinite(q) && q > best_score) {
                best_score = q;
                best_pos = pos;
                have_best = true;
            }
        }
    }

    pg::PosByStr& final_pos = have_best ? best_pos : pos;
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = final_pos.find(g.node_names[i]);
        if (it != final_pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            r.positions.put(i, it->second[0], it->second[1]);
        }
    }
    r.ok = true;
    r.iters = performed_iters;
    r.stop_reason = stop_reason;
    r.message = "ForceDir layout";
    return r;
}

} // namespace planarvibe::layouts
