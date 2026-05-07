// Claude ensemble — port of src-python/planarvibe/layouts/claude.py (from JS).

#include "layouts/claude.hpp"

#include "alignment.hpp"
#include "geometry.hpp"
#include "planar_graph.hpp"
#include "layouts/anglebalancer.hpp"
#include "layouts/areagrad.hpp"
#include "layouts/ceg.hpp"
#include "layouts/edgebalancer.hpp"
#include "layouts/ensemble_helpers.hpp"
#include "layouts/fabalancer.hpp"
#include "layouts/facebalancer.hpp"
#include "layouts/reweight.hpp"
#include "layouts/schnyder.hpp"
#include "layouts/tutte.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <string>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct CustomLimits {
    int treeMaxNodes = 220;
    int radialTreeMaxNodes = 220;
    int unicyclicMaxNodes = 220;
    int gridMaxNodes = 240;
    int outerplanarMaxNodes = 180;
    int coreTreeMaxNodes = 110;
    int coreTreeMaxCoreNodes = 70;
};

struct Variant {
    std::string label;
    pg::PosByStr positions;
    std::optional<planarity::StringEmbedding> embedding;
    std::unordered_map<std::string, double> scores;
};

struct RotAlignResult {
    std::string label_suffix;
    pg::PosByStr positions;
    std::unordered_map<std::string, double> scores;
};

pg::PosByStr rotate_positions(const pg::PosByStr& pos, double theta) {
    if (pos.empty()) return {};
    double cx = 0, cy = 0;
    for (const auto& kv : pos) {
        cx += kv.second[0];
        cy += kv.second[1];
    }
    cx /= pos.size();
    cy /= pos.size();
    double c = std::cos(theta);
    double s = std::sin(theta);
    pg::PosByStr out;
    for (const auto& kv : pos) {
        double dx = kv.second[0] - cx;
        double dy = kv.second[1] - cy;
        out[kv.first] = {cx + dx * c - dy * s, cy + dx * s + dy * c};
    }
    return out;
}

pg::PosByStr lr_to_pos(const Graph& g, const LayoutResult& lr) {
    pg::PosByStr p;
    if (!lr.ok) return p;
    for (int i = 0; i < g.n; ++i) {
        if (lr.positions.has(i)) p[g.node_names[i]] = lr.positions.pos[i];
    }
    return p;
}

std::optional<planarity::StringEmbedding> extract_embedding(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos) {
    auto e = pg::extract_embedding_from_positions(node_ids, edge_pairs, pos);
    if (!e) return std::nullopt;
    return *e;
}

struct CandResult {
    bool ok = false;
    pg::PosByStr positions;
    std::optional<planarity::StringEmbedding> embedding;
};

CandResult run_module_candidate(std::function<LayoutResult()> fn, const Graph& g,
                                 const std::vector<std::string>& node_ids,
                                 const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    CandResult R;
    auto lr = fn();
    R.positions = lr_to_pos(g, lr);
    if (!lr.ok || R.positions.empty()) return R;
    R.embedding = extract_embedding(node_ids, edge_pairs, R.positions);
    R.ok = R.embedding.has_value();
    return R;
}

CandResult run_internal_candidate(pg::PosByStr positions,
                                  const std::vector<std::string>& node_ids,
                                  const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    CandResult R;
    if (positions.empty()) return R;
    R.positions = positions;
    R.embedding = extract_embedding(node_ids, edge_pairs, positions);
    R.ok = R.embedding.has_value();
    return R;
}

std::optional<RotAlignResult> find_best_rotation_and_alignment(
    const ensemble::GraphRef& gr,
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const pg::PosByStr& pos,
    const std::optional<planarity::StringEmbedding>& embedding) {
    std::optional<RotAlignResult> best;
    for (int i = 0; i < 19; ++i) {
        double theta = (i / 18.0) * (M_PI / 2);
        pg::PosByStr rotated = (i == 0) ? pos : rotate_positions(pos, theta);
        auto rotated_scores = ensemble::compute_scores_claude(gr, node_ids, edge_pairs, rotated, embedding);
        if (!best || rotated_scores.at("total") > best->scores.at("total")) {
            best = RotAlignResult{"+rot", rotated, rotated_scores};
        }

        auto aligned = alignment::align_to_axis_greedy(node_ids, edge_pairs, rotated);
        if (aligned.ok) {
            auto aligned_scores = ensemble::compute_scores_claude(gr, node_ids, edge_pairs, aligned.positions, embedding);
            if (!best || aligned_scores.at("total") > best->scores.at("total")) {
                best = RotAlignResult{"+rot+align", aligned.positions, aligned_scores};
            }
        }
    }
    return best;
}

std::vector<Variant> expand_variants(const std::string& label,
                                     const pg::PosByStr& pos,
                                     const std::optional<planarity::StringEmbedding>& embedding,
                                     const ensemble::GraphRef& gr,
                                     const std::vector<std::string>& node_ids,
                                     const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                                     std::function<double()> time_left) {
    std::vector<Variant> out;
    Variant base{label + ":base", pos, embedding, ensemble::compute_scores_claude(gr, node_ids, edge_pairs, pos, embedding)};
    out.push_back(base);
    if (time_left && time_left() < 1000) return out;
    auto rot_align = find_best_rotation_and_alignment(gr, node_ids, edge_pairs, pos, embedding);
    if (rot_align) {
        out.push_back({label + ":" + rot_align->label_suffix.substr(1),
                       rot_align->positions,
                       embedding,
                       rot_align->scores});
    }
    return out;
}

Variant try_align(const Variant& best, const ensemble::GraphRef& gr,
                  const std::vector<std::string>& node_ids,
                  const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    auto a = alignment::align_to_axis_greedy(node_ids, edge_pairs, best.positions);
    if (!a.ok) return best;
    auto s = ensemble::compute_scores_claude(gr, node_ids, edge_pairs, a.positions, best.embedding);
    if (s.at("total") > best.scores.at("total")) {
        return {best.label + "+align", a.positions, best.embedding, s};
    }
    return best;
}

Variant try_rot_align(const Variant& best, const ensemble::GraphRef& gr,
                      const std::vector<std::string>& node_ids,
                      const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    auto r = find_best_rotation_and_alignment(gr, node_ids, edge_pairs, best.positions, best.embedding);
    if (r && r->scores.at("total") > best.scores.at("total")) {
        return {best.label + r->label_suffix, r->positions, best.embedding, r->scores};
    }
    return best;
}

Variant try_polish(const Variant& best, const ensemble::GraphRef& gr,
                   const std::vector<std::string>& node_ids,
                   const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                   ensemble::ClaudePolishOptions opts, const std::string& tag) {
    auto res = ensemble::polish_by_local_moves(gr, node_ids, edge_pairs, best.positions, best.embedding, opts);
    if (res.scores.at("total") > best.scores.at("total")) {
        return {best.label + tag, res.positions, best.embedding, res.scores};
    }
    return best;
}

} // anon

LayoutResult claude(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    CustomLimits limits;
    std::vector<std::string> node_ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> edge_pairs;
    for (const auto& [u, v] : g.edges) edge_pairs.emplace_back(g.node_names[u], g.node_names[v]);
    int n = (int)node_ids.size();

    ensemble::GraphRef gr(g);
    double start_ms = ensemble::now_ms();
    double global_budget_ms = 5000;
    auto time_left = [&]() { return global_budget_ms - (ensemble::now_ms() - start_ms); };

    // Build candidates (same order as Python).
    struct Runner { std::string label; std::function<CandResult()> fn; };
    std::vector<Runner> runners;

    if (n <= limits.treeMaxNodes && ensemble::is_tree_graph(node_ids, edge_pairs)) {
        runners.push_back({"Tree", [&]() { auto r = ensemble::compute_tree_positions(node_ids, edge_pairs); return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs); }});
    }
    if (n <= limits.radialTreeMaxNodes && ensemble::is_tree_graph(node_ids, edge_pairs)) {
        runners.push_back({"RadialTree", [&]() { auto r = ensemble::compute_radial_tree_positions(node_ids, edge_pairs); return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs); }});
    }
    if (n <= limits.unicyclicMaxNodes && ensemble::is_unicyclic_graph(node_ids, edge_pairs)) {
        runners.push_back({"Unicyclic", [&]() { auto r = ensemble::compute_unicyclic_positions(node_ids, edge_pairs); return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs); }});
    }
    if (n <= limits.gridMaxNodes && ensemble::has_rectangular_grid_signature(node_ids, edge_pairs)) {
        runners.push_back({"Grid", [&]() { auto r = ensemble::compute_rectangular_grid_positions(node_ids, edge_pairs); return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs); }});
    }
    if (n <= limits.outerplanarMaxNodes && ensemble::is_outerplanar_graph(node_ids, edge_pairs)) {
        runners.push_back({"OuterCircle", [&]() { auto r = ensemble::compute_outerplanar_circle_positions(node_ids, edge_pairs); return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs); }});
    }
    ensemble::TwoCoreInfo core_info;
    if (n <= limits.coreTreeMaxNodes) {
        core_info = ensemble::compute_two_core_info(node_ids, edge_pairs, limits.coreTreeMaxNodes, limits.coreTreeMaxCoreNodes);
        if (core_info.ok) {
            runners.push_back({"CoreTree", [&]() {
                Graph core_g;
                for (const auto& nid : core_info.core_node_ids) core_g.add_node(nid);
                for (const auto& [u, v] : core_info.core_edge_pairs) core_g.add_edge(core_g.name_to_id[u], core_g.name_to_id[v]);
                auto lr = edgebalancer(core_g);
                if (!lr.ok) return CandResult{};
                pg::PosByStr core_pos;
                for (int i = 0; i < core_g.n; ++i) if (lr.positions.has(i)) core_pos[core_g.node_names[i]] = lr.positions.pos[i];
                auto r = ensemble::compute_core_tree_positions_with_core(node_ids, edge_pairs, core_info, core_pos);
                return run_internal_candidate(r.ok ? r.positions : pg::PosByStr{}, node_ids, edge_pairs);
            }});
        }
    }
    runners.push_back({"EdgeBalancer", [&]() { return run_module_candidate([&]() { return edgebalancer(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"FABalancer", [&]() { return run_module_candidate([&]() { return fabalancer(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"AngleBalancer", [&]() { return run_module_candidate([&]() { return anglebalancer(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"AreaGrad", [&]() { return run_module_candidate([&]() { return areagrad(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"FaceBalancer", [&]() { return run_module_candidate([&]() { return facebalancer(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"Reweight", [&]() { return run_module_candidate([&]() { return reweight(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"Schnyder", [&]() { return run_module_candidate([&]() { return schnyder(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"CEGBfs", [&]() { return run_module_candidate([&]() { return ceg_bfs(g, initial_positions); }, g, node_ids, edge_pairs); }});
    runners.push_back({"Tutte", [&]() { return run_module_candidate([&]() { return tutte(g, initial_positions); }, g, node_ids, edge_pairs); }});

    std::vector<Variant> variants;
    for (size_t i = 0; i < runners.size(); ++i) {
        if (i > 0 && time_left() < 3000) break;
        auto out = runners[i].fn();
        if (out.ok) {
            auto vs = expand_variants(runners[i].label, out.positions, out.embedding, gr, node_ids, edge_pairs, time_left);
            for (auto& v : vs) variants.push_back(std::move(v));
        }
    }

    if (variants.empty()) { r.ok = false; r.message = "Claude failed (no valid candidates)"; return r; }
    std::sort(variants.begin(), variants.end(),
              [](const Variant& a, const Variant& b) { return a.scores.at("total") > b.scores.at("total"); });
    Variant best = variants[0];

    int polish_passes = n > 80 ? 2 : (n > 60 ? 3 : (n > 40 ? 4 : 5));
    double polish_step = n > 80 ? 0.03 : (n > 60 ? 0.04 : (n > 40 ? 0.05 : 0.06));

    if (n <= 150 && time_left() > 1500) {
        double total_budget = std::min<double>(n > 75 ? 7000 : (n > 50 ? 16000 : 22000), time_left() - 1500);
        int num_starts = n > 75 ? 1 : (n > 50 ? 2 : 3);
        int top_k = std::min((int)num_starts, (int)variants.size());
        double per_variant = std::max(1500.0, total_budget / top_k);
        for (int i = 0; i < top_k; ++i) {
            const auto& start_var = variants[i];
            ensemble::ClaudePolishOptions o;
            o.max_passes = polish_passes;
            o.step_scale = polish_step;
            o.min_step_scale = 0.005;
            o.start_time_ms = ensemble::now_ms();
            o.budget_ms = per_variant;
            auto polished = ensemble::polish_by_local_moves(gr, node_ids, edge_pairs, start_var.positions, start_var.embedding, o);
            if (polished.scores.at("total") > best.scores.at("total")) {
                best = {start_var.label + "+polish", polished.positions, start_var.embedding, polished.scores};
            }
        }

        best = try_rot_align(best, gr, node_ids, edge_pairs);

        if (n <= 75 && time_left() > 1000) {
            ensemble::ClaudePolishOptions o;
            o.max_passes = 4;
            o.step_scale = 0.015;
            o.min_step_scale = 0.001;
            o.start_time_ms = ensemble::now_ms();
            o.budget_ms = std::min<double>(n > 50 ? 3500 : 5000, time_left() - 1000);
            best = try_polish(best, gr, node_ids, edge_pairs, o, "+fine");

            if (time_left() > 800) {
                ensemble::ClaudePolishOptions o2;
                o2.max_passes = 3;
                o2.step_scale = 0.004;
                o2.min_step_scale = 0.0003;
                o2.start_time_ms = ensemble::now_ms();
                o2.budget_ms = std::min<double>(n > 50 ? 2000 : 3000, time_left() - 500);
                best = try_polish(best, gr, node_ids, edge_pairs, o2, "+micro");
                best = try_align(best, gr, node_ids, edge_pairs);
            }

            if (time_left() > 600) {
                auto repaired = ensemble::convexity_repair(gr, node_ids, edge_pairs, best.positions, best.embedding, 3,
                                                           ensemble::now_ms(), std::min<double>(n > 50 ? 2500 : 4000, time_left() - 500));
                if (repaired.scores.at("total") > best.scores.at("total")) {
                    best = {best.label + "+cvx", repaired.positions, best.embedding, repaired.scores};
                }
                if (time_left() > 400) {
                    ensemble::ClaudePolishOptions o3;
                    o3.max_passes = 2;
                    o3.step_scale = 0.008;
                    o3.min_step_scale = 0.0005;
                    o3.start_time_ms = ensemble::now_ms();
                    o3.budget_ms = std::min<double>(1500, time_left() - 300);
                    best = try_polish(best, gr, node_ids, edge_pairs, o3, "+cvxpol");
                }
            }

            if (n <= 50 && time_left() > 2000) {
                auto rng = ensemble::make_seeded_rng(node_ids, edge_pairs);
                double restart_budget = std::min<double>(4000, time_left() - 1500);
                int num_restarts = n > 30 ? 2 : 3;
                double per_restart = restart_budget / num_restarts;
                double perturb_scales[] = {0.015, 0.03, 0.06};
                for (int ri = 0; ri < num_restarts; ++ri) {
                    if (time_left() < 800) break;
                    auto res = ensemble::restart_perturb_and_polish(gr, node_ids, edge_pairs, best.positions, best.embedding,
                        rng, perturb_scales[ri % 3], 3, 0.012, ensemble::now_ms(), per_restart);
                    if (res.scores.at("total") > best.scores.at("total")) {
                        best = {best.label + "+restart" + std::to_string(ri), res.positions, best.embedding, res.scores};
                    }
                }
            }

            if (time_left() > 300) {
                ensemble::ClaudePolishOptions o4;
                o4.max_passes = 2;
                o4.step_scale = 0.003;
                o4.min_step_scale = 0.0002;
                o4.start_time_ms = ensemble::now_ms();
                o4.budget_ms = std::min<double>(1500, time_left() - 200);
                best = try_polish(best, gr, node_ids, edge_pairs, o4, "+settle");
            }
        }
    }

    if (n <= 70 && time_left() > 1500) {
        int outer_iters = n > 40 ? 2 : 3;
        for (int it = 0; it < outer_iters; ++it) {
            if (time_left() < 800) break;
            double before = best.scores.at("total");
            best = try_rot_align(best, gr, node_ids, edge_pairs);
            if (time_left() > 800) {
                ensemble::ClaudePolishOptions o;
                o.max_passes = 3;
                o.step_scale = 0.006;
                o.min_step_scale = 0.0003;
                o.start_time_ms = ensemble::now_ms();
                o.budget_ms = std::min<double>(1800, time_left() - 500);
                best = try_polish(best, gr, node_ids, edge_pairs, o, "+fineIter");
            }
            if (best.scores.at("total") <= before + 1e-6) break;
        }
    }

    // Normalize and return.
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = best.positions.find(g.node_names[i]);
        if (it != best.positions.end()) pm.put(i, it->second[0], it->second[1]);
    }
    auto normalized = geo::normalize_position_map_to_viewport(pm);
    r.ok = true;
    r.message = "Claude selected " + best.label;
    r.positions = normalized;
    return r;
}

} // namespace planarvibe::layouts
