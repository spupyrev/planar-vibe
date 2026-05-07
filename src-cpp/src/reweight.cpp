#include "layouts/reweight.hpp"
#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <unordered_set>

namespace planarvibe::layouts {

namespace {

struct RConfig {
    int max_outer_iters = 8;
    double pressure_step = 0.16;
    double pressure_clamp = 1.20;
    double pressure_beta = 0.18;
    double pressure_delta_clamp = 0.75;
    double scale_min = 0.25;
    double scale_max = 10.0;
    double pressure_scale_min = 1.0;
    double pressure_scale_max = 1.25;
    int min_iters_before_stop = 8;
    int stable_iter_limit = 4;
};

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

double poly_area_abs(const std::vector<std::string>& f, const pg::PosByStr& pos) {
    if (f.size() < 3) return 0.0;
    double total = 0.0;
    int n = (int)f.size();
    for (int i = 0; i < n; ++i) {
        auto ia = pos.find(f[i]);
        auto ib = pos.find(f[(i + 1) % n]);
        if (ia == pos.end() || ib == pos.end()) return 0.0;
        total += ia->second[0] * ib->second[1] - ib->second[0] * ia->second[1];
    }
    return std::abs(total) / 2.0;
}

} // namespace

LayoutResult reweight(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    RConfig C;
    preprocessing::PrepareConfig cfg;
    cfg.failure_label = "Reweight";
    cfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, cfg);
    if (!prep.ok) {
        r.ok = false;
        r.message = prep.message.empty() ? "Reweight failed" : prep.message;
        return r;
    }

    // Build adjacency.
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& nid : prep.augmented_node_ids) adjacency[nid] = {};
    for (const auto& [u, v] : prep.augmented_edge_pairs) {
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
    }

    // Initialize via Tutte-barycentric with standard weights to get starting positions.
    auto init_weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);
    auto init_br = compute_barycentric_positions(prep.augmented_node_ids, adjacency,
                                                  prep.augmented_outer_face, init_weights);
    if (!init_br.ok) {
        r.ok = false;
        r.message = init_br.message.empty() ? "Reweight initialization failed" : init_br.message;
        return r;
    }
    pg::PosByStr current_pos = init_br.positions;
    pg::PosByStr fixed_outer_pos;
    for (const auto& nid : prep.augmented_outer_face) {
        auto it = current_pos.find(nid);
        if (it != current_pos.end()) fixed_outer_pos[nid] = it->second;
    }

    // Face indexing.
    const auto& faces = prep.augmented_embedding.faces;
    int outer_idx = pg::find_outer_face_index(faces, prep.augmented_outer_face);
    std::vector<int> bounded_face_idx;
    for (int i = 0; i < (int)faces.size(); ++i) if (i != outer_idx) bounded_face_idx.push_back(i);
    if (bounded_face_idx.empty()) {
        r.ok = false;
        r.message = "No bounded faces";
        return r;
    }
    std::unordered_set<int> bounded_set(bounded_face_idx.begin(), bounded_face_idx.end());
    double desired = 1.0 / bounded_face_idx.size();

    // e2f: edge_key -> list of face indices
    std::unordered_map<std::string, std::vector<int>> e2f;
    for (int i = 0; i < (int)faces.size(); ++i) {
        const auto& f = faces[i];
        int n = (int)f.size();
        for (int j = 0; j < n; ++j) {
            std::string k = ekey(f[j], f[(j + 1) % n]);
            e2f[k].push_back(i);
        }
    }

    // Weights init to 1.0 per augmented edge.
    std::unordered_map<std::string, double> weights;
    for (const auto& [u, v] : prep.augmented_edge_pairs) weights[ekey(u, v)] = 1.0;

    std::vector<double> face_pressure(faces.size(), 0.0);

    // Movable vertices for convergence tracking.
    auto movable = gh::collect_movable_vertex_names(prep.augmented_node_ids, prep.augmented_outer_face);
    double movement_scale = geo::compute_drawing_diameter(
        (int)prep.augmented_node_ids.size(),
        [&]() {
            // Build a temporary PositionMap keyed by a local index.
            PositionMap pm;
            pm.resize((int)prep.augmented_node_ids.size());
            for (int i = 0; i < (int)prep.augmented_node_ids.size(); ++i) {
                auto it = current_pos.find(prep.augmented_node_ids[i]);
                if (it != current_pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
                    pm.put(i, it->second[0], it->second[1]);
                }
            }
            return pm;
        }());
    gh::MovementTrackerConfig tcfg;
    tcfg.min_iters_before_stop = C.min_iters_before_stop;
    tcfg.stable_iter_limit = C.stable_iter_limit;
    tcfg.max_move_tol = 1e-4 * movement_scale;
    tcfg.avg_move_tol = 2e-5 * movement_scale;
    gh::MovementTracker tracker(tcfg);

    std::unordered_set<std::string> outer_set(prep.augmented_outer_face.begin(), prep.augmented_outer_face.end());
    int total_inner_iters = init_br.iters;

    TutteOuterPlacement placement;
    placement.fixed_outer_pos = &fixed_outer_pos;

    for (int it = 0; it < C.max_outer_iters; ++it) {
        pg::PosByStr prev_pos = current_pos;
        auto inner = compute_barycentric_positions(prep.augmented_node_ids, adjacency,
                                                    prep.augmented_outer_face, weights, placement);
        if (!inner.ok) {
            r.ok = false;
            r.message = inner.message.empty() ? "Reweight inner solve failed" : inner.message;
            return r;
        }
        total_inner_iters += inner.iters;
        current_pos = inner.positions;

        auto mv = gh::compute_position_move_stats(movable, prev_pos, current_pos);
        auto ts = tracker.update(mv, it + 1);

        double outer_area = poly_area_abs(prep.augmented_outer_face, current_pos);
        if (!(outer_area > 1e-12)) outer_area = 1.0;
        std::vector<double> face_areas(faces.size(), 0.0);
        for (int i = 0; i < (int)faces.size(); ++i) {
            face_areas[i] = poly_area_abs(faces[i], current_pos) / outer_area;
        }

        // Update face pressure.
        {
            std::vector<double> nxt = face_pressure;
            double ssum = 0.0;
            int cnt = 0;
            for (int fi : bounded_face_idx) {
                double a = face_areas[fi];
                if (!std::isfinite(a) || !(a > 1e-12)) continue;
                double delta = std::log(std::max(desired, 1e-12) / std::max(a, 1e-12));
                delta = std::max(-C.pressure_delta_clamp, std::min(C.pressure_delta_clamp, delta));
                double p = nxt[fi] + C.pressure_step * delta;
                p = std::max(-C.pressure_clamp, std::min(C.pressure_clamp, p));
                nxt[fi] = p;
                ssum += p;
                ++cnt;
            }
            double mean = (cnt > 0) ? (ssum / cnt) : 0.0;
            if (cnt > 0 && std::abs(mean) > 1e-12) {
                for (int fi : bounded_face_idx) nxt[fi] -= mean;
            }
            face_pressure = std::move(nxt);
        }

        // Adjust weights.
        {
            std::unordered_map<std::string, double> new_weights;
            double sum_w = 0.0;
            int cnt = 0;
            for (const auto& [u, v] : prep.augmented_edge_pairs) {
                std::string k = ekey(u, v);
                auto wit = weights.find(k);
                double w_old = (wit != weights.end() && std::isfinite(wit->second) && wit->second > 0) ? wit->second : 1.0;
                if (outer_set.count(u) && outer_set.count(v)) {
                    new_weights[k] = w_old;
                    continue;
                }
                const auto& fs = e2f[k];
                double area_sum = 0.0;
                int area_cnt = 0;
                for (int fi : fs) {
                    double a = face_areas[fi];
                    if (std::isfinite(a) && a > 0) { area_sum += a; ++area_cnt; }
                }
                if (area_cnt == 0) {
                    new_weights[k] = w_old;
                    sum_w += w_old;
                    ++cnt;
                    continue;
                }
                double penalty = (area_sum / area_cnt) / std::max(desired, 1e-12);
                double scale = penalty > 1 ? std::sqrt(penalty) : penalty;
                scale = std::max(C.scale_min, std::min(C.scale_max, scale));
                double p_sum = 0.0;
                int p_cnt = 0;
                for (int fi : fs) {
                    if (!bounded_set.count(fi)) continue;
                    double p = face_pressure[fi];
                    if (std::isfinite(p)) { p_sum += p; ++p_cnt; }
                }
                if (p_cnt > 0 && C.pressure_beta > 0) {
                    double pressure_scale = std::exp(-C.pressure_beta * (p_sum / p_cnt));
                    pressure_scale = std::max(C.pressure_scale_min, std::min(C.pressure_scale_max, pressure_scale));
                    scale *= pressure_scale;
                }
                double w_new = w_old * scale;
                w_new = std::max(1e-4, std::min(1e4, w_new));
                new_weights[k] = w_new;
                sum_w += w_new;
                ++cnt;
            }
            double avg = (cnt > 0) ? (sum_w / cnt) : 1.0;
            if (!(avg > 0)) avg = 1.0;
            for (const auto& [u, v] : prep.augmented_edge_pairs) {
                std::string k = ekey(u, v);
                auto wit = new_weights.find(k);
                double val = (wit != new_weights.end()) ? wit->second : 1.0;
                new_weights[k] = val / avg;
            }
            weights = std::move(new_weights);
        }

        if (ts.converged) break;
    }

    // Final solve.
    auto final_br = compute_barycentric_positions(prep.augmented_node_ids, adjacency,
                                                   prep.augmented_outer_face, weights, placement);
    if (!final_br.ok) {
        r.ok = false;
        r.message = final_br.message.empty() ? "Reweight final solve failed" : final_br.message;
        return r;
    }
    total_inner_iters += final_br.iters;

    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = final_br.positions.find(g.node_names[i]);
        if (it != final_br.positions.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            r.positions.put(i, it->second[0], it->second[1]);
        }
    }
    if (geo::has_position_crossings(r.positions, g.edges)) {
        r.ok = false;
        r.message = "Reweight produced a non-plane drawing";
        return r;
    }
    r.ok = true;
    r.iters = total_inner_iters;
    r.message = "Reweight layout";
    return r;
}

} // namespace planarvibe::layouts
