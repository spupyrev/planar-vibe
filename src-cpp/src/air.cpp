// Air layout — literal port of static/js/layout-air.js.
// Vertex-by-vertex Newton step on the per-vertex area-entropy objective.

#include "layouts/air.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct AirConfig {
    int maxSweeps = 200;
    int maxNewtonIter = 10;
    double tolForceGlobal = 1e-8;
    double tolForceVertex = 1e-6;
    double tolAreaGlobal = 1e-3;
    double tolAreaPositive = 1e-15;
    double armijo = 1e-4;
    double outerRingFaceWeight = 0.25;
    double minStep = std::pow(2.0, -40);
    double moveTolRel = 1e-5;
    double moveTolAbs = 1e-12;
    double errTolRel = 1e-4;
    int patience = 2;
    int deadlockPatience = 2;
    int plateauWindow = 12;
    int plateauPatience = 1;
    double plateauErrGuardFactor = 20.0;
};

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

std::string face_key_of(const std::vector<std::string>& face) {
    if (face.empty()) return "";
    int n = (int)face.size();
    int best = 0;
    for (int i = 1; i < n; ++i) {
        for (int k = 0; k < n; ++k) {
            const std::string& a = face[(i + k) % n];
            const std::string& b = face[(best + k) % n];
            if (a != b) { if (a < b) best = i; break; }
        }
    }
    std::string out;
    for (int k = 0; k < n; ++k) {
        if (k) out += '|';
        out += face[(best + k) % n];
    }
    return out;
}

double polygon_area2_by_name(const std::vector<std::string>& face,
                             const pg::PosByStr& pos) {
    if (face.size() < 3) return 0.0;
    double sum = 0.0;
    int n = (int)face.size();
    for (int i = 0; i < n; ++i) {
        auto a = pos.find(face[i]);
        auto b = pos.find(face[(i + 1) % n]);
        if (a == pos.end() || b == pos.end()) return 0.0;
        sum += a->second[0] * b->second[1] - b->second[0] * a->second[1];
    }
    return sum;
}

std::vector<std::string> orient_ccw(const std::vector<std::string>& face,
                                    const pg::PosByStr& pos) {
    std::vector<std::string> out = face;
    if (polygon_area2_by_name(out, pos) < 0) std::reverse(out.begin(), out.end());
    return out;
}

double outer_face_diameter_by_name(const pg::PosByStr& pos,
                                   const std::vector<std::string>& outer) {
    double diam = 0;
    for (size_t i = 0; i < outer.size(); ++i) {
        auto a = pos.find(outer[i]);
        if (a == pos.end()) continue;
        if (!std::isfinite(a->second[0]) || !std::isfinite(a->second[1])) continue;
        for (size_t j = i + 1; j < outer.size(); ++j) {
            auto b = pos.find(outer[j]);
            if (b == pos.end()) continue;
            if (!std::isfinite(b->second[0]) || !std::isfinite(b->second[1])) continue;
            double dx = a->second[0] - b->second[0];
            double dy = a->second[1] - b->second[1];
            double d = std::hypot(dx, dy);
            if (d > diam) diam = d;
        }
    }
    return diam > 1e-12 ? diam : 1.0;
}

struct IncidentEntry {
    int faceIndex;
    std::string left;
    std::string right;
};

struct Triangle {
    std::vector<std::string> vertices;
    double targetArea = 0;
    double weight = 1;
    bool isOuterRing = false;
    bool isRealFace = true;
};

struct AirData {
    std::vector<Triangle> triangles;
    std::unordered_map<std::string, std::vector<IncidentEntry>> incident;
    double targetTriangleArea = 0;
    std::vector<std::string> outerFace;
};

struct BuildResult {
    bool ok = false;
    std::string reason;
    AirData data;
};

BuildResult build_air_data(const planarity::StringEmbedding& aug_emb,
                           const std::vector<std::string>& outer_face,
                           const pg::PosByStr& pos,
                           const std::vector<std::string>& original_node_ids) {
    BuildResult R;
    auto& d = R.data;

    std::string outer_key = face_key_of(outer_face);
    std::unordered_set<std::string> outer_edge_set;
    std::unordered_set<std::string> outer_vertex_set(outer_face.begin(), outer_face.end());
    std::unordered_set<std::string> original_vertex_set(original_node_ids.begin(), original_node_ids.end());
    for (size_t i = 0; i < outer_face.size(); ++i) {
        outer_edge_set.insert(ekey(outer_face[i], outer_face[(i + 1) % outer_face.size()]));
    }

    for (const auto& id : aug_emb.id_by_index) d.incident[id] = {};

    for (const auto& face : aug_emb.faces) {
        if (face.size() < 3) { R.reason = "Air requires a valid triangulated augmentation"; return R; }
        auto oriented = orient_ccw(face, pos);
        if (face_key_of(oriented) == outer_key) continue;
        if (oriented.size() != 3) { R.reason = "Air requires all non-outer augmented faces to be triangles"; return R; }

        bool isOuterRing = false;
        for (size_t ei = 0; ei < oriented.size(); ++ei) {
            if (outer_vertex_set.count(oriented[ei])) { isOuterRing = true; break; }
            if (outer_edge_set.count(ekey(oriented[ei], oriented[(ei + 1) % oriented.size()]))) { isOuterRing = true; break; }
        }
        bool isRealFace = true;
        for (const auto& id : oriented) if (!original_vertex_set.count(id)) { isRealFace = false; break; }

        Triangle tri;
        tri.vertices = oriented;
        tri.weight = isOuterRing ? 0.25 : 1.0;
        tri.isOuterRing = isOuterRing;
        tri.isRealFace = isRealFace;
        int tidx = (int)d.triangles.size();
        d.triangles.push_back(tri);
        for (int j = 0; j < 3; ++j) {
            d.incident[oriented[j]].push_back({tidx, oriented[(j + 2) % 3], oriented[(j + 1) % 3]});
        }
    }

    if (d.triangles.empty()) { R.ok = true; return R; }

    double outer_area = std::abs(polygon_area2_by_name(outer_face, pos)) / 2.0;
    if (!(outer_area > 1e-12)) { R.reason = "Air initialization failed: outer face has zero area"; return R; }
    double target = outer_area / d.triangles.size();
    for (auto& tri : d.triangles) tri.targetArea = target;
    d.targetTriangleArea = target;
    d.outerFace = outer_face;
    R.ok = true;
    return R;
}

struct LocalState {
    bool feasible = true;
    double forceX = 0, forceY = 0;
    double entropy = 0;
    double a = 0, b = 0, c = 0;
};

LocalState evaluate_local_state(const std::vector<IncidentEntry>& entries,
                                const std::vector<Triangle>& tris,
                                const pg::PosByStr& pos, Point point,
                                double tolAreaPositive) {
    LocalState s;
    for (const auto& e : entries) {
        const auto& tri = tris[e.faceIndex];
        auto lp = pos.find(e.left);
        auto rp = pos.find(e.right);
        if (lp == pos.end() || rp == pos.end()) { s.feasible = false; continue; }
        double sx = lp->second[0] - rp->second[0];
        double sy = lp->second[1] - rp->second[1];
        double rx = -sy;
        double ry = sx;
        double dx = point[0] - rp->second[0];
        double dy = point[1] - rp->second[1];
        double area = 0.5 * (sx * dy - sy * dx);
        if (!(area > tolAreaPositive)) { s.feasible = false; continue; }
        double pressure = tri.targetArea / area;
        double w = std::isfinite(tri.weight) ? tri.weight : 1.0;
        s.forceX += w * pressure * rx;
        s.forceY += w * pressure * ry;
        s.entropy += -w * tri.targetArea * std::log(std::max(pressure, 1e-300));
        double coeff = -0.25 * w * tri.targetArea / (area * area);
        s.a += coeff * rx * rx;
        s.b += coeff * rx * ry;
        s.c += coeff * ry * ry;
    }
    return s;
}

struct SolveResult {
    Point pos;
    double forceNorm = 0;
    bool stalled = false;
};

SolveResult solve_balanced_position(const std::string& vertex_id, const AirData& d,
                                    const pg::PosByStr& pos,
                                    const std::vector<IncidentEntry>& entries,
                                    const AirConfig& cfg, LocalState init_state) {
    Point p = pos.at(vertex_id);
    LocalState state = init_state;
    for (int iter = 0; iter < cfg.maxNewtonIter; ++iter) {
        if (!state.feasible) return {p, std::numeric_limits<double>::infinity(), true};
        double fnorm = std::hypot(state.forceX, state.forceY);
        if (fnorm <= cfg.tolForceVertex) return {p, fnorm, false};
        double gx = 0.5 * state.forceX;
        double gy = 0.5 * state.forceY;
        double det = state.a * state.c - state.b * state.b;
        double dxd, dyd;
        if (det > 1e-18) {
            dxd = (state.b * gy - state.c * gx) / det;
            dyd = (state.b * gx - state.a * gy) / det;
            if (!std::isfinite(dxd) || !std::isfinite(dyd)) { dxd = gx; dyd = gy; }
        } else {
            dxd = gx; dyd = gy;
        }
        if (gx * dxd + gy * dyd <= 0) { dxd = gx; dyd = gy; }

        double alpha = 1.0;
        bool accepted = false;
        while (alpha >= cfg.minStep) {
            Point q = {p[0] + alpha * dxd, p[1] + alpha * dyd};
            LocalState qs = evaluate_local_state(entries, d.triangles, pos, q, cfg.tolAreaPositive);
            if (qs.feasible && qs.entropy >= state.entropy + cfg.armijo * alpha * (gx * dxd + gy * dyd)) {
                p = q;
                state = qs;
                accepted = true;
                break;
            }
            alpha *= 0.5;
        }
        if (!accepted) return {p, fnorm, true};
    }
    double fnorm = state.feasible ? std::hypot(state.forceX, state.forceY)
                                  : std::numeric_limits<double>::infinity();
    return {p, fnorm, false};
}

struct AirStats {
    double maxRelError = 0;
    double maxForce = 0;
    int balancedCount = 0;
    int boundedFaceCount = 0;
    double maxMove = 0;
    double avgMove = 0;
    int acceptedCount = 0;
    int sweeps = 0;
};

AirStats compute_air_stats(const AirData& d, const pg::PosByStr& pos,
                           const std::vector<std::string>& movable,
                           double tolAreaPositive) {
    AirStats s;
    for (const auto& tri : d.triangles) {
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        double area = 0;
        if (a != pos.end() && b != pos.end() && c != pos.end()) {
            area = std::abs(geo::triangle_area2(a->second, b->second, c->second)) / 2.0;
        }
        double rel = std::abs(area - tri.targetArea) / std::max(tri.targetArea, 1e-12);
        if (!std::isfinite(rel)) rel = std::numeric_limits<double>::infinity();
        if (rel > s.maxRelError) s.maxRelError = rel;
    }
    for (const auto& v : movable) {
        auto pv = pos.find(v);
        if (pv == pos.end()) continue;
        const auto& entries = d.incident.at(v);
        auto st = evaluate_local_state(entries, d.triangles, pos, pv->second, tolAreaPositive);
        double f = st.feasible ? std::hypot(st.forceX, st.forceY) : std::numeric_limits<double>::infinity();
        if (f > s.maxForce) s.maxForce = f;
        if (f <= 1e-8) s.balancedCount += 1;
    }
    s.boundedFaceCount = (int)d.triangles.size();
    return s;
}

} // namespace

LayoutResult air(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "Air layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_and_layout_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "Air failed" : prep.message; return r; }

    AirConfig cfg;

    std::vector<std::string> original_ids = g.node_names;
    pg::PosByStr pos = prep.pos_by_id;

    auto build = build_air_data(prep.augmented_embedding, prep.augmented_outer_face, pos, original_ids);
    if (!build.ok) { r.ok = false; r.message = build.reason; return r; }
    AirData& d = build.data;

    std::vector<std::string> movable;
    {
        std::unordered_set<std::string> outer_set(prep.augmented_outer_face.begin(), prep.augmented_outer_face.end());
        for (const auto& nid : prep.augmented_node_ids) {
            if (outer_set.count(nid)) continue;
            auto it = d.incident.find(nid);
            if (it != d.incident.end() && !it->second.empty()) movable.push_back(nid);
        }
    }

    if (d.triangles.empty()) {
        r.ok = true;
        r.message = "Air layout";
        r.positions.resize(g.n);
        for (int i = 0; i < g.n; ++i) {
            auto it = pos.find(g.node_names[i]);
            if (it != pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
                r.positions.put(i, it->second[0], it->second[1]);
            }
        }
        return r;
    }

    // sanity check triangle areas
    for (const auto& tri : d.triangles) {
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        if (a == pos.end() || b == pos.end() || c == pos.end()) {
            r.ok = false; r.message = "Air initialization failed: degenerate augmented triangle"; return r;
        }
        double area = std::abs(geo::triangle_area2(a->second, b->second, c->second)) / 2.0;
        if (!(area > cfg.tolAreaPositive)) {
            r.ok = false; r.message = "Air initialization failed: degenerate augmented triangle"; return r;
        }
    }

    AirStats last = compute_air_stats(d, pos, movable, cfg.tolAreaPositive);
    double outerDiameter = outer_face_diameter_by_name(pos, d.outerFace);
    double moveTol = cfg.moveTolAbs + cfg.moveTolRel * outerDiameter;
    double avgMoveTol = 0.25 * moveTol;
    double plateauErrTolAbs = cfg.tolAreaGlobal;
    double plateauErrTolRel = 5.0 * cfg.errTolRel;
    double plateauErrGuard = cfg.plateauErrGuardFactor * cfg.tolAreaGlobal;
    double prevMaxRelErr = last.maxRelError;
    int stalledSweeps = 0, deadSweeps = 0, plateauSweeps = 0;
    std::vector<double> errWindow{prevMaxRelErr};
    std::string status = "max_sweeps";

    if (prevMaxRelErr <= cfg.tolAreaGlobal) {
        status = "realized";
        last.maxMove = 0; last.avgMove = 0; last.acceptedCount = 0; last.sweeps = 0;
    } else {
        for (int sweep = 1; sweep <= cfg.maxSweeps; ++sweep) {
            int acceptedCount = 0;
            double sumMove = 0, maxMove = 0;

            for (const auto& v : movable) {
                auto pv = pos.find(v);
                if (pv == pos.end()) continue;
                const auto& entries = d.incident.at(v);
                LocalState cs = evaluate_local_state(entries, d.triangles, pos, pv->second, cfg.tolAreaPositive);
                double cur_f = cs.feasible ? std::hypot(cs.forceX, cs.forceY) : std::numeric_limits<double>::infinity();
                if (cur_f <= cfg.tolForceGlobal) continue;

                auto solved = solve_balanced_position(v, d, pos, entries, cfg, cs);
                Point basePos = pv->second;
                double dx = solved.pos[0] - basePos[0];
                double dy = solved.pos[1] - basePos[1];
                Point accepted_pos = basePos;
                bool found = false;
                double stepScale = 1.0;
                while (stepScale >= cfg.minStep) {
                    Point cand = {basePos[0] + stepScale * dx, basePos[1] + stepScale * dy};
                    LocalState cs2 = evaluate_local_state(entries, d.triangles, pos, cand, cfg.tolAreaPositive);
                    if (cs2.feasible) { accepted_pos = cand; found = true; break; }
                    stepScale *= 0.5;
                }
                if (found) {
                    pos[v] = accepted_pos;
                    double mdx = accepted_pos[0] - basePos[0];
                    double mdy = accepted_pos[1] - basePos[1];
                    double mv = std::sqrt(mdx * mdx + mdy * mdy);
                    if (mv > maxMove) maxMove = mv;
                    sumMove += mv;
                    acceptedCount += 1;
                }
            }

            double avgMove = acceptedCount > 0 ? sumMove / acceptedCount : 0;
            last = compute_air_stats(d, pos, movable, cfg.tolAreaPositive);
            double maxRelErr = last.maxRelError;
            double improvement = prevMaxRelErr - maxRelErr;
            double relImprovement = improvement / std::max(1.0, prevMaxRelErr);
            errWindow.push_back(maxRelErr);
            if ((int)errWindow.size() > cfg.plateauWindow + 1) errWindow.erase(errWindow.begin());
            double plateauWindowImprovementAbs = std::numeric_limits<double>::quiet_NaN();
            double plateauWindowImprovementRel = std::numeric_limits<double>::quiet_NaN();
            bool hasPlateauWindow = (int)errWindow.size() >= cfg.plateauWindow + 1;
            if (hasPlateauWindow) {
                plateauWindowImprovementAbs = errWindow[0] - maxRelErr;
                plateauWindowImprovementRel = plateauWindowImprovementAbs / std::max(1.0, errWindow[0]);
            }
            last.maxMove = maxMove;
            last.avgMove = avgMove;
            last.acceptedCount = acceptedCount;
            last.sweeps = sweep;

            if (maxRelErr <= cfg.tolAreaGlobal) { status = "realized"; break; }

            if (acceptedCount == 0) deadSweeps += 1; else deadSweeps = 0;
            if (deadSweeps >= cfg.deadlockPatience) { status = "deadlock"; break; }

            if (maxMove <= moveTol && avgMove <= avgMoveTol && relImprovement <= cfg.errTolRel) stalledSweeps += 1;
            else stalledSweeps = 0;
            if (stalledSweeps >= cfg.patience) { status = "stalled"; break; }

            if (hasPlateauWindow &&
                maxRelErr <= plateauErrGuard &&
                plateauWindowImprovementAbs <= plateauErrTolAbs &&
                plateauWindowImprovementRel <= plateauErrTolRel) plateauSweeps += 1;
            else plateauSweeps = 0;
            if (plateauSweeps >= cfg.plateauPatience) { status = "stalled"; break; }

            prevMaxRelErr = maxRelErr;
        }
    }

    // Check crossings on the ORIGINAL graph.
    std::vector<std::pair<int,int>> iedges = g.edges;
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = pos.find(g.node_names[i]);
        if (it != pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) {
            pm.put(i, it->second[0], it->second[1]);
        }
    }
    if (geo::has_position_crossings(pm, iedges)) {
        r.ok = false;
        r.message = "Air produced a non-plane drawing";
        return r;
    }

    r.ok = true;
    r.message = "Air layout";
    r.positions = pm;
    r.stop_reason = status;
    r.iters = last.sweeps;
    return r;
}

} // namespace planarvibe::layouts
