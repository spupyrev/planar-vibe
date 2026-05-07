// Axis-alignment greedy sweep. Literal port of static/js/alignment.js.

#include "alignment.hpp"
#include "geometry.hpp"
#include "metrics.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace planarvibe::alignment {

namespace {

double compute_axis_tolerance(std::vector<double> values) {
    if (values.size() < 2) return 0;
    std::sort(values.begin(), values.end());
    double range = values.back() - values.front();
    if (!(range > 0)) return 0;
    auto gaps = geo::collect_positive_gaps(values, range);
    double quantile = geo::compute_quantile(gaps, 0.2);
    double scale = 2.0;
    double min_tol = std::max(1e-12, range * 1e-9);
    double cap_frac = 0.05;
    double fallback_frac = 0.01;
    if (gaps.size() >= 3 && std::isfinite(quantile)) {
        return std::min(range * cap_frac, std::max(min_tol, scale * quantile));
    }
    return range * fallback_frac;
}

struct Entry { std::string id; double coord; };

struct Group {
    std::vector<std::string> ids;
    double coord, min_coord, max_coord, total_coord;
};

std::vector<Group> build_axis_groups(
    const std::vector<std::string>& node_ids,
    const std::unordered_map<std::string, Point>& pos,
    int axis, double tolerance) {
    std::vector<Entry> entries;
    entries.reserve(node_ids.size());
    for (const auto& id : node_ids) {
        auto it = pos.find(id);
        if (it == pos.end()) continue;
        entries.push_back({id, it->second[axis]});
    }
    std::stable_sort(entries.begin(), entries.end(),
                     [](const Entry& a, const Entry& b) { return a.coord < b.coord; });
    std::vector<Group> groups;
    if (entries.empty()) return groups;
    double eps = std::isfinite(tolerance) ? std::max(0.0, tolerance) : 0.0;
    Group cur{{entries[0].id}, entries[0].coord, entries[0].coord, entries[0].coord, entries[0].coord};
    for (size_t i = 1; i < entries.size(); ++i) {
        if (entries[i].coord - entries[i-1].coord <= eps) {
            cur.ids.push_back(entries[i].id);
            cur.max_coord = entries[i].coord;
            cur.total_coord += entries[i].coord;
            cur.coord = cur.total_coord / cur.ids.size();
        } else {
            groups.push_back(cur);
            cur = {{entries[i].id}, entries[i].coord, entries[i].coord, entries[i].coord, entries[i].coord};
        }
    }
    groups.push_back(cur);
    return groups;
}

struct CrossingContext {
    std::vector<std::pair<std::string,std::string>> edges;
    std::unordered_map<std::string, std::vector<int>> incident;
};

CrossingContext build_crossing_context(const std::vector<std::pair<std::string,std::string>>& edge_pairs) {
    CrossingContext c;
    c.edges = edge_pairs;
    for (int i = 0; i < (int)edge_pairs.size(); ++i) {
        c.incident[edge_pairs[i].first].push_back(i);
        c.incident[edge_pairs[i].second].push_back(i);
    }
    return c;
}

bool boxes_overlap(Point a, Point b, Point c, Point d, double eps) {
    return std::min(a[0], b[0]) - eps <= std::max(c[0], d[0])
        && std::min(c[0], d[0]) - eps <= std::max(a[0], b[0])
        && std::min(a[1], b[1]) - eps <= std::max(c[1], d[1])
        && std::min(c[1], d[1]) - eps <= std::max(a[1], b[1]);
}

bool edges_share_endpoint(const std::pair<std::string,std::string>& a,
                           const std::pair<std::string,std::string>& b) {
    return a.first == b.first || a.first == b.second
        || a.second == b.first || a.second == b.second;
}

bool has_local_crossings(const CrossingContext& ctx,
                         const std::vector<std::string>& node_ids,
                         const std::unordered_map<std::string, Point>& pos,
                         const std::vector<std::string>& affected_ids) {
    constexpr double EPS = 1e-9;
    std::unordered_set<std::string> affected_set;
    std::vector<int> affected_edges;
    std::unordered_set<int> seen;
    for (const auto& id : affected_ids) {
        affected_set.insert(id);
        auto it = ctx.incident.find(id);
        if (it == ctx.incident.end()) continue;
        for (int ei : it->second) {
            if (seen.insert(ei).second) affected_edges.push_back(ei);
        }
    }

    for (int ei : affected_edges) {
        const auto& ae = ctx.edges[ei];
        auto au = pos.find(ae.first); auto av = pos.find(ae.second);
        if (au == pos.end() || av == pos.end()) continue;
        for (size_t j = 0; j < ctx.edges.size(); ++j) {
            if ((int)j == ei) continue;
            const auto& oe = ctx.edges[j];
            if (edges_share_endpoint(ae, oe)) continue;
            auto ou = pos.find(oe.first); auto ov = pos.find(oe.second);
            if (ou == pos.end() || ov == pos.end()) continue;
            if (!boxes_overlap(au->second, av->second, ou->second, ov->second, EPS)) continue;
            if (geo::segments_intersect_or_touch(au->second, av->second, ou->second, ov->second, EPS)) return true;
        }
    }

    for (const auto& id : affected_ids) {
        auto ap = pos.find(id);
        if (ap == pos.end()) continue;
        if (!std::isfinite(ap->second[0]) || !std::isfinite(ap->second[1])) continue;
        for (size_t j = 0; j < ctx.edges.size(); ++j) {
            const auto& e = ctx.edges[j];
            if (id == e.first || id == e.second) continue;
            auto eu = pos.find(e.first); auto ev = pos.find(e.second);
            if (eu == pos.end() || ev == pos.end()) continue;
            if (geo::point_on_segment_interior(eu->second, ev->second, ap->second, EPS)) return true;
        }
    }

    for (const auto& id : node_ids) {
        if (affected_set.count(id)) continue;
        auto np = pos.find(id);
        if (np == pos.end()) continue;
        if (!std::isfinite(np->second[0]) || !std::isfinite(np->second[1])) continue;
        for (int ei : affected_edges) {
            const auto& e = ctx.edges[ei];
            if (id == e.first || id == e.second) continue;
            auto eu = pos.find(e.first); auto ev = pos.find(e.second);
            if (eu == pos.end() || ev == pos.end()) continue;
            if (geo::point_on_segment_interior(eu->second, ev->second, np->second, EPS)) return true;
        }
    }
    return false;
}

struct SweepResult { int merged_count = 0; int group_count = 0; double tolerance = 0; };

SweepResult greedy_axis_sweep(const std::vector<std::string>& node_ids,
                              std::unordered_map<std::string, Point>& pos,
                              const CrossingContext& ctx, int axis,
                              double group_tol, double merge_tol) {
    auto groups = build_axis_groups(node_ids, pos, axis, group_tol);
    int merged_count = 0;
    size_t i = 0;
    while (i + 1 < groups.size()) {
        double gap = groups[i+1].min_coord - groups[i].max_coord;
        if (!(gap <= merge_tol)) { ++i; continue; }
        auto& left = groups[i];
        auto& right = groups[i+1];
        double merged_coord = (left.coord * left.ids.size() + right.coord * right.ids.size())
                              / (left.ids.size() + right.ids.size());
        std::vector<std::string> affected = left.ids;
        affected.insert(affected.end(), right.ids.begin(), right.ids.end());
        std::unordered_map<std::string, double> old;
        for (const auto& id : affected) {
            old[id] = pos[id][axis];
            pos[id][axis] = merged_coord;
        }
        if (has_local_crossings(ctx, node_ids, pos, affected)) {
            for (const auto& id : affected) pos[id][axis] = old[id];
            ++i;
            continue;
        }
        Group merged{affected, merged_coord, merged_coord, merged_coord, merged_coord * (double)affected.size()};
        groups.erase(groups.begin() + i, groups.begin() + i + 2);
        groups.insert(groups.begin() + i, merged);
        ++merged_count;
    }
    SweepResult r;
    r.merged_count = merged_count;
    r.group_count = (int)groups.size();
    r.tolerance = merge_tol;
    return r;
}

double axis_alignment_score(const std::vector<std::string>& node_ids,
                            const std::unordered_map<std::string, Point>& pos) {
    // Use metrics::compute_axis_alignment_score. It takes PositionMap indexed
    // by int. Build a temporary mapping.
    std::unordered_map<std::string,int> idx;
    for (size_t i = 0; i < node_ids.size(); ++i) idx[node_ids[i]] = (int)i;
    PositionMap pm;
    pm.resize((int)node_ids.size());
    for (const auto& [id, p] : pos) {
        auto it = idx.find(id);
        if (it == idx.end()) continue;
        pm.put(it->second, p[0], p[1]);
    }
    auto r = metrics::compute_axis_alignment_score((int)node_ids.size(), pm);
    if (!r.ok || !r.score) return std::numeric_limits<double>::quiet_NaN();
    return *r.score;
}

} // namespace

AlignResult align_to_axis_greedy(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const std::unordered_map<std::string, Point>& pos) {
    AlignResult R;
    if (node_ids.size() < 2) { R.reason = "Not enough nodes"; return R; }
    for (const auto& id : node_ids) {
        auto it = pos.find(id);
        if (it == pos.end()) { R.reason = "Not enough positioned nodes"; return R; }
        if (!std::isfinite(it->second[0]) || !std::isfinite(it->second[1])) {
            R.reason = "Not enough positioned nodes"; return R;
        }
    }
    // Check no-crossings.
    std::unordered_map<std::string,int> idx;
    for (size_t i = 0; i < node_ids.size(); ++i) idx[node_ids[i]] = (int)i;
    PositionMap pm;
    pm.resize((int)node_ids.size());
    for (const auto& [id, p] : pos) {
        auto it = idx.find(id);
        if (it == idx.end()) continue;
        pm.put(it->second, p[0], p[1]);
    }
    std::vector<std::pair<int,int>> iedges;
    for (const auto& [u, v] : edge_pairs) {
        auto iu = idx.find(u), iv = idx.find(v);
        if (iu == idx.end() || iv == idx.end()) continue;
        iedges.emplace_back(iu->second, iv->second);
    }
    if (geo::has_position_crossings(pm, iedges)) { R.reason = "Drawing is not plane"; return R; }

    auto ctx = build_crossing_context(edge_pairs);
    auto working = pos;
    double score_eps = 1e-12;
    double score_before = axis_alignment_score(node_ids, working);
    double current_score = score_before;

    std::vector<double> xs, ys;
    xs.reserve(node_ids.size()); ys.reserve(node_ids.size());
    for (const auto& id : node_ids) {
        auto it = working.find(id);
        xs.push_back(it->second[0]);
        ys.push_back(it->second[1]);
    }

    double x_base = compute_axis_tolerance(xs);
    double y_base = compute_axis_tolerance(ys);
    double merge_scale = 1.5;
    double x_merge = x_base * merge_scale;
    double y_merge = y_base * merge_scale;

    auto x_trial = working;
    auto x_res = greedy_axis_sweep(node_ids, x_trial, ctx, 0, x_base, x_merge);
    double x_score = axis_alignment_score(node_ids, x_trial);
    bool x_taken = false;
    if (std::isnan(current_score) || std::isnan(x_score) || x_score + score_eps >= current_score) {
        working = x_trial;
        current_score = x_score;
        x_taken = true;
    }

    auto y_trial = working;
    auto y_res = greedy_axis_sweep(node_ids, y_trial, ctx, 1, y_base, y_merge);
    bool y_taken = false;
    double y_score = axis_alignment_score(node_ids, y_trial);
    if (std::isnan(current_score) || std::isnan(y_score) || y_score + score_eps >= current_score) {
        working = y_trial;
        current_score = y_score;
        y_taken = true;
    }

    R.ok = true;
    R.positions = std::move(working);
    R.merged_count_x = x_taken ? x_res.merged_count : 0;
    R.merged_count_y = y_taken ? y_res.merged_count : 0;
    R.changed = (R.merged_count_x + R.merged_count_y) > 0;
    return R;
}

} // namespace planarvibe::alignment
