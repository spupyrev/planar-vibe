// AreaGrad layout — literal port of static/js/layout-areagrad.js.
// Vertex sweep with per-vertex 2x2 Gauss-Newton step on triangle-area residuals.

#include "layouts/areagrad.hpp"

#include "geometry.hpp"
#include "planar_graph.hpp"
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
    double tolGrad = 1e-8;
    double acceptanceTol = 1e-12;
    double minTriangleAreaRel = 1e-10;
    int maxIters = 200;
    double maxVertexMoveRel = 0.08;
    double localDamping = 1e-3;
    double stepShrink = 0.5;
    double minStepScale = std::pow(2.0, -20);
    double tolAreaPositive = 1e-12;
    double tolAreaGlobal = 1e-3;
};

struct IncidentEntry { int triangleIndex; int slot; };
struct Triangle { std::vector<std::string> vertices; };

struct Data {
    std::vector<Triangle> triangles;
    std::unordered_map<std::string, std::vector<IncidentEntry>> incident;
    double targetTriangleArea = 0;
    std::vector<std::string> outerFace;
};

double polygon_area2_by_name(const std::vector<std::string>& face, const pg::PosByStr& pos) {
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

std::vector<std::string> orient_ccw(const std::vector<std::string>& face, const pg::PosByStr& pos) {
    std::vector<std::string> out = face;
    if (polygon_area2_by_name(out, pos) < 0) std::reverse(out.begin(), out.end());
    return out;
}

double outer_face_diameter_by_name(const pg::PosByStr& pos, const std::vector<std::string>& outer) {
    double diam = 0;
    for (size_t i = 0; i < outer.size(); ++i) {
        auto a = pos.find(outer[i]);
        if (a == pos.end()) continue;
        if (!std::isfinite(a->second[0]) || !std::isfinite(a->second[1])) continue;
        for (size_t j = i + 1; j < outer.size(); ++j) {
            auto b = pos.find(outer[j]);
            if (b == pos.end()) continue;
            if (!std::isfinite(b->second[0]) || !std::isfinite(b->second[1])) continue;
            double d = std::hypot(a->second[0] - b->second[0], a->second[1] - b->second[1]);
            if (d > diam) diam = d;
        }
    }
    return diam > 1e-12 ? diam : 1.0;
}

struct BuildResult { bool ok = false; std::string reason; Data data; };

BuildResult build_data(const planarity::StringEmbedding& aug_emb,
                       const std::vector<std::string>& outer_face,
                       const pg::PosByStr& pos) {
    BuildResult R;
    auto& d = R.data;
    for (const auto& id : aug_emb.id_by_index) d.incident[id] = {};

    int outer_idx = pg::find_outer_face_index(aug_emb.faces, outer_face);
    for (int i = 0; i < (int)aug_emb.faces.size(); ++i) {
        const auto& face = aug_emb.faces[i];
        if (face.size() < 3) { R.reason = "AreaGrad requires a valid triangulated augmentation"; return R; }
        if (i == outer_idx) continue;
        auto oriented = orient_ccw(face, pos);
        if (oriented.size() != 3) { R.reason = "AreaGrad requires all bounded faces of H to be triangles"; return R; }
        int tidx = (int)d.triangles.size();
        d.triangles.push_back({oriented});
        for (int j = 0; j < 3; ++j) d.incident[oriented[j]].push_back({tidx, j});
    }

    if (d.triangles.empty()) { R.ok = true; d.outerFace = outer_face; return R; }

    double outer_area = std::abs(polygon_area2_by_name(outer_face, pos)) / 2.0;
    if (!(outer_area > 1e-12)) { R.reason = "AreaGrad initialization failed: outer face has zero area"; return R; }
    d.targetTriangleArea = outer_area / d.triangles.size();
    d.outerFace = outer_face;
    R.ok = true;
    return R;
}

double effective_min_triangle_area(const Data& d, const Config& cfg) {
    double t = std::isfinite(d.targetTriangleArea) ? d.targetTriangleArea : 0.0;
    return std::max(std::isfinite(cfg.tolAreaPositive) ? cfg.tolAreaPositive : 0.0,
                    cfg.minTriangleAreaRel * std::max(t, 0.0));
}

struct Residuals {
    bool ok = false;
    std::vector<double> residuals;
    double areaEnergy = 0;
    double maxRelError = 0;
};

Residuals compute_triangle_residuals(const Data& d, const pg::PosByStr& pos, double tolAreaPositive) {
    Residuals R;
    R.residuals.assign(d.triangles.size(), 0);
    for (int i = 0; i < (int)d.triangles.size(); ++i) {
        const auto& tri = d.triangles[i];
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        if (a == pos.end() || b == pos.end() || c == pos.end()) return R;
        double area = geo::triangle_area2(a->second, b->second, c->second) / 2.0;
        if (!(area > tolAreaPositive)) return R;
        double rel = area / d.targetTriangleArea - 1;
        R.residuals[i] = rel;
        R.areaEnergy += rel * rel;
        if (std::abs(rel) > R.maxRelError) R.maxRelError = std::abs(rel);
    }
    R.ok = true;
    return R;
}

struct State {
    bool ok = false;
    double objective = 0;
    double areaEnergy = 0;
    std::vector<double> residuals;
    double maxRelError = 0;
    double rmsRelError = 0;
};

State compute_state(const Data& d, const pg::PosByStr& pos, double minTriangleArea) {
    State S;
    auto r = compute_triangle_residuals(d, pos, minTriangleArea);
    if (!r.ok) return S;
    S.ok = true;
    S.objective = r.areaEnergy;
    S.areaEnergy = r.areaEnergy;
    S.residuals = std::move(r.residuals);
    S.maxRelError = r.maxRelError;
    S.rmsRelError = d.triangles.empty() ? 0 : std::sqrt(S.areaEnergy / d.triangles.size());
    return S;
}

bool incident_triangles_positive(const std::string& v, const Data& d, const pg::PosByStr& pos, double tol) {
    auto it = d.incident.find(v);
    if (it == d.incident.end()) return true;
    for (const auto& e : it->second) {
        const auto& tri = d.triangles[e.triangleIndex];
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        if (a == pos.end() || b == pos.end() || c == pos.end()) return false;
        if (!(geo::triangle_area2(a->second, b->second, c->second) / 2.0 > tol)) return false;
    }
    return true;
}

void add_triangle_gradient_for_slot(double& gx, double& gy, int slot,
                                     Point a, Point b, Point c, double coeff) {
    if (coeff == 0) return;
    if (slot == 0) { gx += coeff * 0.5 * (b[1] - c[1]); gy += coeff * 0.5 * (c[0] - b[0]); }
    else if (slot == 1) { gx += coeff * 0.5 * (c[1] - a[1]); gy += coeff * 0.5 * (a[0] - c[0]); }
    else if (slot == 2) { gx += coeff * 0.5 * (a[1] - b[1]); gy += coeff * 0.5 * (b[0] - a[0]); }
}

struct Delta { double x = 0, y = 0, norm = 0; };

Delta compute_local_delta(const std::string& v, const Data& d, const pg::PosByStr& pos,
                          const std::vector<double>& residuals, const Config& cfg,
                          double maxVertexMove) {
    Delta R;
    auto it = d.incident.find(v);
    if (it == d.incident.end() || it->second.empty()) return R;
    double h00 = cfg.localDamping, h01 = 0, h11 = cfg.localDamping;
    double b0 = 0, b1 = 0;
    double invT = 1.0 / std::max(d.targetTriangleArea, 1e-18);

    for (const auto& e : it->second) {
        const auto& tri = d.triangles[e.triangleIndex];
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        if (a == pos.end() || b == pos.end() || c == pos.end()) continue;
        double gx = 0, gy = 0;
        add_triangle_gradient_for_slot(gx, gy, e.slot, a->second, b->second, c->second, invT);
        double r = (e.triangleIndex < (int)residuals.size()) ? residuals[e.triangleIndex] : 0;
        h00 += gx * gx;
        h01 += gx * gy;
        h11 += gy * gy;
        b0 += -r * gx;
        b1 += -r * gy;
    }
    double det = h00 * h11 - h01 * h01;
    if (!(det > 1e-18)) return R;
    double dx = (h11 * b0 - h01 * b1) / det;
    double dy = (h00 * b1 - h01 * b0) / det;
    double norm = std::hypot(dx, dy);
    if (norm > maxVertexMove && maxVertexMove > 0) {
        double s = maxVertexMove / norm;
        dx *= s; dy *= s; norm = maxVertexMove;
    }
    R.x = dx; R.y = dy; R.norm = norm;
    return R;
}

double max_incident_residual(const std::string& v, const Data& d, const std::vector<double>& residuals) {
    auto it = d.incident.find(v);
    if (it == d.incident.end()) return 0;
    double w = 0;
    for (const auto& e : it->second) {
        double r = (e.triangleIndex < (int)residuals.size()) ? std::abs(residuals[e.triangleIndex]) : 0;
        if (r > w) w = r;
    }
    return w;
}

} // namespace

LayoutResult areagrad(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "AreaGrad layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_and_layout_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "AreaGrad failed" : prep.message; return r; }

    Config cfg;
    pg::PosByStr pos = prep.pos_by_id;

    auto build = build_data(prep.augmented_embedding, prep.augmented_outer_face, pos);
    if (!build.ok) { r.ok = false; r.message = build.reason; return r; }
    Data& d = build.data;

    std::vector<std::string> movable;
    {
        std::unordered_set<std::string> outer_set(prep.augmented_outer_face.begin(), prep.augmented_outer_face.end());
        for (const auto& nid : prep.augmented_node_ids) {
            if (!outer_set.count(nid)) movable.push_back(nid);
        }
    }

    if (d.triangles.empty()) {
        r.ok = true;
        r.message = "AreaGrad layout";
        r.positions.resize(g.n);
        for (int i = 0; i < g.n; ++i) {
            auto it = pos.find(g.node_names[i]);
            if (it != pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) r.positions.put(i, it->second[0], it->second[1]);
        }
        r.stop_reason = "realized";
        r.iters = 0;
        return r;
    }

    double minTriangleArea = effective_min_triangle_area(d, cfg);
    for (const auto& tri : d.triangles) {
        auto a = pos.find(tri.vertices[0]);
        auto b = pos.find(tri.vertices[1]);
        auto c = pos.find(tri.vertices[2]);
        if (a == pos.end() || b == pos.end() || c == pos.end()) {
            r.ok = false; r.message = "AreaGrad initialization failed: degenerate augmented triangle"; return r;
        }
        double area = geo::triangle_area2(a->second, b->second, c->second) / 2.0;
        if (!(area > minTriangleArea)) { r.ok = false; r.message = "AreaGrad initialization failed: degenerate augmented triangle"; return r; }
    }

    double outerDiameter = outer_face_diameter_by_name(pos, prep.augmented_outer_face);
    double maxVertexMove = cfg.maxVertexMoveRel * outerDiameter;

    State state = compute_state(d, pos, minTriangleArea);
    if (!state.ok) { r.ok = false; r.message = "AreaGrad initialization failed"; return r; }
    std::string status = "max_iters";
    if (state.maxRelError <= cfg.tolAreaGlobal) status = "realized";

    int iter = 0;
    for (iter = 1; iter <= cfg.maxIters && status == "max_iters"; ++iter) {
        int acceptedCount = 0;
        std::vector<std::string> sweep = movable;
        std::stable_sort(sweep.begin(), sweep.end(),
            [&](const std::string& a, const std::string& b) {
                return max_incident_residual(b, d, state.residuals) < max_incident_residual(a, d, state.residuals);
            });

        for (const auto& v : sweep) {
            Delta delta = compute_local_delta(v, d, pos, state.residuals, cfg, maxVertexMove);
            if (!(delta.norm > cfg.tolGrad)) continue;
            auto basePos_it = pos.find(v);
            if (basePos_it == pos.end()) continue;
            Point basePos = basePos_it->second;
            double stepScale = 1.0;
            while (stepScale >= cfg.minStepScale) {
                double dx = stepScale * delta.x;
                double dy = stepScale * delta.y;
                pos[v] = {basePos[0] + dx, basePos[1] + dy};
                if (!incident_triangles_positive(v, d, pos, minTriangleArea)) {
                    pos[v] = basePos;
                    stepScale *= cfg.stepShrink;
                    continue;
                }
                State trial = compute_state(d, pos, minTriangleArea);
                if (trial.ok && trial.objective <= state.objective - cfg.acceptanceTol * std::max(1.0, state.objective)) {
                    state = trial;
                    acceptedCount += 1;
                    break;
                }
                pos[v] = basePos;
                stepScale *= cfg.stepShrink;
            }
        }

        if (state.maxRelError <= cfg.tolAreaGlobal) { status = "realized"; break; }
        if (acceptedCount == 0) { status = "stalled"; break; }
    }

    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = pos.find(g.node_names[i]);
        if (it != pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1])) pm.put(i, it->second[0], it->second[1]);
    }
    if (geo::has_position_crossings(pm, g.edges)) { r.ok = false; r.message = "AreaGrad produced a non-plane drawing"; return r; }

    r.ok = true;
    r.message = "AreaGrad layout";
    r.positions = pm;
    r.stop_reason = status;
    r.iters = std::min(cfg.maxIters, std::max(0, iter - (status == "max_iters" ? 1 : 0)));
    return r;
}

} // namespace planarvibe::layouts
