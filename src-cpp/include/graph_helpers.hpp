#pragma once

// Shared layout-utility helpers used across iterative/balancer layouts.
// Literal port of static/js/graph-utils.js pieces needed by layouts.

#include "graph.hpp"

#include <cmath>
#include <functional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace planarvibe::gh {

struct MoveStats {
    int moved_vertices = 0;
    double total_move = 0.0;
    double avg_move = 0.0;
    double max_move = 0.0;
};

// distance_fn(aug_idx, i) -> double, positional tol = 1e-9 by default.
inline MoveStats compute_move_stats(
    const std::vector<int>& items,
    const std::function<double(int, int)>& distance_fn,
    double move_tol = 1e-9) {
    MoveStats s;
    for (size_t i = 0; i < items.size(); ++i) {
        double d = distance_fn(items[i], (int)i);
        if (!std::isfinite(d) || d < 0) continue;
        s.total_move += d;
        if (d > s.max_move) s.max_move = d;
        if (d > move_tol) s.moved_vertices++;
    }
    if (!items.empty()) s.avg_move = s.total_move / items.size();
    return s;
}

// Build name->pos distance for compute_position_move_stats.
inline MoveStats compute_position_move_stats(
    const std::vector<std::string>& ids,
    const std::unordered_map<std::string, Point>& prev,
    const std::unordered_map<std::string, Point>& curr,
    double move_tol = 1e-9) {
    MoveStats s;
    for (const auto& nid : ids) {
        auto ip = prev.find(nid), ic = curr.find(nid);
        if (ip == prev.end() || ic == curr.end()) continue;
        double dx = ic->second[0] - ip->second[0];
        double dy = ic->second[1] - ip->second[1];
        double d = std::hypot(dx, dy);
        if (!std::isfinite(d)) continue;
        s.total_move += d;
        if (d > s.max_move) s.max_move = d;
        if (d > move_tol) s.moved_vertices++;
    }
    if (!ids.empty()) s.avg_move = s.total_move / ids.size();
    return s;
}

// Movement-convergence tracker. Stops once max_move and avg_move stay below
// per-call tolerances for `stable_iter_limit` consecutive iterations (only
// after `min_iters_before_stop` iterations have been executed).
struct MovementTrackerConfig {
    int min_iters_before_stop = 20;
    int stable_iter_limit = 5;
    double max_move_tol = 1e-3;
    double avg_move_tol = 1e-3;
};

class MovementTracker {
public:
    explicit MovementTracker(MovementTrackerConfig cfg) : cfg_(cfg) {}
    struct Update {
        bool converged = false;
        std::string reason;
    };
    Update update(const MoveStats& s, int iter_idx) {
        bool below = s.max_move <= cfg_.max_move_tol && s.avg_move <= cfg_.avg_move_tol;
        if (below) stable_++;
        else stable_ = 0;
        Update u;
        if (iter_idx >= cfg_.min_iters_before_stop && stable_ >= cfg_.stable_iter_limit) {
            u.converged = true;
            u.reason = "movement-converged";
        }
        return u;
    }
private:
    MovementTrackerConfig cfg_;
    int stable_ = 0;
};

// Collect vertex ids (aug node_ids) that are NOT on the outer face.
inline std::vector<std::string> collect_movable_vertex_names(
    const std::vector<std::string>& node_ids,
    const std::vector<std::string>& outer_face) {
    std::unordered_set<std::string> outer(outer_face.begin(), outer_face.end());
    std::vector<std::string> out;
    out.reserve(node_ids.size());
    for (const auto& nid : node_ids) {
        if (!outer.count(nid)) out.push_back(nid);
    }
    return out;
}

} // namespace planarvibe::gh
