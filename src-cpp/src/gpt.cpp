// GPT ensemble — port of src-python/planarvibe/layouts/gpt.py (from JS).

#include "layouts/gpt.hpp"

#include "geometry.hpp"
#include "layouts/air.hpp"
#include "layouts/edgebalancer.hpp"
#include "layouts/ensemble_helpers.hpp"
#include "layouts/fabalancer.hpp"
#include "layouts/p3t.hpp"
#include "layouts/tutte.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct Options {
    double budgetMs = 5000;
    int edgeBalancerMaxNodes = 220;
    int fabalancerMaxNodes = 120;
    int airMaxNodes = 96;
    double airMinEdgeRatio = 0.01;
    int treeMaxNodes = 220;
    int radialTreeMaxNodes = 220;
    int unicyclicMaxNodes = 220;
    int gridMaxNodes = 240;
    int p3tMaxNodes = 220;
    int outerplanarMaxNodes = 180;
    int coreTreeMaxNodes = 110;
    int coreTreeMaxCoreNodes = 70;
    int leafSpreadMaxNodes = 120;
    int leafSpreadMinLeaves = 4;
    double leafSpreadMaxEdgeSurplusRatio = 0.65;
    double leafSpreadMaxEdgeRatioDrop = 0.16;
    int polishMaxNodes = 96;
    double polishMaxScore = 0.90;
    int polishMaxEvaluations = 450;
    int polishLargeNodeThreshold = 50;
    int polishLargeMaxEvaluations = 320;
    double polishMinRemainingMs = 900;
    int rotationSamples = 96;
    int affineMaxNodes = 160;
    std::vector<double> affineStretchFactors = {1, 1.04, 1.1, 1.2};
};

std::vector<double> normalize_stretch_factors(const std::vector<double>& source, int node_count, int affine_max_nodes) {
    if (node_count > affine_max_nodes) return {1.0};
    std::vector<double> out;
    std::unordered_map<std::string, bool> seen;
    for (double v : source) {
        if (!std::isfinite(v) || !(v > 0)) continue;
        double factor = std::max(1.0, v);
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.6f", factor);
        std::string key = buf;
        if (seen.count(key)) continue;
        seen[key] = true;
        out.push_back(factor);
    }
    return out.empty() ? std::vector<double>{1.0} : out;
}

bool should_try_leaf_spread(int n, int num_edges,
                             const std::vector<std::string>& node_ids,
                             const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                             const Options& opts) {
    if (n > opts.leafSpreadMaxNodes || num_edges <= n) return false;
    if (num_edges - n > std::max(6, (int)(n * opts.leafSpreadMaxEdgeSurplusRatio))) return false;
    auto info = ensemble::build_graph_info(node_ids, edge_pairs);
    if (!ensemble::is_connected(node_ids, info)) return false;
    int leaves = 0;
    for (const auto& nid : node_ids) if (info.degree.at(nid) == 1) leaves += 1;
    return leaves >= opts.leafSpreadMinLeaves;
}

bool is_leaf_spread_source(const std::string& name) {
    return name == "edgebalancer" || name == "fabalancer" || name == "air";
}

// Run a candidate layout and return positions by string id.
pg::PosByStr run_candidate(const std::string& name, const Graph& g,
                           const std::vector<std::string>& node_ids,
                           const std::vector<std::pair<std::string,std::string>>& edge_pairs,
                           bool& ok, const ensemble::TwoCoreInfo& core_info_cache) {
    ok = false;
    pg::PosByStr out;
    auto lr_to_pos = [&](const LayoutResult& lr) -> pg::PosByStr {
        pg::PosByStr p;
        if (!lr.ok) return p;
        for (int i = 0; i < g.n; ++i) {
            if (lr.positions.has(i)) p[g.node_names[i]] = lr.positions.pos[i];
        }
        return p;
    };
    if (name == "tutte") { auto lr = tutte(g); ok = lr.ok; return lr_to_pos(lr); }
    if (name == "edgebalancer") { auto lr = edgebalancer(g); ok = lr.ok; return lr_to_pos(lr); }
    if (name == "fabalancer") { auto lr = fabalancer(g); ok = lr.ok; return lr_to_pos(lr); }
    if (name == "air") { auto lr = air(g); ok = lr.ok; return lr_to_pos(lr); }
    if (name == "p3t") { auto lr = p3t(g); ok = lr.ok; return lr_to_pos(lr); }
    if (name == "tree") {
        auto r = ensemble::compute_tree_positions(node_ids, edge_pairs);
        ok = r.ok; return r.positions;
    }
    if (name == "radialtree") {
        auto r = ensemble::compute_radial_tree_positions(node_ids, edge_pairs);
        ok = r.ok; return r.positions;
    }
    if (name == "unicyclic") {
        auto r = ensemble::compute_unicyclic_positions(node_ids, edge_pairs);
        ok = r.ok; return r.positions;
    }
    if (name == "grid") {
        auto r = ensemble::compute_rectangular_grid_positions(node_ids, edge_pairs);
        ok = r.ok; return r.positions;
    }
    if (name == "outercircle") {
        auto r = ensemble::compute_outerplanar_circle_positions(node_ids, edge_pairs);
        ok = r.ok; return r.positions;
    }
    if (name == "coretree") {
        // Call edgebalancer on the core.
        if (!core_info_cache.ok) { ok = false; return {}; }
        Graph core_g;
        for (const auto& nid : core_info_cache.core_node_ids) core_g.add_node(nid);
        for (const auto& [u, v] : core_info_cache.core_edge_pairs) {
            core_g.add_edge(core_g.name_to_id[u], core_g.name_to_id[v]);
        }
        auto lr = edgebalancer(core_g);
        if (!lr.ok) { ok = false; return {}; }
        pg::PosByStr core_pos;
        for (int i = 0; i < core_g.n; ++i) {
            if (lr.positions.has(i)) core_pos[core_g.node_names[i]] = lr.positions.pos[i];
        }
        auto r = ensemble::compute_core_tree_positions_with_core(node_ids, edge_pairs, core_info_cache, core_pos);
        ok = r.ok; return r.positions;
    }
    return {};
}

std::vector<std::string> build_candidate_specs(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const Options& opts, const ensemble::TwoCoreInfo& core_info_cache) {
    int n = (int)node_ids.size();
    std::vector<std::string> specs{"tutte"};
    if (n <= opts.treeMaxNodes && ensemble::is_tree_graph(node_ids, edge_pairs)) specs.push_back("tree");
    if (n <= opts.radialTreeMaxNodes && ensemble::is_tree_graph(node_ids, edge_pairs)) specs.push_back("radialtree");
    if (n <= opts.unicyclicMaxNodes && ensemble::is_unicyclic_graph(node_ids, edge_pairs)) specs.push_back("unicyclic");
    if (n <= opts.gridMaxNodes && ensemble::has_rectangular_grid_signature(node_ids, edge_pairs)) specs.push_back("grid");
    if (n <= opts.outerplanarMaxNodes && ensemble::is_outerplanar_graph(node_ids, edge_pairs)) specs.push_back("outercircle");
    if (n <= opts.coreTreeMaxNodes && core_info_cache.ok) specs.push_back("coretree");
    if (n <= opts.p3tMaxNodes && ensemble::is_planar_3_tree(node_ids, edge_pairs)) specs.push_back("p3t");
    if (n <= opts.edgeBalancerMaxNodes) specs.push_back("edgebalancer");
    if (n <= opts.fabalancerMaxNodes) specs.push_back("fabalancer");
    if (n <= opts.airMaxNodes) specs.push_back("air");
    return specs;
}

} // anon

LayoutResult gpt(const Graph& g, const pg::PosByStr* /*initial_positions*/) {
    LayoutResult r;
    Options opts;

    std::vector<std::string> node_ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> edge_pairs;
    for (const auto& [u, v] : g.edges) edge_pairs.emplace_back(g.node_names[u], g.node_names[v]);

    ensemble::TwoCoreInfo core_info = ensemble::compute_two_core_info(
        node_ids, edge_pairs, opts.coreTreeMaxNodes, opts.coreTreeMaxCoreNodes);
    auto specs = build_candidate_specs(node_ids, edge_pairs, opts, core_info);

    double started_at = ensemble::now_ms();
    double deadline_ms = (std::isfinite(opts.budgetMs)) ? started_at + opts.budgetMs : 0;
    ensemble::GraphRef gr(g);

    struct Best {
        bool ok = false;
        double score = -std::numeric_limits<double>::infinity();
        std::unordered_map<std::string, double> metrics;
        pg::PosByStr positions;
        std::string name;
        double rotation = 0;
        double stretch = 1;
    } best;

    struct LeafSeed {
        std::string name;
        double score = 0;
        std::unordered_map<std::string, double> metrics;
        pg::PosByStr positions;
        bool has = false;
    } leaf_seed;
    bool leaf_eligible = should_try_leaf_spread((int)node_ids.size(), (int)edge_pairs.size(), node_ids, edge_pairs, opts);

    auto stretch_factors = normalize_stretch_factors(opts.affineStretchFactors, (int)node_ids.size(), opts.affineMaxNodes);

    for (const auto& name : specs) {
        if (best.ok && std::isfinite(opts.budgetMs) && ensemble::now_ms() - started_at >= opts.budgetMs) break;
        bool cand_ok = false;
        pg::PosByStr cand_pos = run_candidate(name, g, node_ids, edge_pairs, cand_ok, core_info);
        if (!cand_ok || cand_pos.empty()) continue;
        auto ev = ensemble::best_transform_for_candidate(gr, node_ids, edge_pairs, cand_pos,
                                                         opts.rotationSamples, stretch_factors, deadline_ms);
        if (!ev.ok) continue;
        if (name == "air" && std::isfinite(opts.airMinEdgeRatio)) {
            auto it = ev.metrics.find("edgeRatio");
            if (it != ev.metrics.end() && it->second < opts.airMinEdgeRatio) continue;
        }
        if (!best.ok || ev.score > best.score) {
            best.ok = true;
            best.score = ev.score;
            best.metrics = ev.metrics;
            best.positions = ev.positions;
            best.name = name;
            best.rotation = ev.rotation;
            best.stretch = ev.stretch;
        }
        if (leaf_eligible && is_leaf_spread_source(name) && (!leaf_seed.has || ev.score > leaf_seed.score)) {
            leaf_seed.has = true;
            leaf_seed.name = name;
            leaf_seed.score = ev.score;
            leaf_seed.metrics = ev.metrics;
            leaf_seed.positions = cand_pos;
        }
    }

    if (leaf_seed.has && (deadline_ms == 0 || ensemble::now_ms() < deadline_ms)) {
        ensemble::LeafSpreadOptions lso;
        lso.min_leaves = opts.leafSpreadMinLeaves;
        auto lsr = ensemble::compute_leaf_spread_positions(node_ids, edge_pairs, leaf_seed.positions, lso);
        if (lsr.ok) {
            auto ev = ensemble::best_transform_for_candidate(gr, node_ids, edge_pairs, lsr.positions,
                                                             opts.rotationSamples, stretch_factors, deadline_ms);
            if (ev.ok) {
                double max_drop = opts.leafSpreadMaxEdgeRatioDrop;
                double seed_ratio = 0, spread_ratio = 0;
                auto it1 = leaf_seed.metrics.find("edgeRatio");
                auto it2 = ev.metrics.find("edgeRatio");
                bool drops_too_much = std::isfinite(max_drop)
                    && it1 != leaf_seed.metrics.end() && std::isfinite(it1->second)
                    && it2 != ev.metrics.end() && std::isfinite(it2->second)
                    && it2->second < it1->second - max_drop;
                (void)seed_ratio; (void)spread_ratio;
                if (!drops_too_much) {
                    if (!best.ok || ev.score > best.score) {
                        best.ok = true;
                        best.score = ev.score;
                        best.metrics = ev.metrics;
                        best.positions = ev.positions;
                        best.name = "leafspread-" + leaf_seed.name;
                        best.rotation = ev.rotation;
                        best.stretch = ev.stretch;
                    }
                }
            }
        }
    }

    if (best.ok && (int)node_ids.size() <= opts.polishMaxNodes
        && best.score <= opts.polishMaxScore
        && (deadline_ms == 0 || ensemble::now_ms() + opts.polishMinRemainingMs < deadline_ms)) {
        int max_eval = opts.polishMaxEvaluations;
        if ((int)node_ids.size() > opts.polishLargeNodeThreshold) {
            max_eval = std::min(max_eval, opts.polishLargeMaxEvaluations);
        }
        auto polished = ensemble::compute_polished_positions_gpt(
            gr, node_ids, edge_pairs, best.positions, best.score, max_eval, deadline_ms);
        if (polished.ok && polished.score > best.score) {
            best.score = polished.score;
            best.positions = polished.positions;
            best.name = "polish-" + best.name;
        }
    }

    if (!best.ok) { r.ok = false; r.message = "GPT failed (no valid candidates)"; return r; }

    // Normalize to viewport and return.
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = best.positions.find(g.node_names[i]);
        if (it != best.positions.end()) pm.put(i, it->second[0], it->second[1]);
    }
    auto normalized = geo::normalize_position_map_to_viewport(pm);
    r.ok = true;
    r.message = "Applied GPT (" + best.name + ")";
    r.positions = normalized;
    return r;
}

} // namespace planarvibe::layouts
