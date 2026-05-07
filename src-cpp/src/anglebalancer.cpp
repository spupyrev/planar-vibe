// AngleBalancer L-BFGS layout. Literal port of static/js/layout-anglebalancer.js.

#include "layouts/anglebalancer.hpp"
#include "layouts/tutte.hpp"

#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "linear_algebra.hpp"
#include "planarity.hpp"
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
    double wedgeTol = 1e-8;
    double angleBarrierWeight = 0.5;
    double minRatioWeight = 0.25;
    double minRatioBeta = 10;
    double faceBarrierWeight = 0.02;
    double minFaceAreaFactor = 0.2;
    double gradTol = 1e-5;
    double stepTol = 1e-10;
    int lbfgsMemory = 10;
    double maxStepNorm = 2.0;
    double lineSearchC1 = 1e-4;
    double lineSearchTau = 0.5;
    int maxIters = 200;
    int minItersBeforeStop = 40;
    int stableIterLimit = 8;
    double movementStopTol = 1e-6;
    double avgMovementStopTol = 2e-7;
    double maxPositionStepRatio = 0.01;
};

constexpr double TWO_PI = 2.0 * M_PI;

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

// Wedge: [centerAugIdx, leftAugIdx, rightAugIdx, targetAngle, vertexIdx]
struct Wedge { int center, left, right; double targetAngle; int vertexIdx; };

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
    std::vector<std::pair<int,int>> edges;
    double areaTol = 0, angleTol = 1e-8;
    double angleBarrierWeight = 0, minRatioWeight = 0, minRatioBeta = 10;
    double faceBarrierWeight = 0;
    double edgeBarrierScale2 = 1, initialAvgFaceArea = 1, initialMinFaceArea = 0, minFaceArea = 0;
    std::vector<std::string> objectiveVertexIds;
    std::vector<int> wedgeStart;
    std::vector<int> wedgeCount;
    std::vector<Wedge> wedges;
    // Caller provides objective graph + base embedding
    const Graph* objectiveGraph = nullptr;
    std::vector<std::string> baseIds;
    std::unordered_map<std::string,int> baseIndexById;
    std::vector<std::vector<std::string>> baseRotation;
};

struct BuildResult { bool ok = false; std::string reason; Data data; };

BuildResult build_data(const std::vector<std::pair<std::string,std::string>>& aug_edges,
                       const planarity::StringEmbedding& aug_emb,
                       const std::vector<std::string>& outer_face,
                       const std::unordered_map<std::string, Point>& outer_pos,
                       const Graph& objective_graph,
                       const planarity::StringEmbedding& base_emb,
                       const Config& cfg) {
    BuildResult R;
    auto& d = R.data;
    d.augIds = aug_emb.id_by_index;
    int nA = (int)d.augIds.size();
    for (int i = 0; i < nA; ++i) d.augIndexById[d.augIds[i]] = i;

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
        d.edges.emplace_back(ia->second, ib->second);
    }
    std::string outer_key = face_key_of(outer_face);
    for (const auto& rawFace : aug_emb.faces) {
        if (face_key_of(rawFace) == outer_key) continue;
        if (rawFace.size() < 3) { R.reason = "AngleBalancer requires a valid triangulated augmentation"; return R; }
        if (rawFace.size() != 3) { R.reason = "AngleBalancer requires all non-outer augmented faces to be triangles"; return R; }
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

    d.baseIds = base_emb.id_by_index;
    for (int i = 0; i < (int)d.baseIds.size(); ++i) d.baseIndexById[d.baseIds[i]] = i;
    d.baseRotation = base_emb.rotation;
    d.objectiveGraph = &objective_graph;

    d.areaTol = cfg.areaTol;
    d.angleTol = cfg.wedgeTol;
    d.angleBarrierWeight = std::max(0.0, cfg.angleBarrierWeight);
    d.minRatioWeight = std::max(0.0, cfg.minRatioWeight);
    d.minRatioBeta = cfg.minRatioBeta;
    d.faceBarrierWeight = std::max(0.0, cfg.faceBarrierWeight);
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
    double edgeScaleSum = 0;
    int edgeScaleCount = 0;
    for (const auto& e : d.edges) {
        double dx = r.x[e.first] - r.x[e.second];
        double dy = r.y[e.first] - r.y[e.second];
        double l2 = dx*dx + dy*dy;
        if (l2 > 1e-12) { edgeScaleSum += l2; ++edgeScaleCount; }
    }
    d.edgeBarrierScale2 = edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1;
    double minA = std::numeric_limits<double>::infinity();
    double sumA = 0; int cntA = 0;
    for (auto& face : d.boundedFaces) {
        if (polygon_area2(face, r.x, r.y) < 0) std::reverse(face.begin(), face.end());
        double a = std::abs(polygon_area2(face, r.x, r.y)) / 2;
        if (a > 1e-12) { sumA += a; ++cntA; if (a < minA) minA = a; }
    }
    d.initialAvgFaceArea = cntA > 0 ? (sumA / cntA) : 1;
    d.initialMinFaceArea = std::isfinite(minA) ? minA : 0;

    // Build wedges from objective graph + base embedding.
    d.objectiveVertexIds.clear();
    d.wedgeStart.clear();
    d.wedgeCount.clear();
    d.wedges.clear();
    for (int i = 0; i < d.objectiveGraph->n; ++i) {
        const std::string& centerId = d.objectiveGraph->node_names[i];
        auto itBase = d.baseIndexById.find(centerId);
        auto itAug = d.augIndexById.find(centerId);
        if (itBase == d.baseIndexById.end() || itAug == d.augIndexById.end()) continue;
        int centerBaseIdx = itBase->second;
        int centerAugIdx = itAug->second;
        const auto& objRot = (centerBaseIdx < (int)d.baseRotation.size())
                             ? d.baseRotation[centerBaseIdx]
                             : std::vector<std::string>{};
        if (objRot.size() < 2) continue;
        std::vector<int> objNbrs;
        for (const auto& n : objRot) {
            auto it = d.augIndexById.find(n);
            if (it != d.augIndexById.end()) objNbrs.push_back(it->second);
        }
        if (objNbrs.size() < 2) continue;
        double targetAngle = TWO_PI / objNbrs.size();
        d.wedgeStart.push_back((int)d.wedges.size());
        d.wedgeCount.push_back((int)objNbrs.size());
        d.objectiveVertexIds.push_back(centerId);
        int vertexIdx = (int)d.objectiveVertexIds.size() - 1;
        for (size_t k = 0; k < objNbrs.size(); ++k) {
            int left = objNbrs[k];
            int right = objNbrs[(k + 1) % objNbrs.size()];
            d.wedges.push_back({centerAugIdx, left, right, targetAngle, vertexIdx});
        }
    }

    for (int i = 0; i < (int)d.augIds.size(); ++i) R.positions[d.augIds[i]] = {r.x[i], r.y[i]};
    R.ok = true;
    return R;
}

struct WedgeEval {
    bool ok = false;
    double angle;
    double gradCenterX, gradCenterY;
    double gradLeftX, gradLeftY;
    double gradRightX, gradRightY;
};

WedgeEval compute_wedge(int center, int left, int right,
                        const std::vector<double>& x, const std::vector<double>& y,
                        double angleTol) {
    WedgeEval W;
    double ux = x[left] - x[center];
    double uy = y[left] - y[center];
    double vx = x[right] - x[center];
    double vy = y[right] - y[center];
    double lenU2 = ux*ux + uy*uy;
    double lenV2 = vx*vx + vy*vy;
    double lenTol2 = std::max(1e-24, angleTol*angleTol);
    if (!(lenU2 > lenTol2) || !(lenV2 > lenTol2)) return W;
    double cross = ux*vy - uy*vx;
    double dot = ux*vx + uy*vy;
    double angle = std::atan2(cross, dot);
    if (!(angle > 0)) angle += TWO_PI;
    if (!(angle > angleTol)) return W;
    double denom = lenU2 * lenV2;
    if (!(denom > 1e-24) || !std::isfinite(denom)) return W;
    double gradUx = (dot * vy - cross * vx) / denom;
    double gradUy = (-dot * vx - cross * vy) / denom;
    double gradVx = (-dot * uy - cross * ux) / denom;
    double gradVy = (dot * ux - cross * uy) / denom;
    W.ok = true;
    W.angle = angle;
    W.gradCenterX = -gradUx - gradVx;
    W.gradCenterY = -gradUy - gradVy;
    W.gradLeftX = gradUx;
    W.gradLeftY = gradUy;
    W.gradRightX = gradVx;
    W.gradRightY = gradVy;
    return W;
}

void add_point_gradient(const Data& d, int augIdx, double gx, double gy,
                        std::vector<double>& zX, std::vector<double>& zY) {
    int idx = d.interiorIndexByAug[augIdx];
    if (idx >= 0) { zX[idx] += gx; zY[idx] += gy; }
}

struct EvalResult {
    bool ok = false; std::string reason;
    double E = 0;
    std::vector<double> gradVec;
    double gradNorm = 0;
    std::vector<double> x, y;
    double maxAngleResidual = 0;
    double minAngleRatio = 0;
};

EvalResult evaluate(const std::vector<double>& q, const Data& d) {
    EvalResult R;
    double triangleSlack = std::max(d.areaTol, 1e-12);
    int nI = (int)d.interiorAugIndices.size();
    auto r = realize_state(q, d);
    if (!r.ok) { R.reason = "AngleBalancer linear solve failed"; return R; }

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

    std::vector<double> zX(nI, 0), zY(nI, 0);
    double E = 0;

    // Angle objective terms.
    int wedgeCount = (int)d.wedges.size();
    if (!(wedgeCount > 0)) { R.reason = "AngleBalancer requires at least one valid objective angle"; return R; }
    double vertexWeightScale = d.objectiveVertexIds.empty()
                               ? (1.0 / wedgeCount)
                               : (1.0 / d.objectiveVertexIds.size());
    double maxAngleResidual = 0;
    double minAngleRatio = std::numeric_limits<double>::infinity();
    bool useMinRatio = d.minRatioWeight > 0;
    double minRatioBeta = d.minRatioBeta > 0 ? d.minRatioBeta : 10;
    std::vector<double> minRatioVertexMax(d.objectiveVertexIds.size(),
                                           -std::numeric_limits<double>::infinity());
    std::vector<double> minRatioVertexSum(d.objectiveVertexIds.size(), 0);
    std::vector<WedgeEval> wedgeEvals(wedgeCount);
    std::vector<double> wedgeRatios(wedgeCount, 0);
    std::vector<double> wedgeResiduals(wedgeCount, 0);

    for (int i = 0; i < wedgeCount; ++i) {
        const auto& w = d.wedges[i];
        auto ev = compute_wedge(w.center, w.left, w.right, r.x, r.y, d.angleTol);
        if (!ev.ok) { R.reason = "invalid-angle-step"; return R; }
        double ratio = ev.angle / w.targetAngle;
        if (!(ratio > 0) || !std::isfinite(ratio)) { R.reason = "invalid-angle-step"; return R; }
        wedgeEvals[i] = ev;
        wedgeRatios[i] = ratio;
        wedgeResiduals[i] = ratio - 1;
        double absRes = std::abs(wedgeResiduals[i]);
        if (absRes > maxAngleResidual) maxAngleResidual = absRes;
        if (ratio < minAngleRatio) minAngleRatio = ratio;
        if (useMinRatio) {
            double scaled = minRatioBeta * (1 - ratio);
            if (scaled > minRatioVertexMax[w.vertexIdx]) minRatioVertexMax[w.vertexIdx] = scaled;
        }
    }
    if (useMinRatio) {
        for (int i = 0; i < wedgeCount; ++i) {
            const auto& w = d.wedges[i];
            minRatioVertexSum[w.vertexIdx] += std::exp(minRatioBeta * (1 - wedgeRatios[i]) - minRatioVertexMax[w.vertexIdx]);
        }
    }

    double angleObjective = 0;
    for (int i = 0; i < wedgeCount; ++i) {
        const auto& w = d.wedges[i];
        const auto& ev = wedgeEvals[i];
        double ratio = wedgeRatios[i];
        double residual = wedgeResiduals[i];
        double weightScale = vertexWeightScale / std::max(1, d.wedgeCount[w.vertexIdx]);
        angleObjective += weightScale * residual * residual;
        double coeff = weightScale * (2 * residual / w.targetAngle);
        if (d.angleBarrierWeight > 0) {
            angleObjective -= weightScale * d.angleBarrierWeight * std::log(ratio);
            coeff -= weightScale * d.angleBarrierWeight / ev.angle;
        }
        if (useMinRatio) {
            double vertexSoftMinWeight = vertexWeightScale * d.minRatioWeight;
            double minRatioSum = minRatioVertexSum[w.vertexIdx];
            if (minRatioSum > 0) {
                if (i == d.wedgeStart[w.vertexIdx]) {
                    angleObjective += vertexSoftMinWeight *
                        ((std::log(minRatioSum) + minRatioVertexMax[w.vertexIdx]) / minRatioBeta);
                }
                double softMinShare = std::exp(minRatioBeta * (1 - ratio) - minRatioVertexMax[w.vertexIdx]) / minRatioSum;
                coeff -= vertexSoftMinWeight * softMinShare / w.targetAngle;
            }
        }
        add_point_gradient(d, w.center, coeff * ev.gradCenterX, coeff * ev.gradCenterY, zX, zY);
        add_point_gradient(d, w.left, coeff * ev.gradLeftX, coeff * ev.gradLeftY, zX, zY);
        add_point_gradient(d, w.right, coeff * ev.gradRightX, coeff * ev.gradRightY, zX, zY);
    }
    E += angleObjective;

    if (d.faceBarrierWeight > 0) {
        for (double fa : faceAreas) E -= d.faceBarrierWeight * std::log(fa / d.initialAvgFaceArea);
        for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
            int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
            double coeff = -d.faceBarrierWeight / faceAreas[i];
            double dAxA = 0.5 * (r.y[b] - r.y[c]);
            double dAxB = 0.5 * (r.y[c] - r.y[a]);
            double dAxC = 0.5 * (r.y[a] - r.y[b]);
            double dAyA = 0.5 * (r.x[c] - r.x[b]);
            double dAyB = 0.5 * (r.x[a] - r.x[c]);
            double dAyC = 0.5 * (r.x[b] - r.x[a]);
            add_point_gradient(d, a, coeff * dAxA, coeff * dAyA, zX, zY);
            add_point_gradient(d, b, coeff * dAxB, coeff * dAyB, zX, zY);
            add_point_gradient(d, c, coeff * dAxC, coeff * dAyC, zX, zY);
        }
    }

    auto adj = la::solve_transpose_lu_with_two_rhs(r.factor, zX, zY);
    if (!adj) { R.reason = "AngleBalancer adjoint solve failed"; return R; }

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
    R.maxAngleResidual = maxAngleResidual;
    R.minAngleRatio = minAngleRatio;
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

LayoutResult anglebalancer(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    Config cfg;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "AngleBalancer layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "AngleBalancer failed" : prep.message; return r; }

    auto outer_pos = build_outer_positions(prep);
    auto build = build_data(prep.augmented_edge_pairs, prep.augmented_embedding, prep.augmented_outer_face,
                            outer_pos, g, prep.base_embedding, cfg);
    if (!build.ok) { r.ok = false; r.message = build.reason; return r; }
    auto& d = build.data;

    auto weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);
    std::vector<double> q0;
    if (!build_initial_seed(d, weights, q0)) {
        r.ok = false; r.message = "AngleBalancer initialization requires positive Tutte weights"; return r;
    }
    auto baseline = init_baseline(d, q0);
    if (!baseline.ok) { r.ok = false; r.message = "AngleBalancer initialization failed"; return r; }
    d.minFaceArea = std::max(0.0, cfg.minFaceAreaFactor * d.initialMinFaceArea);

    // No objective angles? Return baseline filtered to original.
    if (d.objectiveVertexIds.empty() || d.wedges.empty()) {
        r.positions.resize(g.n);
        for (int i = 0; i < g.n; ++i) {
            auto it = baseline.positions.find(g.node_names[i]);
            if (it != baseline.positions.end()) r.positions.put(i, it->second[0], it->second[1]);
        }
        r.ok = true;
        r.message = "AngleBalancer (no objective angles)";
        return r;
    }

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
        r.message = "AngleBalancer produced a non-plane drawing";
        return r;
    }
    r.ok = true;
    r.iters = completed;
    r.stop_reason = stopReason;
    r.message = "AngleBalancer layout";
    return r;
}

} // namespace planarvibe::layouts
