// FaceBalancer L-BFGS layout. Literal port of static/js/layout-facebalancer.js.
// Self-contained — no cross-balancer shared module.

#include "layouts/facebalancer.hpp"
#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "linear_algebra.hpp"
#include "metrics.hpp"
#include "planar_graph.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct Config {
    double areaTol = 1e-15;
    double faceBarrierWeight = 0.2;
    double edgeBarrierWeight = 0.05;
    double edgeUniformWeight = 0.02;
    double minFaceAreaFactor = 0.25;
    double minEdgeLength2 = 0;
    int maxIters = 80;
    double gradTol = 1e-5;
    double stepTol = 1e-6;
    int lbfgsMemory = 10;
    double lineSearchC1 = 1e-4;
    double lineSearchTau = 0.5;
    int minItersBeforeStop = 40;
    int stableIterLimit = 8;
    double movementStopTol = 1e-6;
    double avgMovementStopTol = 2e-7;
};

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

std::string face_key_of(const std::vector<std::string>& face) {
    if (face.empty()) return "";
    int n = (int)face.size();
    std::string best;
    for (int i = 0; i < n; ++i) {
        std::string rot;
        for (int k = 0; k < n; ++k) {
            if (k) rot += '|';
            rot += face[(i + k) % n];
        }
        if (best.empty() || rot < best) best = rot;
    }
    return best;
}

double polygon_area2_from_arrays(const std::vector<int>& face,
                                  const std::vector<double>& x, const std::vector<double>& y) {
    if (face.size() < 3) return 0.0;
    double sum = 0.0;
    int n = (int)face.size();
    for (int i = 0; i < n; ++i) {
        int a = face[i], b = face[(i + 1) % n];
        sum += x[a] * y[b] - x[b] * y[a];
    }
    return sum;
}

void softmax_into(const std::vector<double>& q, int start, int length, std::vector<double>& out) {
    double m = -std::numeric_limits<double>::infinity();
    for (int i = 0; i < length; ++i) {
        double v = q[start + i];
        if (v > m) m = v;
    }
    double Z = 0.0;
    for (int i = 0; i < length; ++i) {
        double w = std::exp(q[start + i] - m);
        out[start + i] = w;
        Z += w;
    }
    if (!(Z > 0)) {
        double uniform = 1.0 / std::max(1, length);
        for (int i = 0; i < length; ++i) out[start + i] = uniform;
        return;
    }
    for (int i = 0; i < length; ++i) out[start + i] /= Z;
}

struct BalancerData {
    std::vector<std::string> augIds;
    std::unordered_map<std::string, int> augIndexById;
    std::vector<double> x0, y0;
    std::vector<int> interiorAugIndices;
    std::vector<int> interiorIndexByAug;  // size nA, -1 if not interior
    std::vector<int> rowStart;
    std::vector<int> rowLength;
    std::vector<std::vector<int>> neighborAugIndices;
    std::vector<std::vector<int>> neighborInteriorIndices;
    int qSize = 0;
    std::vector<std::vector<int>> boundedFaces;
    std::vector<std::pair<int,int>> edges;

    double areaTol = 0;
    double faceBarrierWeight = 0;
    double edgeBarrierWeight = 0;
    double edgeUniformWeight = 0;
    double edgeBarrierScale2 = 1;
    double initialMinFaceArea = 0;
    double minFaceArea = 0;
    double minEdgeLength2 = 0;
};

struct BuildResult {
    bool ok = false;
    std::string reason;
    BalancerData data;
};

BuildResult build_data(
    const std::vector<std::pair<std::string,std::string>>& aug_edge_pairs,
    const planarity::StringEmbedding& aug_emb,
    const std::vector<std::string>& outer_face,
    const std::unordered_map<std::string, Point>& outer_pos,
    const Config& cfg) {
    BuildResult R;
    auto& d = R.data;
    d.augIds = aug_emb.id_by_index;
    int nA = (int)d.augIds.size();
    for (int i = 0; i < nA; ++i) d.augIndexById[d.augIds[i]] = i;

    d.x0.assign(nA, 0.0);
    d.y0.assign(nA, 0.0);
    for (int i = 0; i < nA; ++i) {
        auto it = outer_pos.find(d.augIds[i]);
        if (it != outer_pos.end()) { d.x0[i] = it->second[0]; d.y0[i] = it->second[1]; }
    }
    for (const auto& [a, b] : aug_edge_pairs) {
        auto ia = d.augIndexById.find(a);
        auto ib = d.augIndexById.find(b);
        if (ia == d.augIndexById.end() || ib == d.augIndexById.end()) continue;
        if (ia->second == ib->second) continue;
        d.edges.emplace_back(ia->second, ib->second);
    }

    std::string outer_key = face_key_of(outer_face);
    for (const auto& rawFace : aug_emb.faces) {
        if (face_key_of(rawFace) == outer_key) continue;
        if (rawFace.size() < 3) { R.reason = "FaceBalancer requires a valid triangulated augmentation"; return R; }
        if (rawFace.size() != 3) { R.reason = "FaceBalancer requires all non-outer augmented faces to be triangles"; return R; }
        std::vector<int> tri(3);
        for (int k = 0; k < 3; ++k) tri[k] = d.augIndexById.at(rawFace[k]);
        d.boundedFaces.push_back(std::move(tri));
    }

    std::vector<char> outerMask(nA, 0);
    for (const auto& f : outer_face) {
        auto it = d.augIndexById.find(f);
        if (it != d.augIndexById.end()) outerMask[it->second] = 1;
    }
    d.interiorIndexByAug.assign(nA, -1);
    for (int i = 0; i < nA; ++i) {
        if (!outerMask[i]) {
            d.interiorIndexByAug[i] = (int)d.interiorAugIndices.size();
            d.interiorAugIndices.push_back(i);
        }
    }

    int nI = (int)d.interiorAugIndices.size();
    d.rowStart.assign(nI, 0);
    d.rowLength.assign(nI, 0);
    d.neighborAugIndices.assign(nI, {});
    d.neighborInteriorIndices.assign(nI, {});
    for (int i = 0; i < nI; ++i) {
        int augIdx = d.interiorAugIndices[i];
        const auto& rotRow = (augIdx < (int)aug_emb.rotation.size()) ? aug_emb.rotation[augIdx]
                                                                     : std::vector<std::string>{};
        std::vector<int> nbrs(rotRow.size());
        for (size_t k = 0; k < rotRow.size(); ++k) nbrs[k] = d.augIndexById.at(rotRow[k]);
        d.rowStart[i] = d.qSize;
        d.rowLength[i] = (int)nbrs.size();
        d.qSize += (int)nbrs.size();
        d.neighborAugIndices[i] = nbrs;
        d.neighborInteriorIndices[i].reserve(nbrs.size());
        for (int nb : nbrs) d.neighborInteriorIndices[i].push_back(d.interiorIndexByAug[nb]);
    }

    d.areaTol = std::max(0.0, cfg.areaTol);
    d.faceBarrierWeight = std::max(0.0, cfg.faceBarrierWeight);
    d.edgeBarrierWeight = std::max(0.0, cfg.edgeBarrierWeight);
    d.edgeUniformWeight = std::max(0.0, cfg.edgeUniformWeight);
    d.minEdgeLength2 = std::max(0.0, cfg.minEdgeLength2);
    R.ok = true;
    return R;
}

bool build_initial_logit_seed(const BalancerData& d,
                              const std::unordered_map<std::string, double>& weights,
                              std::vector<double>& q0_out) {
    q0_out.assign(d.qSize, 0.0);
    int nI = (int)d.interiorAugIndices.size();
    for (int i = 0; i < nI; ++i) {
        const std::string& vid = d.augIds[d.interiorAugIndices[i]];
        int rowOffset = d.rowStart[i];
        const auto& nbrs = d.neighborAugIndices[i];
        if (nbrs.empty()) continue;
        std::vector<double> rw(nbrs.size(), 0.0);
        double sum = 0.0;
        for (size_t k = 0; k < nbrs.size(); ++k) {
            const std::string& nid = d.augIds[nbrs[k]];
            auto it = weights.find(ekey(vid, nid));
            if (it == weights.end() || !std::isfinite(it->second) || !(it->second > 0)) return false;
            rw[k] = it->second;
            sum += it->second;
        }
        if (!(sum > 0)) return false;
        for (size_t k = 0; k < nbrs.size(); ++k) q0_out[rowOffset + k] = std::log(rw[k] / sum);
    }
    return true;
}

struct Realized {
    std::vector<double> lambda;
    la::LUFactor factor;
    std::vector<double> x, y;
    bool ok = false;
};

Realized realize_state(const std::vector<double>& q, const BalancerData& d) {
    Realized R;
    int nI = (int)d.interiorAugIndices.size();
    R.lambda.assign(d.qSize, 0.0);
    std::vector<std::vector<double>> L(nI, std::vector<double>(nI, 0.0));
    std::vector<double> bx(nI, 0.0), by(nI, 0.0);
    for (int i = 0; i < nI; ++i) {
        L[i][i] = 1.0;
        softmax_into(q, d.rowStart[i], d.rowLength[i], R.lambda);
        const auto& nbrs = d.neighborAugIndices[i];
        const auto& interiorNs = d.neighborInteriorIndices[i];
        for (size_t k = 0; k < nbrs.size(); ++k) {
            double w = R.lambda[d.rowStart[i] + k];
            int augIdx = nbrs[k];
            int interiorIdx = interiorNs[k];
            if (interiorIdx >= 0) {
                L[i][interiorIdx] -= w;
            } else {
                bx[i] += w * d.x0[augIdx];
                by[i] += w * d.y0[augIdx];
            }
        }
    }
    auto factor = la::lu_factorize(L);
    if (!factor) return R;
    auto primal = la::solve_lu_with_two_rhs(*factor, bx, by);
    if (!primal) return R;
    R.factor = *factor;
    R.x = d.x0;
    R.y = d.y0;
    for (int i = 0; i < nI; ++i) {
        int aug = d.interiorAugIndices[i];
        R.x[aug] = primal->first[i];
        R.y[aug] = primal->second[i];
    }
    R.ok = true;
    return R;
}

struct InitBaselineResult {
    bool ok = false;
    std::unordered_map<std::string, Point> positions;
};

InitBaselineResult initialize_baseline(BalancerData& d, const std::vector<double>& q0) {
    InitBaselineResult R;
    auto realized = realize_state(q0, d);
    if (!realized.ok) return R;
    const auto& x = realized.x;
    const auto& y = realized.y;
    double sum = 0.0;
    int cnt = 0;
    for (const auto& e : d.edges) {
        double dx = x[e.first] - x[e.second];
        double dy = y[e.first] - y[e.second];
        double l2 = dx * dx + dy * dy;
        if (l2 > 1e-12) { sum += l2; ++cnt; }
    }
    d.edgeBarrierScale2 = cnt > 0 ? (sum / cnt) : 1.0;

    double initialFaceMinArea = std::numeric_limits<double>::infinity();
    for (auto& face : d.boundedFaces) {
        if (polygon_area2_from_arrays(face, x, y) < 0) std::reverse(face.begin(), face.end());
        double area = std::abs(polygon_area2_from_arrays(face, x, y)) / 2.0;
        if (area > 1e-12 && area < initialFaceMinArea) initialFaceMinArea = area;
    }
    d.initialMinFaceArea = std::isfinite(initialFaceMinArea) ? initialFaceMinArea : 0.0;

    for (int i = 0; i < (int)d.augIds.size(); ++i) {
        R.positions[d.augIds[i]] = {x[i], y[i]};
    }
    R.ok = true;
    return R;
}

struct EvalResult {
    bool ok = false;
    std::string reason;
    double E = 0;
    std::vector<double> gradVec;
    double gradNorm = 0;
    std::vector<double> x, y;
    double maxRelError = 0;
};

EvalResult evaluate_objective(const std::vector<double>& q, const BalancerData& d) {
    EvalResult R;
    double triangleSlack = std::max(d.areaTol, 1e-12);
    int nI = (int)d.interiorAugIndices.size();
    auto realized = realize_state(q, d);
    if (!realized.ok) { R.reason = "FaceBalancer linear solve failed"; return R; }
    const auto& lambda = realized.lambda;
    const auto& factor = realized.factor;
    const auto& x = realized.x;
    const auto& y = realized.y;

    std::vector<double> faceAreas(d.boundedFaces.size(), 0.0);
    double totalArea = 0;
    for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
        int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
        double area = 0.5 * ((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a]));
        if (!(area > -triangleSlack)) { R.reason = "invalid-triangulation-step"; return R; }
        faceAreas[i] = area > triangleSlack ? area : triangleSlack;
    }
    for (double fa : faceAreas) if (!(fa > d.minFaceArea)) { R.reason = "invalid-face-step"; return R; }
    for (const auto& boundary : d.boundedFaces) {
        if (!(polygon_area2_from_arrays(boundary, x, y) > 2 * d.areaTol)) {
            R.reason = "invalid-face-step";
            return R;
        }
    }
    for (double fa : faceAreas) totalArea += fa;
    if (!(faceAreas.size() > 0) || !(totalArea > 1e-12)) {
        R.reason = "FaceBalancer total bounded area is not positive";
        return R;
    }

    double targetArea = totalArea / faceAreas.size();
    std::vector<double> residual(faceAreas.size(), 0.0);
    double E = 0;
    double maxRelError = 0;
    for (size_t i = 0; i < faceAreas.size(); ++i) {
        residual[i] = faceAreas[i] / targetArea - 1;
        E += residual[i] * residual[i];
        if (d.faceBarrierWeight > 0) E -= d.faceBarrierWeight * std::log(faceAreas[i] / targetArea);
        double rel = std::abs(residual[i]);
        if (rel > maxRelError) maxRelError = rel;
    }

    std::vector<double> zX(nI, 0.0), zY(nI, 0.0);
    for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
        int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
        double coeff = 2 * residual[i] / targetArea;
        if (d.faceBarrierWeight > 0) coeff -= d.faceBarrierWeight / faceAreas[i];
        double dAxA = 0.5 * (y[b] - y[c]);
        double dAxB = 0.5 * (y[c] - y[a]);
        double dAxC = 0.5 * (y[a] - y[b]);
        double dAyA = 0.5 * (x[c] - x[b]);
        double dAyB = 0.5 * (x[a] - x[c]);
        double dAyC = 0.5 * (x[b] - x[a]);
        int ia = d.interiorIndexByAug[a];
        int ib = d.interiorIndexByAug[b];
        int ic = d.interiorIndexByAug[c];
        if (ia >= 0) { zX[ia] += coeff * dAxA; zY[ia] += coeff * dAyA; }
        if (ib >= 0) { zX[ib] += coeff * dAxB; zY[ib] += coeff * dAyB; }
        if (ic >= 0) { zX[ic] += coeff * dAxC; zY[ic] += coeff * dAyC; }
    }

    if (d.edgeBarrierWeight > 0) {
        double edgeScale2 = d.edgeBarrierScale2 > 1e-12 ? d.edgeBarrierScale2 : 1.0;
        double edgeTol2 = std::max(1e-24, d.areaTol);
        for (const auto& e : d.edges) {
            int u = e.first, v = e.second;
            double dx = x[u] - x[v];
            double dy = y[u] - y[v];
            double len2 = dx * dx + dy * dy;
            double safeLen2 = len2 > edgeTol2 ? len2 : edgeTol2;
            if (!(safeLen2 < edgeScale2)) continue;
            E -= d.edgeBarrierWeight * std::log(safeLen2 / edgeScale2);
            double edgeCoeff = -2 * d.edgeBarrierWeight / safeLen2;
            int iu = d.interiorIndexByAug[u];
            int iv = d.interiorIndexByAug[v];
            if (iu >= 0) { zX[iu] += edgeCoeff * dx; zY[iu] += edgeCoeff * dy; }
            if (iv >= 0) { zX[iv] -= edgeCoeff * dx; zY[iv] -= edgeCoeff * dy; }
        }
    }

    if (d.edgeUniformWeight > 0 && d.edges.size() > 1) {
        double uniformTol2 = std::max(1e-24, d.areaTol);
        std::vector<double> logLen2(d.edges.size(), 0.0);
        double logMean = 0;
        for (size_t i = 0; i < d.edges.size(); ++i) {
            int u = d.edges[i].first, v = d.edges[i].second;
            double dx = x[u] - x[v];
            double dy = y[u] - y[v];
            double len2 = dx * dx + dy * dy;
            double safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
            double logVal = std::log(safeLen2);
            logLen2[i] = logVal;
            logMean += logVal;
        }
        logMean /= d.edges.size();
        double uniformScale = 2 * d.edgeUniformWeight / d.edges.size();
        for (size_t i = 0; i < d.edges.size(); ++i) {
            int u = d.edges[i].first, v = d.edges[i].second;
            double dx = x[u] - x[v];
            double dy = y[u] - y[v];
            double len2 = dx * dx + dy * dy;
            double safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
            double centered = logLen2[i] - logMean;
            E += d.edgeUniformWeight * centered * centered / d.edges.size();
            double uniformCoeff = uniformScale * centered / safeLen2;
            int iu = d.interiorIndexByAug[u];
            int iv = d.interiorIndexByAug[v];
            if (iu >= 0) { zX[iu] += uniformCoeff * dx; zY[iu] += uniformCoeff * dy; }
            if (iv >= 0) { zX[iv] -= uniformCoeff * dx; zY[iv] -= uniformCoeff * dy; }
        }
    }

    if (d.minEdgeLength2 > 0) {
        for (const auto& e : d.edges) {
            double ox = x[e.first] - x[e.second];
            double oy = y[e.first] - y[e.second];
            if (!(ox * ox + oy * oy > d.minEdgeLength2)) {
                R.reason = "invalid-edge-step";
                return R;
            }
        }
    }

    auto adjoint = la::solve_transpose_lu_with_two_rhs(factor, zX, zY);
    if (!adjoint) { R.reason = "FaceBalancer adjoint solve failed"; return R; }
    const auto& ax1 = adjoint->first;
    const auto& ax2 = adjoint->second;

    std::vector<double> gradVec(d.qSize, 0.0);
    for (int i = 0; i < nI; ++i) {
        int rowOffset = d.rowStart[i];
        double meanx = 0, meany = 0;
        const auto& nbrs = d.neighborAugIndices[i];
        for (size_t k = 0; k < nbrs.size(); ++k) {
            double w = lambda[rowOffset + k];
            meanx += w * x[nbrs[k]];
            meany += w * y[nbrs[k]];
        }
        for (size_t k = 0; k < nbrs.size(); ++k) {
            int augIdx = nbrs[k];
            double w = lambda[rowOffset + k];
            gradVec[rowOffset + k] = w * (ax1[i] * (x[augIdx] - meanx) + ax2[i] * (y[augIdx] - meany));
        }
    }
    double gn = 0.0;
    for (double v : gradVec) gn += v * v;

    R.ok = true;
    R.E = E;
    R.gradVec = std::move(gradVec);
    R.gradNorm = std::sqrt(gn);
    R.x = std::move(realized.x);
    R.y = std::move(realized.y);
    R.maxRelError = maxRelError;
    return R;
}

// L-BFGS two-loop recursion (same math as JS lbfgsDirection).
std::vector<double> lbfgs_direction(const std::vector<double>& g,
                                    const std::vector<std::vector<double>>& S,
                                    const std::vector<std::vector<double>>& Y,
                                    const std::vector<double>& Rho) {
    int m = (int)S.size();
    std::vector<double> alpha(m, 0.0);
    std::vector<double> q = g;
    for (int i = m - 1; i >= 0; --i) {
        double dot = 0; for (size_t j = 0; j < q.size(); ++j) dot += S[i][j] * q[j];
        alpha[i] = Rho[i] * dot;
        for (size_t j = 0; j < q.size(); ++j) q[j] -= alpha[i] * Y[i][j];
    }
    double gamma = 1.0;
    if (m > 0) {
        double yy = 0, sy = 0;
        for (size_t j = 0; j < q.size(); ++j) { yy += Y[m-1][j] * Y[m-1][j]; sy += S[m-1][j] * Y[m-1][j]; }
        if (yy > 1e-14) gamma = sy / yy;
    }
    std::vector<double> r(q.size());
    for (size_t j = 0; j < q.size(); ++j) r[j] = gamma * q[j];
    for (int i = 0; i < m; ++i) {
        double dot = 0; for (size_t j = 0; j < r.size(); ++j) dot += Y[i][j] * r[j];
        double beta = Rho[i] * dot;
        for (size_t j = 0; j < r.size(); ++j) r[j] += (alpha[i] - beta) * S[i][j];
    }
    for (auto& v : r) v = -v;
    return r;
}

struct OptResult {
    bool ok = false;
    std::string reason;
    std::vector<double> q;
    std::unordered_map<std::string, Point> positions;
    double E = 0;
    double gradNorm = 0;
    double maxRelError = 0;
    std::string stopReason = "max-iters";
    int iters = 0;
};

OptResult run_optimization(const std::vector<double>& q0, BalancerData& d, const Config& cfg,
                           gh::MovementTracker* tracker) {
    OptResult R;
    std::vector<double> q = q0;
    auto current = evaluate_objective(q, d);
    if (!current.ok) { R.reason = current.reason; return R; }

    std::vector<std::vector<double>> S, Y;
    std::vector<double> Rho;
    std::string stopReason = "max-iters";
    int completed = 0;

    auto vec_dot = [](const std::vector<double>& a, const std::vector<double>& b) {
        double s = 0; for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i]; return s;
    };

    for (int iter = 1; iter <= cfg.maxIters; ++iter) {
        if (current.gradNorm <= cfg.gradTol) { stopReason = "grad-converged"; break; }
        auto prev_x = current.x;
        auto prev_y = current.y;
        auto dir = lbfgs_direction(current.gradVec, S, Y, Rho);
        if (!(vec_dot(current.gradVec, dir) < 0)) {
            dir.assign(current.gradVec.size(), 0);
            for (size_t j = 0; j < current.gradVec.size(); ++j) dir[j] = -current.gradVec[j];
        }
        double alpha = 1.0;
        bool accepted = false;
        std::vector<double> q_trial;
        EvalResult trial;
        double gtd = vec_dot(current.gradVec, dir);
        while (alpha >= 1e-12) {
            q_trial.assign(q.size(), 0);
            for (size_t j = 0; j < q.size(); ++j) q_trial[j] = q[j] + alpha * dir[j];
            trial = evaluate_objective(q_trial, d);
            if (trial.ok && trial.E <= current.E + cfg.lineSearchC1 * alpha * gtd) {
                accepted = true;
                break;
            }
            alpha *= cfg.lineSearchTau;
        }
        if (!accepted) { stopReason = "line-search-failed"; break; }

        std::vector<double> s(q.size()), yv(q.size());
        for (size_t j = 0; j < q.size(); ++j) { s[j] = q_trial[j] - q[j]; yv[j] = trial.gradVec[j] - current.gradVec[j]; }
        double step_norm = 0;
        for (double sv : s) step_norm += sv * sv;
        step_norm = std::sqrt(step_norm);
        q = q_trial;
        current = trial;
        completed = iter;

        if (tracker) {
            const auto& new_x = current.x;
            const auto& new_y = current.y;
            auto dist_fn = [&](int aug_idx, int) {
                return std::hypot(new_x[aug_idx] - prev_x[aug_idx], new_y[aug_idx] - prev_y[aug_idx]);
            };
            auto ms = gh::compute_move_stats(d.interiorAugIndices, dist_fn, 1e-9);
            auto status = tracker->update(ms, iter);
            if (status.converged) { stopReason = status.reason.empty() ? "movement-converged" : status.reason; break; }
        }
        if (step_norm < cfg.stepTol) { stopReason = "step-converged"; break; }

        double ys = vec_dot(yv, s);
        if (ys > 1e-14) {
            if ((int)S.size() == cfg.lbfgsMemory) {
                S.erase(S.begin()); Y.erase(Y.begin()); Rho.erase(Rho.begin());
            }
            S.push_back(s);
            Y.push_back(yv);
            Rho.push_back(1.0 / ys);
        }
    }

    R.ok = true;
    R.q = q;
    R.positions.clear();
    for (int i = 0; i < (int)d.augIds.size(); ++i) R.positions[d.augIds[i]] = {current.x[i], current.y[i]};
    R.E = current.E;
    R.gradNorm = current.gradNorm;
    R.maxRelError = current.maxRelError;
    R.stopReason = stopReason;
    R.iters = completed;
    return R;
}

std::unordered_map<std::string, Point> build_outer_positions(
    const preprocessing::PreparedGraph& prep) {
    // Circle placement around augmented graph's outer face.
    TutteOuterPlacement opts;
    auto full_pos = place_outer_face_vertices(prep.augmented_node_ids, prep.augmented_outer_face, opts);
    std::unordered_map<std::string, Point> out;
    for (const auto& f : prep.augmented_outer_face) {
        auto it = full_pos.find(f);
        if (it != full_pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1]))
            out[f] = it->second;
    }
    return out;
}

} // namespace

LayoutResult facebalancer(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    Config cfg;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "FaceBalancer layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, pcfg);
    if (!prep.ok) {
        r.ok = false; r.message = prep.message.empty() ? "FaceBalancer failed" : prep.message; return r;
    }
    auto outer_pos = build_outer_positions(prep);
    auto build = build_data(prep.augmented_edge_pairs, prep.augmented_embedding, prep.augmented_outer_face,
                             outer_pos, cfg);
    if (!build.ok) { r.ok = false; r.message = build.reason; return r; }
    auto& d = build.data;

    // Build Tutte weights on augmented graph.
    auto weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);
    std::vector<double> q0;
    if (!build_initial_logit_seed(d, weights, q0)) {
        r.ok = false; r.message = "FaceBalancer initialization requires positive Tutte weights"; return r;
    }
    auto baseline = initialize_baseline(d, q0);
    if (!baseline.ok) { r.ok = false; r.message = "FaceBalancer initialization failed"; return r; }
    if (d.boundedFaces.empty()) {
        // No bounded faces — return baseline, no metrics produced.
        r.positions.resize(g.n);
        for (int i = 0; i < g.n; ++i) {
            auto it = baseline.positions.find(g.node_names[i]);
            if (it != baseline.positions.end()) r.positions.put(i, it->second[0], it->second[1]);
        }
        r.ok = true;
        r.message = "FaceBalancer (no bounded faces)";
        return r;
    }
    d.minFaceArea = std::max(0.0, cfg.minFaceAreaFactor * d.initialMinFaceArea);

    PositionMap pm_scale;
    pm_scale.resize((int)prep.augmented_node_ids.size());
    for (int i = 0; i < (int)prep.augmented_node_ids.size(); ++i) {
        auto it = baseline.positions.find(prep.augmented_node_ids[i]);
        if (it != baseline.positions.end()) pm_scale.put(i, it->second[0], it->second[1]);
    }
    double movement_scale = geo::compute_drawing_diameter((int)prep.augmented_node_ids.size(), pm_scale);
    gh::MovementTrackerConfig tcfg;
    tcfg.min_iters_before_stop = cfg.minItersBeforeStop;
    tcfg.stable_iter_limit = cfg.stableIterLimit;
    tcfg.max_move_tol = cfg.movementStopTol * movement_scale;
    tcfg.avg_move_tol = cfg.avgMovementStopTol * movement_scale;
    gh::MovementTracker tracker(tcfg);

    auto opt = run_optimization(q0, d, cfg, &tracker);
    if (!opt.ok) { r.ok = false; r.message = opt.reason; return r; }

    // Filter to original nodes.
    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = opt.positions.find(g.node_names[i]);
        if (it != opt.positions.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1]))
            r.positions.put(i, it->second[0], it->second[1]);
    }
    if (geo::has_position_crossings(r.positions, g.edges)) {
        r.ok = false;
        r.message = "FaceBalancer produced a non-plane drawing";
        return r;
    }
    r.ok = true;
    r.iters = opt.iters;
    r.stop_reason = opt.stopReason;
    r.message = "FaceBalancer layout";
    return r;
}

} // namespace planarvibe::layouts
