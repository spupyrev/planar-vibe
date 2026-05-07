// ImPrEd layout — literal port of static/js/layout-impred.js.

#include "layouts/impred.hpp"

#include "geometry.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct Config {
    int maxIters = 600;
    double maxMoveFactor = 3;
    double minMaxMoveFactor = 0.05;
    int sectorCount = 8;
    double forceScale = 0.04;
    double nodeRepulsion = 1.0;
    double edgeAttraction = 1.0;
    double nodeEdgeRepulsion = 0.75;
    double nearbyFactor = 6.0;
    double momentumBeta = 0.78;
    double rejectedVelocityDamp = 0.25;
    double rollbackVelocityDamp = 0.0;
    double fullRollbackVelocityDamp = 0.5;
    int minItersBeforeStop = 60;
    int stableIterLimit = 16;
    double movementStopTolFactor = 0.008;
    double avgMovementStopTolFactor = 0.0015;
};

double estimate_delta(const std::vector<std::pair<std::string,std::string>>& edges,
                      const pg::PosByStr& pos) {
    double sum = 0; int cnt = 0;
    for (const auto& [u, v] : edges) {
        auto pu = pos.find(u), pv = pos.find(v);
        if (pu == pos.end() || pv == pos.end()) continue;
        double dx = pu->second[0] - pv->second[0];
        double dy = pu->second[1] - pv->second[1];
        double d = std::sqrt(dx * dx + dy * dy);
        if (!(d > 1e-9)) continue;
        sum += d; cnt += 1;
    }
    return cnt == 0 ? 40.0 : sum / cnt;
}

struct Proj { bool ok = false; double x, y, t; };
Proj project_point_on_segment(double px, double py, double ax, double ay, double bx, double by) {
    Proj p;
    double vx = bx - ax, vy = by - ay;
    double ww = vx * vx + vy * vy;
    if (!(ww > 1e-12)) return p;
    double t = ((px - ax) * vx + (py - ay) * vy) / ww;
    if (t < 0 || t > 1) return p;
    p.ok = true; p.x = ax + t * vx; p.y = ay + t * vy; p.t = t;
    return p;
}

double ray_segment_distance(double px, double py, double dx, double dy,
                            double ax, double ay, double bx, double by) {
    double ex = bx - ax, ey = by - ay;
    double den = dx * ey - dy * ex;
    if (std::abs(den) < 1e-12) return std::numeric_limits<double>::infinity();
    double qpx = ax - px, qpy = ay - py;
    double t = (qpx * ey - qpy * ex) / den;
    double u = (qpx * dy - qpy * dx) / den;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return t;
    return std::numeric_limits<double>::infinity();
}

int sector_index(double dx, double dy, int sectorCount) {
    double a = std::atan2(dy, dx);
    if (a < 0) a += 2 * M_PI;
    int k = (int)std::floor((a / (2 * M_PI)) * sectorCount);
    if (k < 0) k = 0;
    if (k >= sectorCount) k = sectorCount - 1;
    return k;
}

bool move_would_cross(const std::string& v, Point oldP, Point newP,
                      const std::vector<std::string>& node_ids,
                      const std::vector<std::pair<std::string,std::string>>& edges,
                      const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
                      const pg::PosByStr& pos) {
    constexpr double EPS = 1e-9;
    for (const auto& [a, b] : edges) {
        if (a == v || b == v) continue;
        auto pa = pos.find(a), pb = pos.find(b);
        if (pa == pos.end() || pb == pos.end()) continue;
        if (geo::point_on_segment_interior(pa->second, pb->second, newP, EPS)) return true;
        if (geo::segments_intersect_or_touch(oldP, newP, pa->second, pb->second, EPS)) return true;
    }
    auto adj_it = adjacency.find(v);
    if (adj_it == adjacency.end()) return false;
    for (const auto& u : adj_it->second) {
        auto pu = pos.find(u);
        if (pu == pos.end()) continue;
        for (const auto& [a, b] : edges) {
            if (a == v || b == v || a == u || b == u) continue;
            auto pa = pos.find(a), pb = pos.find(b);
            if (pa == pos.end() || pb == pos.end()) continue;
            if (geo::segments_intersect_or_touch(newP, pu->second, pa->second, pb->second, EPS)) return true;
        }
        for (const auto& w : node_ids) {
            if (w == v || w == u) continue;
            auto pw = pos.find(w);
            if (pw == pos.end()) continue;
            if (geo::point_on_segment_interior(newP, pu->second, pw->second, EPS)) return true;
        }
    }
    return false;
}

struct ForceOpts {
    double delta;
    double cNodeRep, cEdgeAttr, cNodeEdgeRep;
    double nearbyFactor;
};

std::unordered_map<std::string, std::array<double,2>> compute_node_forces(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edges,
    const std::unordered_map<std::string, std::vector<std::string>>& adjacency,
    const pg::PosByStr& pos, const ForceOpts& o) {
    std::unordered_map<std::string, std::array<double,2>> forces;
    for (const auto& id : node_ids) forces[id] = {0, 0};

    for (size_t i = 0; i < node_ids.size(); ++i) {
        const auto& v = node_ids[i];
        auto pv = pos.find(v);
        if (pv == pos.end()) continue;
        for (size_t j = 0; j < node_ids.size(); ++j) {
            if (i == j) continue;
            auto pu = pos.find(node_ids[j]);
            if (pu == pos.end()) continue;
            double dx = pv->second[0] - pu->second[0];
            double dy = pv->second[1] - pu->second[1];
            double dist = std::sqrt(dx * dx + dy * dy);
            if (!(dist > 1e-9)) continue;
            double ux = dx / dist, uy = dy / dist;
            double fr = o.cNodeRep * std::pow(o.delta / dist, 2);
            forces[v][0] += fr * ux;
            forces[v][1] += fr * uy;
        }
        auto ait = adjacency.find(v);
        if (ait != adjacency.end()) {
            for (const auto& u : ait->second) {
                auto pu = pos.find(u);
                if (pu == pos.end()) continue;
                double dx = pu->second[0] - pv->second[0];
                double dy = pu->second[1] - pv->second[1];
                double dist = std::sqrt(dx * dx + dy * dy);
                if (!(dist > 1e-9)) continue;
                double ux = dx / dist, uy = dy / dist;
                double fa = o.cEdgeAttr * (dist / o.delta);
                forces[v][0] += fa * ux;
                forces[v][1] += fa * uy;
            }
        }
    }

    for (const auto& v : node_ids) {
        auto pv = pos.find(v);
        if (pv == pos.end()) continue;
        for (const auto& [a, b] : edges) {
            if (a == v || b == v) continue;
            auto pa = pos.find(a), pb = pos.find(b);
            if (pa == pos.end() || pb == pos.end()) continue;
            double qx, qy;
            auto proj = project_point_on_segment(pv->second[0], pv->second[1],
                                                 pa->second[0], pa->second[1],
                                                 pb->second[0], pb->second[1]);
            if (proj.ok) { qx = proj.x; qy = proj.y; }
            else {
                double da = std::hypot(pv->second[0] - pa->second[0], pv->second[1] - pa->second[1]);
                double db = std::hypot(pv->second[0] - pb->second[0], pv->second[1] - pb->second[1]);
                if (da <= db) { qx = pa->second[0]; qy = pa->second[1]; }
                else { qx = pb->second[0]; qy = pb->second[1]; }
            }
            double dx = pv->second[0] - qx, dy = pv->second[1] - qy;
            double dist = std::sqrt(dx * dx + dy * dy);
            if (!(dist > 1e-9)) continue;
            if (dist > o.nearbyFactor * o.delta) continue;
            double ux = dx / dist, uy = dy / dist;
            double fe = o.cNodeEdgeRep * std::pow(o.delta / dist, 2);
            forces[v][0] += fe * ux;
            forces[v][1] += fe * uy;
        }
    }
    return forces;
}

std::unordered_map<std::string, std::vector<double>> compute_movement_limits(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edges,
    const pg::PosByStr& pos, double maxMove, int sectorCount) {
    std::unordered_map<std::string, std::vector<double>> limits;
    for (const auto& id : node_ids) limits[id] = std::vector<double>(sectorCount, maxMove);

    for (const auto& v : node_ids) {
        auto pv = pos.find(v);
        if (pv == pos.end()) continue;
        for (int s = 0; s < sectorCount; ++s) {
            double ang = ((s + 0.5) / sectorCount) * 2 * M_PI;
            double dx = std::cos(ang), dy = std::sin(ang);
            double best = maxMove;
            for (const auto& [a, b] : edges) {
                if (a == v || b == v) continue;
                auto pa = pos.find(a), pb = pos.find(b);
                if (pa == pos.end() || pb == pos.end()) continue;
                double t = ray_segment_distance(pv->second[0], pv->second[1], dx, dy,
                                                pa->second[0], pa->second[1],
                                                pb->second[0], pb->second[1]);
                if (t < best) best = t;
            }
            limits[v][s] = std::max(0.0, best - 1e-4);
        }
    }
    return limits;
}

struct CrossingPair {
    std::pair<std::string,std::string> e1, e2;
};

std::vector<CrossingPair> find_crossing_edge_pairs(
    const std::vector<std::pair<std::string,std::string>>& edges, const pg::PosByStr& pos) {
    std::vector<CrossingPair> out;
    for (size_t i = 0; i < edges.size(); ++i) {
        const auto& [a1, b1] = edges[i];
        auto p1 = pos.find(a1), q1 = pos.find(b1);
        if (p1 == pos.end() || q1 == pos.end()) continue;
        for (size_t j = i + 1; j < edges.size(); ++j) {
            const auto& [a2, b2] = edges[j];
            if (a1 == a2 || a1 == b2 || b1 == a2 || b1 == b2) continue;
            auto p2 = pos.find(a2), q2 = pos.find(b2);
            if (p2 == pos.end() || q2 == pos.end()) continue;
            if (geo::segments_intersect_or_touch(p1->second, q1->second, p2->second, q2->second, 1e-9)) {
                out.push_back({{a1, b1}, {a2, b2}});
            }
        }
    }
    return out;
}

struct RollbackResult {
    bool resolved = false;
    std::unordered_set<std::string> rolled_back;
};

RollbackResult resolve_crossings_by_vertex_rollback(pg::PosByStr& pos, const pg::PosByStr& prev,
    const std::vector<std::pair<std::string,std::string>>& edges,
    const std::unordered_set<std::string>& fixed_outer) {
    constexpr double EPS = 1e-9;
    const int max_rounds = 64;
    RollbackResult R;

    auto moved_distance = [&](const std::string& v) {
        auto cur = pos.find(v);
        auto pv = prev.find(v);
        if (cur == pos.end() || pv == prev.end()) return 0.0;
        return std::hypot(cur->second[0] - pv->second[0], cur->second[1] - pv->second[1]);
    };

    for (int round = 0; round < max_rounds; ++round) {
        auto crossings = find_crossing_edge_pairs(edges, pos);
        if (crossings.empty()) { R.resolved = true; return R; }
        bool changed = false;
        for (const auto& cp : crossings) {
            std::vector<std::string> cands = {cp.e1.first, cp.e1.second, cp.e2.first, cp.e2.second};
            std::string bestV;
            double bestDist = 0;
            for (const auto& v : cands) {
                if (fixed_outer.count(v)) continue;
                double d = moved_distance(v);
                if (d > bestDist + EPS) { bestDist = d; bestV = v; }
            }
            if (!bestV.empty() && bestDist > EPS) {
                auto it = prev.find(bestV);
                if (it != prev.end()) {
                    pos[bestV] = it->second;
                    R.rolled_back.insert(bestV);
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    R.resolved = find_crossing_edge_pairs(edges, pos).empty();
    return R;
}

} // namespace

LayoutResult impred(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    if (g.edges.empty()) { r.ok = false; r.message = "ImPrEd requires at least 1 edge"; return r; }

    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "ImPrEd layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_and_layout_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "ImPrEd failed" : prep.message; return r; }

    Config cfg;
    // Iterate over ORIGINAL graph.
    std::vector<std::string> node_ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> edges;
    for (const auto& [u, v] : g.edges) edges.emplace_back(g.node_names[u], g.node_names[v]);
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& id : node_ids) adjacency[id] = {};
    for (const auto& [u, v] : edges) { adjacency[u].push_back(v); adjacency[v].push_back(u); }

    pg::PosByStr pos;
    for (const auto& id : node_ids) {
        auto it = prep.pos_by_id.find(id);
        if (it != prep.pos_by_id.end()) pos[id] = it->second;
    }
    std::unordered_set<std::string> fixed_outer(prep.outer_face.begin(), prep.outer_face.end());

    double delta = estimate_delta(edges, pos);
    int maxIters = cfg.maxIters;
    double startMaxMove = cfg.maxMoveFactor * delta;
    double minMaxMove = cfg.minMaxMoveFactor * delta;
    double maxMoveTol = cfg.movementStopTolFactor * delta;
    double avgMoveTol = cfg.avgMovementStopTolFactor * delta;

    std::unordered_map<std::string, std::array<double,2>> velocity;
    for (const auto& id : node_ids) velocity[id] = {0, 0};

    std::string stop_reason = "max-iters";
    int stable_iters = 0;
    int iter = 0;
    double last_max_move = 0, last_avg_move = 0;
    int last_moved = 0;

    for (iter = 0; iter < maxIters; ++iter) {
        pg::PosByStr prevPos = pos;
        double alpha = maxIters > 1 ? (iter / (double)(maxIters - 1)) : 1;
        double maxMove = startMaxMove + alpha * (minMaxMove - startMaxMove);
        ForceOpts fo;
        fo.delta = delta;
        fo.cNodeRep = cfg.nodeRepulsion * (1.0 + 3.0 * alpha);
        fo.cEdgeAttr = cfg.edgeAttraction * (1.0 - 0.6 * alpha);
        fo.cNodeEdgeRep = cfg.nodeEdgeRepulsion;
        fo.nearbyFactor = cfg.nearbyFactor;
        auto forces = compute_node_forces(node_ids, edges, adjacency, pos, fo);
        auto limits = compute_movement_limits(node_ids, edges, pos, maxMove, cfg.sectorCount);

        for (const auto& v : node_ids) {
            if (fixed_outer.count(v)) { velocity[v] = {0, 0}; continue; }
            auto fit = forces.find(v);
            if (fit == forces.end()) continue;
            double fx = fit->second[0], fy = fit->second[1];
            double fmag = std::hypot(fx, fy);
            if (!(fmag > 1e-9)) continue;
            int k = sector_index(fx, fy, cfg.sectorCount);
            double allowed = limits[v][k];
            if (!(allowed > 1e-9)) continue;
            double step = std::min(allowed, cfg.forceScale * fmag);
            if (!(step > 1e-9)) continue;
            double ux = fx / fmag, uy = fy / fmag;
            Point oldP = pos[v];
            auto& prevVel = velocity[v];
            double proposedDx = ux * step, proposedDy = uy * step;
            double velX = cfg.momentumBeta * prevVel[0] + (1 - cfg.momentumBeta) * proposedDx;
            double velY = cfg.momentumBeta * prevVel[1] + (1 - cfg.momentumBeta) * proposedDy;
            double velMag = std::hypot(velX, velY);
            if (velMag > allowed && velMag > 1e-12) {
                double sc = allowed / velMag;
                velX *= sc; velY *= sc;
            }
            Point newP = {oldP[0] + velX, oldP[1] + velY};

            int shrink = 0;
            while (move_would_cross(v, oldP, newP, node_ids, edges, adjacency, pos) && shrink < 12) {
                newP[0] = oldP[0] + (newP[0] - oldP[0]) * 0.5;
                newP[1] = oldP[1] + (newP[1] - oldP[1]) * 0.5;
                shrink += 1;
            }
            if (move_would_cross(v, oldP, newP, node_ids, edges, adjacency, pos)) {
                velocity[v][0] *= cfg.rejectedVelocityDamp;
                velocity[v][1] *= cfg.rejectedVelocityDamp;
                continue;
            }

            double movedDx = newP[0] - oldP[0];
            double movedDy = newP[1] - oldP[1];
            if (std::hypot(movedDx, movedDy) > 1e-6) {
                pos[v] = newP;
                velocity[v] = {movedDx, movedDy};
            } else {
                velocity[v][0] *= cfg.rejectedVelocityDamp;
                velocity[v][1] *= cfg.rejectedVelocityDamp;
            }
        }

        // Crossings check.
        std::vector<std::pair<int,int>> iedges;
        std::unordered_map<std::string,int> idx;
        for (size_t i = 0; i < node_ids.size(); ++i) idx[node_ids[i]] = (int)i;
        PositionMap pm;
        pm.resize((int)node_ids.size());
        for (size_t i = 0; i < node_ids.size(); ++i) {
            auto it = pos.find(node_ids[i]);
            if (it != pos.end()) pm.put((int)i, it->second[0], it->second[1]);
        }
        for (const auto& [u, v] : edges) iedges.emplace_back(idx[u], idx[v]);
        bool has_cross = geo::has_position_crossings(pm, iedges);
        if (has_cross) {
            auto rr = resolve_crossings_by_vertex_rollback(pos, prevPos, edges, fixed_outer);
            if (!rr.resolved) {
                pos = prevPos;
                for (const auto& vid : node_ids) {
                    velocity[vid][0] *= cfg.fullRollbackVelocityDamp;
                    velocity[vid][1] *= cfg.fullRollbackVelocityDamp;
                }
            } else {
                for (const auto& rv : rr.rolled_back) {
                    if (velocity.count(rv)) {
                        velocity[rv][0] *= cfg.rollbackVelocityDamp;
                        velocity[rv][1] *= cfg.rollbackVelocityDamp;
                    }
                }
                // Re-check.
                PositionMap pm2;
                pm2.resize((int)node_ids.size());
                for (size_t i = 0; i < node_ids.size(); ++i) {
                    auto it = pos.find(node_ids[i]);
                    if (it != pos.end()) pm2.put((int)i, it->second[0], it->second[1]);
                }
                if (geo::has_position_crossings(pm2, iedges)) {
                    pos = prevPos;
                    for (const auto& vid : node_ids) {
                        velocity[vid][0] *= cfg.fullRollbackVelocityDamp;
                        velocity[vid][1] *= cfg.fullRollbackVelocityDamp;
                    }
                }
            }
        }

        // Move stats.
        int moved = 0;
        double total_move = 0, max_move = 0;
        for (const auto& id : node_ids) {
            auto a = pos.find(id), b = prevPos.find(id);
            if (a == pos.end() || b == prevPos.end()) continue;
            double d = std::hypot(a->second[0] - b->second[0], a->second[1] - b->second[1]);
            if (!std::isfinite(d)) continue;
            total_move += d;
            if (d > max_move) max_move = d;
            if (d > 1e-6) moved += 1;
        }
        double avg_move = node_ids.empty() ? 0 : total_move / node_ids.size();
        last_max_move = max_move;
        last_avg_move = avg_move;
        last_moved = moved;

        if (moved == 0) { stop_reason = "no-movement"; break; }

        bool below = max_move <= maxMoveTol && avg_move <= avgMoveTol;
        if (below) stable_iters += 1; else stable_iters = 0;
        if (iter + 1 >= cfg.minItersBeforeStop && stable_iters >= cfg.stableIterLimit) {
            stop_reason = "movement-converged";
            break;
        }
    }

    // final position map
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = pos.find(g.node_names[i]);
        if (it != pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            pm.put(i, it->second[0], it->second[1]);
        }
    }
    r.ok = true;
    r.positions = pm;
    r.message = "ImPrEd layout";
    r.stop_reason = stop_reason;
    r.iters = iter + 1;
    (void)last_max_move; (void)last_avg_move; (void)last_moved;
    return r;
}

} // namespace planarvibe::layouts
