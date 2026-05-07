// EdgeBalancer L-BFGS layout. Literal port of static/js/layout-edgebalancer.js.

#include "layouts/edgebalancer.hpp"
#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "linear_algebra.hpp"
#include "metrics.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

namespace planarvibe::layouts {

namespace {

struct Config {
    double areaTol = 1e-15;
    double augmentedEdgeWeight = 0.25;
    double faceBarrierWeight = 0.02;
    double rangeWeight = 0.05;
    double rangeBeta = 6;
    double logAbsWeight = 0.5;
    double logAbsEpsilon = 0.25;
    double minFaceAreaFactor = 0.2;
    int maxIters = 80;
    double gradTol = 1e-5;
    double stepTol = 1e-10;
    int lbfgsMemory = 10;
    double maxStepNorm = 2.0;
    double maxPositionStepRatio = 0.1;
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
        for (int k = 0; k < n; ++k) { if (k) rot += '|'; rot += face[(i + k) % n]; }
        if (best.empty() || rot < best) best = rot;
    }
    return best;
}

double polygon_area2(const std::vector<int>& face,
                     const std::vector<double>& x, const std::vector<double>& y) {
    if (face.size() < 3) return 0.0;
    double sum = 0;
    int n = (int)face.size();
    for (int i = 0; i < n; ++i) {
        int a = face[i], b = face[(i+1) % n];
        sum += x[a] * y[b] - x[b] * y[a];
    }
    return sum;
}

void softmax_into(const std::vector<double>& q, int start, int length, std::vector<double>& out) {
    double m = -std::numeric_limits<double>::infinity();
    for (int i = 0; i < length; ++i) if (q[start+i] > m) m = q[start+i];
    double Z = 0;
    for (int i = 0; i < length; ++i) {
        double w = std::exp(q[start+i] - m);
        out[start+i] = w;
        Z += w;
    }
    if (!(Z > 0)) {
        double u = 1.0 / std::max(1, length);
        for (int i = 0; i < length; ++i) out[start+i] = u;
        return;
    }
    for (int i = 0; i < length; ++i) out[start+i] /= Z;
}

struct Edge { int u, v; double barrier; };

struct Data {
    std::vector<std::string> augIds;
    std::unordered_map<std::string,int> augIndexById;
    std::vector<double> x0, y0;
    std::vector<int> interiorAugIndices;
    std::vector<int> interiorIndexByAug;
    std::vector<int> rowStart, rowLength;
    std::vector<std::vector<int>> neighborAugIndices;
    std::vector<std::vector<int>> neighborInteriorIndices;
    int qSize = 0;
    std::vector<std::vector<int>> boundedFaces;
    std::vector<Edge> edges;
    std::vector<std::pair<int,int>> objectiveEdges;
    double areaTol = 0, faceBarrierWeight = 0, rangeWeight = 0, rangeBeta = 6;
    double logAbsWeight = 0, logAbsEpsilon = 0.25;
    double edgeBarrierScale2 = 1, initialAvgFaceArea = 1, initialMinFaceArea = 0, minFaceArea = 0;
};

struct BuildResult { bool ok = false; std::string reason; Data data; };

BuildResult build_data(const std::vector<std::pair<std::string,std::string>>& aug_edges,
                       const planarity::StringEmbedding& aug_emb,
                       const std::vector<std::string>& outer_face,
                       const std::unordered_map<std::string, Point>& outer_pos,
                       const std::vector<std::pair<std::string,std::string>>& obj_edges,
                       double augmentedEdgeWeight, const Config& cfg) {
    BuildResult R;
    auto& d = R.data;
    d.augIds = aug_emb.id_by_index;
    int nA = (int)d.augIds.size();
    for (int i = 0; i < nA; ++i) d.augIndexById[d.augIds[i]] = i;

    std::unordered_map<std::string, bool> origSet;
    for (const auto& [a, b] : obj_edges) origSet[ekey(a, b)] = true;

    d.x0.assign(nA, 0); d.y0.assign(nA, 0);
    for (int i = 0; i < nA; ++i) {
        auto it = outer_pos.find(d.augIds[i]);
        if (it != outer_pos.end()) { d.x0[i] = it->second[0]; d.y0[i] = it->second[1]; }
    }
    for (const auto& [a, b] : aug_edges) {
        auto ia = d.augIndexById.find(a);
        auto ib = d.augIndexById.find(b);
        if (ia == d.augIndexById.end() || ib == d.augIndexById.end()) continue;
        if (ia->second == ib->second) continue;
        double bw = origSet.count(ekey(a, b)) ? 1.0 : augmentedEdgeWeight;
        d.edges.push_back({ia->second, ib->second, bw});
    }
    for (const auto& [a, b] : obj_edges) {
        auto ia = d.augIndexById.find(a);
        auto ib = d.augIndexById.find(b);
        if (ia == d.augIndexById.end() || ib == d.augIndexById.end()) continue;
        if (ia->second == ib->second) continue;
        d.objectiveEdges.emplace_back(ia->second, ib->second);
    }

    std::string outer_key = face_key_of(outer_face);
    for (const auto& rawFace : aug_emb.faces) {
        if (face_key_of(rawFace) == outer_key) continue;
        if (rawFace.size() < 3) { R.reason = "EdgeBalancer requires a valid triangulated augmentation"; return R; }
        if (rawFace.size() != 3) { R.reason = "EdgeBalancer requires all non-outer augmented faces to be triangles"; return R; }
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
    d.rangeWeight = std::max(0.0, cfg.rangeWeight);
    d.rangeBeta = cfg.rangeBeta;
    d.logAbsWeight = std::max(0.0, cfg.logAbsWeight);
    d.logAbsEpsilon = std::max(0.0, cfg.logAbsEpsilon);
    R.ok = true;
    return R;
}

bool build_initial_seed(const Data& d,
                        const std::unordered_map<std::string,double>& weights,
                        std::vector<double>& q0) {
    q0.assign(d.qSize, 0);
    int nI = (int)d.interiorAugIndices.size();
    for (int i = 0; i < nI; ++i) {
        const std::string& vid = d.augIds[d.interiorAugIndices[i]];
        int rowOffset = d.rowStart[i];
        const auto& nbrs = d.neighborAugIndices[i];
        if (nbrs.empty()) continue;
        std::vector<double> rw(nbrs.size(), 0);
        double sum = 0;
        for (size_t k = 0; k < nbrs.size(); ++k) {
            const std::string& nid = d.augIds[nbrs[k]];
            auto it = weights.find(ekey(vid, nid));
            if (it == weights.end() || !std::isfinite(it->second) || !(it->second > 0)) return false;
            rw[k] = it->second;
            sum += it->second;
        }
        if (!(sum > 0)) return false;
        for (size_t k = 0; k < nbrs.size(); ++k) q0[rowOffset + k] = std::log(rw[k] / sum);
    }
    return true;
}

struct Realized { bool ok = false; std::vector<double> lambda; la::LUFactor factor; std::vector<double> x, y; };

Realized realize_state(const std::vector<double>& q, const Data& d) {
    Realized R;
    int nI = (int)d.interiorAugIndices.size();
    R.lambda.assign(d.qSize, 0);
    std::vector<std::vector<double>> L(nI, std::vector<double>(nI, 0));
    std::vector<double> bx(nI, 0), by(nI, 0);
    for (int i = 0; i < nI; ++i) {
        L[i][i] = 1;
        softmax_into(q, d.rowStart[i], d.rowLength[i], R.lambda);
        const auto& nbrs = d.neighborAugIndices[i];
        const auto& inNs = d.neighborInteriorIndices[i];
        for (size_t k = 0; k < nbrs.size(); ++k) {
            double w = R.lambda[d.rowStart[i] + k];
            int aug = nbrs[k], inIdx = inNs[k];
            if (inIdx >= 0) L[i][inIdx] -= w;
            else { bx[i] += w * d.x0[aug]; by[i] += w * d.y0[aug]; }
        }
    }
    auto f = la::lu_factorize(L);
    if (!f) return R;
    auto sol = la::solve_lu_with_two_rhs(*f, bx, by);
    if (!sol) return R;
    R.factor = *f;
    R.x = d.x0; R.y = d.y0;
    for (int i = 0; i < nI; ++i) {
        int aug = d.interiorAugIndices[i];
        R.x[aug] = sol->first[i];
        R.y[aug] = sol->second[i];
    }
    R.ok = true;
    return R;
}

struct BaselineResult { bool ok = false; std::unordered_map<std::string,Point> positions; };

BaselineResult init_baseline(Data& d, const std::vector<double>& q0) {
    BaselineResult R;
    auto r = realize_state(q0, d);
    if (!r.ok) return R;
    double edgeScaleSum = 0, edgeScaleWeight = 0;
    for (const auto& e : d.edges) {
        double dx = r.x[e.u] - r.x[e.v];
        double dy = r.y[e.u] - r.y[e.v];
        double l2 = dx*dx + dy*dy;
        if (l2 > 1e-12) { edgeScaleSum += e.barrier * l2; edgeScaleWeight += e.barrier; }
    }
    d.edgeBarrierScale2 = edgeScaleWeight > 0 ? (edgeScaleSum / edgeScaleWeight) : 1;
    double minA = std::numeric_limits<double>::infinity();
    double sumA = 0; int cntA = 0;
    for (auto& face : d.boundedFaces) {
        if (polygon_area2(face, r.x, r.y) < 0) std::reverse(face.begin(), face.end());
        double a = std::abs(polygon_area2(face, r.x, r.y)) / 2;
        if (a > 1e-12) { sumA += a; ++cntA; if (a < minA) minA = a; }
    }
    d.initialAvgFaceArea = cntA > 0 ? (sumA / cntA) : 1;
    d.initialMinFaceArea = std::isfinite(minA) ? minA : 0;
    for (int i = 0; i < (int)d.augIds.size(); ++i) R.positions[d.augIds[i]] = {r.x[i], r.y[i]};
    R.ok = true;
    return R;
}

struct EvalResult {
    bool ok = false; std::string reason;
    double E = 0;
    std::vector<double> gradVec;
    double gradNorm = 0;
    std::vector<double> x, y;
    double maxLogDeviation = 0;
};

EvalResult evaluate(const std::vector<double>& q, const Data& d) {
    EvalResult R;
    double triangleSlack = std::max(d.areaTol, 1e-12);
    int nI = (int)d.interiorAugIndices.size();
    auto r = realize_state(q, d);
    if (!r.ok) { R.reason = "EdgeBalancer linear solve failed"; return R; }

    // Face area validation.
    std::vector<double> faceAreas(d.boundedFaces.size(), 0);
    for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
        int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
        double area = 0.5 * ((r.x[b]-r.x[a])*(r.y[c]-r.y[a]) - (r.x[c]-r.x[a])*(r.y[b]-r.y[a]));
        if (!(area > -triangleSlack)) { R.reason = "invalid-triangulation-step"; return R; }
        faceAreas[i] = area > triangleSlack ? area : triangleSlack;
    }
    for (double fa : faceAreas) if (!(fa > d.minFaceArea)) { R.reason = "invalid-face-step"; return R; }
    for (const auto& face : d.boundedFaces) {
        if (!(polygon_area2(face, r.x, r.y) > 2 * d.areaTol)) { R.reason = "invalid-face-step"; return R; }
    }

    if (d.objectiveEdges.empty()) { R.reason = "EdgeBalancer requires at least one valid objective edge"; return R; }

    std::vector<double> zX(nI, 0), zY(nI, 0);
    double E = 0;
    double edgeTol2 = std::max(1e-24, d.areaTol);

    // Objective edge terms.
    int m = (int)d.objectiveEdges.size();
    std::vector<double> len2v(m), dxv(m), dyv(m), logLen2(m);
    double logMean = 0;
    for (int i = 0; i < m; ++i) {
        int u = d.objectiveEdges[i].first, v = d.objectiveEdges[i].second;
        double dx = r.x[u] - r.x[v], dy = r.y[u] - r.y[v];
        double c2 = dx*dx + dy*dy;
        if (!(c2 > edgeTol2)) { R.reason = "invalid-edge-step"; return R; }
        len2v[i] = c2; dxv[i] = dx; dyv[i] = dy;
        logLen2[i] = std::log(c2);
        logMean += logLen2[i];
    }
    logMean /= m;

    double maxLogDeviation = 0;
    for (int i = 0; i < m; ++i) {
        double dev = std::abs(logLen2[i] - logMean);
        if (dev > maxLogDeviation) maxLogDeviation = dev;
    }

    std::vector<double> centered(m);
    double edgeVariance = 0;
    for (int i = 0; i < m; ++i) {
        centered[i] = logLen2[i] - logMean;
        edgeVariance += centered[i] * centered[i] / m;
    }

    double logAbsEpsilon = d.logAbsEpsilon > 0 ? d.logAbsEpsilon : 0.25;
    double edgeSmoothLogAbs = 0;
    std::vector<double> logAbsGrad(m);
    double logAbsGradMean = 0;
    for (int i = 0; i < m; ++i) {
        double s = std::sqrt(centered[i]*centered[i] + logAbsEpsilon*logAbsEpsilon);
        edgeSmoothLogAbs += (s - logAbsEpsilon) / m;
        logAbsGrad[i] = centered[i] / s;
        logAbsGradMean += logAbsGrad[i];
    }
    logAbsGradMean /= m;

    double edgeSoftRange = 0;
    std::vector<double> rangePos(m, 0), rangeNeg(m, 0);
    double rangeBeta = d.rangeBeta > 0 ? d.rangeBeta : 6;
    if (m > 0) {
        double maxScaled = -std::numeric_limits<double>::infinity();
        double maxNegScaled = -std::numeric_limits<double>::infinity();
        for (int i = 0; i < m; ++i) {
            double s = rangeBeta * logLen2[i];
            double ns = -s;
            if (s > maxScaled) maxScaled = s;
            if (ns > maxNegScaled) maxNegScaled = ns;
        }
        double posSum = 0, negSum = 0;
        for (int i = 0; i < m; ++i) {
            rangePos[i] = std::exp(rangeBeta * logLen2[i] - maxScaled);
            rangeNeg[i] = std::exp(-rangeBeta * logLen2[i] - maxNegScaled);
            posSum += rangePos[i]; negSum += rangeNeg[i];
        }
        edgeSoftRange = (std::log(posSum) + maxScaled) / rangeBeta - (std::log(negSum) + maxNegScaled) / rangeBeta;
        for (int i = 0; i < m; ++i) { rangePos[i] /= posSum; rangeNeg[i] /= negSum; }
    }

    double edgeObjective = edgeVariance + d.rangeWeight * edgeSoftRange + d.logAbsWeight * edgeSmoothLogAbs;
    for (int i = 0; i < m; ++i) {
        int u = d.objectiveEdges[i].first, v = d.objectiveEdges[i].second;
        double varianceCoeff = (4.0 / m) * centered[i] / len2v[i];
        double rangeCoeff = d.rangeWeight * (2.0 / len2v[i]) * (rangePos[i] - rangeNeg[i]);
        double logAbsCoeff = d.logAbsWeight * (2.0 / (m * len2v[i])) * (logAbsGrad[i] - logAbsGradMean);
        double c = varianceCoeff + rangeCoeff + logAbsCoeff;
        int iu = d.interiorIndexByAug[u], iv = d.interiorIndexByAug[v];
        if (iu >= 0) { zX[iu] += c * dxv[i]; zY[iu] += c * dyv[i]; }
        if (iv >= 0) { zX[iv] -= c * dxv[i]; zY[iv] -= c * dyv[i]; }
    }
    E += edgeObjective;

    if (d.faceBarrierWeight > 0) {
        for (size_t i = 0; i < faceAreas.size(); ++i)
            E -= d.faceBarrierWeight * std::log(faceAreas[i] / d.initialAvgFaceArea);
        for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
            int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
            double coeff = -d.faceBarrierWeight / faceAreas[i];
            double dAxA = 0.5 * (r.y[b] - r.y[c]);
            double dAxB = 0.5 * (r.y[c] - r.y[a]);
            double dAxC = 0.5 * (r.y[a] - r.y[b]);
            double dAyA = 0.5 * (r.x[c] - r.x[b]);
            double dAyB = 0.5 * (r.x[a] - r.x[c]);
            double dAyC = 0.5 * (r.x[b] - r.x[a]);
            int ia = d.interiorIndexByAug[a];
            int ib = d.interiorIndexByAug[b];
            int ic = d.interiorIndexByAug[c];
            if (ia >= 0) { zX[ia] += coeff * dAxA; zY[ia] += coeff * dAyA; }
            if (ib >= 0) { zX[ib] += coeff * dAxB; zY[ib] += coeff * dAyB; }
            if (ic >= 0) { zX[ic] += coeff * dAxC; zY[ic] += coeff * dAyC; }
        }
    }

    auto adj = la::solve_transpose_lu_with_two_rhs(r.factor, zX, zY);
    if (!adj) { R.reason = "EdgeBalancer adjoint solve failed"; return R; }

    std::vector<double> gradVec(d.qSize, 0);
    for (int i = 0; i < nI; ++i) {
        int rowOffset = d.rowStart[i];
        double meanx = 0, meany = 0;
        const auto& nbrs = d.neighborAugIndices[i];
        for (size_t k = 0; k < nbrs.size(); ++k) {
            double w = r.lambda[rowOffset + k];
            meanx += w * r.x[nbrs[k]];
            meany += w * r.y[nbrs[k]];
        }
        for (size_t k = 0; k < nbrs.size(); ++k) {
            int aug = nbrs[k];
            double w = r.lambda[rowOffset + k];
            gradVec[rowOffset + k] = w * (adj->first[i] * (r.x[aug] - meanx) + adj->second[i] * (r.y[aug] - meany));
        }
    }
    double gn = 0;
    for (double v : gradVec) gn += v*v;

    R.ok = true;
    R.E = E;
    R.gradVec = std::move(gradVec);
    R.gradNorm = std::sqrt(gn);
    R.x = std::move(r.x);
    R.y = std::move(r.y);
    R.maxLogDeviation = maxLogDeviation;
    return R;
}

std::vector<double> lbfgs_direction(const std::vector<double>& g,
                                    const std::vector<std::vector<double>>& S,
                                    const std::vector<std::vector<double>>& Y,
                                    const std::vector<double>& Rho) {
    int m = (int)S.size();
    std::vector<double> alpha(m, 0);
    std::vector<double> q = g;
    for (int i = m-1; i >= 0; --i) {
        double dot = 0;
        for (size_t j = 0; j < q.size(); ++j) dot += S[i][j] * q[j];
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
        double dot = 0;
        for (size_t j = 0; j < r.size(); ++j) dot += Y[i][j] * r[j];
        double beta = Rho[i] * dot;
        for (size_t j = 0; j < r.size(); ++j) r[j] += (alpha[i] - beta) * S[i][j];
    }
    for (auto& v : r) v = -v;
    return r;
}

double vec_norm(const std::vector<double>& v) {
    double s = 0; for (double x : v) s += x*x; return std::sqrt(s);
}

double vec_dot(const std::vector<double>& a, const std::vector<double>& b) {
    double s = 0; for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i]; return s;
}

std::unordered_map<std::string,Point> build_outer_positions(const preprocessing::PreparedGraph& prep) {
    TutteOuterPlacement opts;
    auto full_pos = place_outer_face_vertices(prep.augmented_node_ids, prep.augmented_outer_face, opts);
    std::unordered_map<std::string,Point> out;
    for (const auto& f : prep.augmented_outer_face) {
        auto it = full_pos.find(f);
        if (it != full_pos.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1]))
            out[f] = it->second;
    }
    return out;
}

} // namespace

LayoutResult edgebalancer(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    Config cfg;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "EdgeBalancer layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "EdgeBalancer failed" : prep.message; return r; }
    auto outer_pos = build_outer_positions(prep);
    auto build = build_data(prep.augmented_edge_pairs, prep.augmented_embedding, prep.augmented_outer_face,
                            outer_pos, prep.edge_pairs, cfg.augmentedEdgeWeight, cfg);
    if (!build.ok) { r.ok = false; r.message = build.reason; return r; }
    auto& d = build.data;

    auto weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);
    std::vector<double> q0;
    if (!build_initial_seed(d, weights, q0)) {
        r.ok = false; r.message = "EdgeBalancer initialization requires positive Tutte weights"; return r;
    }
    auto baseline = init_baseline(d, q0);
    if (!baseline.ok) { r.ok = false; r.message = "EdgeBalancer initialization failed"; return r; }
    d.minFaceArea = std::max(0.0, cfg.minFaceAreaFactor * d.initialMinFaceArea);

    PositionMap pm_scale;
    pm_scale.resize((int)prep.augmented_node_ids.size());
    for (int i = 0; i < (int)prep.augmented_node_ids.size(); ++i) {
        auto it = baseline.positions.find(prep.augmented_node_ids[i]);
        if (it != baseline.positions.end()) pm_scale.put(i, it->second[0], it->second[1]);
    }
    double movement_scale = geo::compute_drawing_diameter((int)prep.augmented_node_ids.size(), pm_scale);
    double maxPositionStep = cfg.maxPositionStepRatio * movement_scale;
    gh::MovementTrackerConfig tcfg;
    tcfg.min_iters_before_stop = cfg.minItersBeforeStop;
    tcfg.stable_iter_limit = cfg.stableIterLimit;
    tcfg.max_move_tol = cfg.movementStopTol * movement_scale;
    tcfg.avg_move_tol = cfg.avgMovementStopTol * movement_scale;
    gh::MovementTracker tracker(tcfg);

    std::vector<double> q = q0;
    auto current = evaluate(q, d);
    if (!current.ok) { r.ok = false; r.message = current.reason; return r; }

    std::vector<std::vector<double>> S, Y;
    std::vector<double> Rho;
    std::string stopReason = "max-iters";
    int completed = 0;

    for (int iter = 1; iter <= cfg.maxIters; ++iter) {
        if (current.gradNorm <= cfg.gradTol) { stopReason = "grad-converged"; break; }
        auto prev_x = current.x;
        auto prev_y = current.y;
        auto dir = lbfgs_direction(current.gradVec, S, Y, Rho);
        if (!(vec_dot(current.gradVec, dir) < 0)) {
            dir.assign(current.gradVec.size(), 0);
            for (size_t j = 0; j < current.gradVec.size(); ++j) dir[j] = -current.gradVec[j];
        }
        double dnorm = vec_norm(dir);
        if (dnorm > cfg.maxStepNorm) for (auto& v : dir) v *= cfg.maxStepNorm / dnorm;

        double gtd = vec_dot(current.gradVec, dir);
        bool accepted = false;
        std::vector<double> q_trial;
        EvalResult trial;
        for (int ls_attempt = 0; ls_attempt < 2 && !accepted; ++ls_attempt) {
            std::vector<double> searchDir = dir;
            if (ls_attempt == 1) {
                searchDir.assign(current.gradVec.size(), 0);
                for (size_t j = 0; j < current.gradVec.size(); ++j) searchDir[j] = -current.gradVec[j];
                double dn = vec_norm(searchDir);
                if (dn > cfg.maxStepNorm) for (auto& v : searchDir) v *= cfg.maxStepNorm / dn;
                gtd = vec_dot(current.gradVec, searchDir);
                if (!(gtd < 0)) break;
                if (!S.empty()) { S.clear(); Y.clear(); Rho.clear(); }
            }
            double alpha = 1.0;
            while (alpha >= 1e-12) {
                q_trial.assign(q.size(), 0);
                for (size_t j = 0; j < q.size(); ++j) q_trial[j] = q[j] + alpha * searchDir[j];
                trial = evaluate(q_trial, d);
                if (trial.ok) {
                    auto dist_fn = [&](int aug_idx, int) {
                        return std::hypot(trial.x[aug_idx] - current.x[aug_idx], trial.y[aug_idx] - current.y[aug_idx]);
                    };
                    auto tms = gh::compute_move_stats(d.interiorAugIndices, dist_fn, 1e-9);
                    if (tms.max_move > maxPositionStep) { alpha *= cfg.lineSearchTau; continue; }
                }
                if (trial.ok && trial.E <= current.E + cfg.lineSearchC1 * alpha * gtd) {
                    accepted = true;
                    break;
                }
                alpha *= cfg.lineSearchTau;
            }
        }
        if (!accepted) { stopReason = "line-search-failed"; break; }

        std::vector<double> s_vec(q.size()), y_vec(q.size());
        for (size_t j = 0; j < q.size(); ++j) { s_vec[j] = q_trial[j] - q[j]; y_vec[j] = trial.gradVec[j] - current.gradVec[j]; }
        double step_norm = vec_norm(s_vec);
        q = q_trial;
        current = trial;
        completed = iter;

        auto dist_fn = [&](int aug_idx, int) {
            return std::hypot(current.x[aug_idx] - prev_x[aug_idx], current.y[aug_idx] - prev_y[aug_idx]);
        };
        auto ms = gh::compute_move_stats(d.interiorAugIndices, dist_fn, 1e-9);
        auto status = tracker.update(ms, iter);
        if (status.converged) { stopReason = status.reason.empty() ? "movement-converged" : status.reason; break; }
        if (step_norm < cfg.stepTol) { stopReason = "step-converged"; break; }

        double ys = vec_dot(y_vec, s_vec);
        if (ys > 1e-14) {
            if ((int)S.size() == cfg.lbfgsMemory) { S.erase(S.begin()); Y.erase(Y.begin()); Rho.erase(Rho.begin()); }
            S.push_back(s_vec);
            Y.push_back(y_vec);
            Rho.push_back(1.0 / ys);
        }
    }

    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = std::find(d.augIds.begin(), d.augIds.end(), g.node_names[i]);
        if (it == d.augIds.end()) continue;
        int idx = (int)(it - d.augIds.begin());
        if (std::isfinite(current.x[idx]) && std::isfinite(current.y[idx]))
            r.positions.put(i, current.x[idx], current.y[idx]);
    }
    if (geo::has_position_crossings(r.positions, g.edges)) {
        r.ok = false;
        r.message = "EdgeBalancer produced a non-plane drawing";
        return r;
    }
    r.ok = true;
    r.iters = completed;
    r.stop_reason = stopReason;
    r.message = "EdgeBalancer layout";
    return r;
}

} // namespace planarvibe::layouts
