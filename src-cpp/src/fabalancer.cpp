// FABalancer staged layout: face-warm -> angle -> axis-align.
// Literal port of static/js/layout-fabalancer.js.

#include "layouts/fabalancer.hpp"
#include "layouts/tutte.hpp"

#include "alignment.hpp"
#include "geometry.hpp"
#include "graph_helpers.hpp"
#include "linear_algebra.hpp"
#include "preprocessing.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

namespace planarvibe::layouts {

namespace {

constexpr double TWO_PI = 2.0 * M_PI;

struct StageCfg {
    int maxIters;
    int minItersBeforeStop;
    int stableIterLimit;
    double maxPositionStepRatio;
    double minFaceAreaFactor;
    double faceBarrierWeight;
    double edgeBarrierWeight;
    double edgeUniformWeight;
    double faceWeight;
    double angleWeight;
    double angleBarrierWeight;
    double minRatioWeight;
    double minRatioBeta;
    double horizontalityWeight;
};

struct Config {
    double areaTol = 1e-15;
    double angleTol = 1e-8;
    double gradTol = 1e-5;
    double stepTol = 1e-10;
    double maxStepNorm = 2.0;
    int lbfgsMemory = 10;
    double lineSearchC1 = 1e-4;
    double lineSearchTau = 0.5;
    double lineSearchAcceptTol = 5e-9;
    double movementStopTol = 1e-6;
    double avgMovementStopTol = 2e-7;
    int alignMaxPasses = 3;
    StageCfg faceWarmStage = {20, 20, 6, 0.02, 0.25, 0.2, 0.05, 0.02, 1.0, 0.0, 0.0, 0.0, 10, 0.0};
    StageCfg angleStage = {180, 40, 8, 0.01, 0.2, 0.02, 0.005, 0.002, 0.0, 1.0, 0.5, 0.0, 10, 0.5};
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
    double sum = 0; int n = (int)face.size();
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
    for (int i = 0; i < length; ++i) { double w = std::exp(q[start+i] - m); out[start+i] = w; Z += w; }
    if (!(Z > 0)) { double u = 1.0 / std::max(1, length); for (int i = 0; i < length; ++i) out[start+i] = u; return; }
    for (int i = 0; i < length; ++i) out[start+i] /= Z;
}

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
    std::vector<std::string> objectiveVertexIds;
    std::vector<int> wedgeStart;
    std::vector<int> wedgeCount;
    std::vector<Wedge> wedges;
    std::vector<std::pair<int,int>> objectiveEdges;
    double areaTol = 0, angleTol = 1e-8;
    double angleBarrierWeight = 0, minRatioWeight = 0, minRatioBeta = 10;
    double faceBarrierWeight = 0, horizontalityWeight = 0;
    double edgeBarrierWeight = 0, edgeUniformWeight = 0;
    double minFaceArea = 0;
    double faceWeight = 0, angleWeight = 0;
    double edgeBarrierScale2 = 1, initialAvgFaceArea = 1, initialMinFaceArea = 0;
};

struct BuildRes { bool ok = false; std::string reason; Data data; };

BuildRes build_data(const std::vector<std::pair<std::string,std::string>>& aug_edges,
                    const planarity::StringEmbedding& aug_emb,
                    const std::vector<std::string>& outer_face,
                    const std::unordered_map<std::string, Point>& outer_pos,
                    const Graph& objective_graph,
                    const planarity::StringEmbedding& base_emb,
                    const Config& cfg, const StageCfg& stage) {
    BuildRes R;
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
        auto ia = d.augIndexById.find(a), ib = d.augIndexById.find(b);
        if (ia == d.augIndexById.end() || ib == d.augIndexById.end()) continue;
        if (ia->second == ib->second) continue;
        d.edges.emplace_back(ia->second, ib->second);
    }
    std::string outer_key = face_key_of(outer_face);
    for (const auto& rawFace : aug_emb.faces) {
        if (face_key_of(rawFace) == outer_key) continue;
        if (rawFace.size() < 3) { R.reason = "FABalancer requires a valid triangulated augmentation"; return R; }
        if (rawFace.size() != 3) { R.reason = "FABalancer requires all non-outer augmented faces to be triangles"; return R; }
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
    std::unordered_map<std::string,int> baseIndexById;
    for (int i = 0; i < (int)base_emb.id_by_index.size(); ++i) baseIndexById[base_emb.id_by_index[i]] = i;
    // Wedges from objective graph + base embedding.
    for (int i = 0; i < objective_graph.n; ++i) {
        const std::string& centerId = objective_graph.node_names[i];
        auto itBase = baseIndexById.find(centerId);
        auto itAug = d.augIndexById.find(centerId);
        if (itBase == baseIndexById.end() || itAug == d.augIndexById.end()) continue;
        int centerBaseIdx = itBase->second;
        int centerAugIdx = itAug->second;
        const auto& objRot = (centerBaseIdx < (int)base_emb.rotation.size())
                             ? base_emb.rotation[centerBaseIdx]
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
    // Objective edges from objective graph's pairs.
    for (int i = 0; i < (int)objective_graph.edges.size(); ++i) {
        const auto& [u, v] = objective_graph.edges[i];
        auto ia = d.augIndexById.find(objective_graph.node_names[u]);
        auto ib = d.augIndexById.find(objective_graph.node_names[v]);
        if (ia == d.augIndexById.end() || ib == d.augIndexById.end()) continue;
        if (ia->second == ib->second) continue;
        d.objectiveEdges.emplace_back(ia->second, ib->second);
    }
    d.areaTol = cfg.areaTol;
    d.angleTol = cfg.angleTol;
    d.angleBarrierWeight = stage.angleBarrierWeight;
    d.minRatioWeight = std::max(0.0, stage.minRatioWeight);
    d.minRatioBeta = stage.minRatioBeta;
    d.faceBarrierWeight = stage.faceBarrierWeight;
    d.horizontalityWeight = stage.horizontalityWeight;
    d.edgeBarrierWeight = stage.edgeBarrierWeight;
    d.edgeUniformWeight = stage.edgeUniformWeight;
    d.faceWeight = stage.faceWeight;
    d.angleWeight = stage.angleWeight;
    R.ok = true;
    return R;
}

bool build_initial_seed(const Data& d, const std::unordered_map<std::string,double>& weights,
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

// Mean-value warm start from positions.
bool build_initial_seed_from_positions(const Data& d,
                                       const std::unordered_map<std::string, Point>& pos,
                                       std::vector<double>& q0) {
    q0.assign(d.qSize, 0);
    int nA = (int)d.augIds.size();
    std::vector<double> x(nA), y(nA);
    for (int i = 0; i < nA; ++i) {
        auto it = pos.find(d.augIds[i]);
        if (it != pos.end()) { x[i] = it->second[0]; y[i] = it->second[1]; }
        else { x[i] = d.x0[i]; y[i] = d.y0[i]; }
    }
    int nI = (int)d.interiorAugIndices.size();
    for (int i = 0; i < nI; ++i) {
        int augIdx = d.interiorAugIndices[i];
        int rowOffset = d.rowStart[i];
        const auto& nbrs = d.neighborAugIndices[i];
        if (nbrs.empty()) continue;
        struct V { double vx, vy, len; };
        std::vector<V> vectors(nbrs.size());
        for (size_t k = 0; k < nbrs.size(); ++k) {
            double vx = x[nbrs[k]] - x[augIdx];
            double vy = y[nbrs[k]] - y[augIdx];
            double l = std::hypot(vx, vy);
            if (!(l > 1e-12)) return false;
            vectors[k] = {vx, vy, l};
        }
        std::vector<double> angles(nbrs.size());
        for (size_t k = 0; k < nbrs.size(); ++k) {
            size_t nxt = (k + 1) % nbrs.size();
            double cr = vectors[k].vx * vectors[nxt].vy - vectors[k].vy * vectors[nxt].vx;
            double dt = vectors[k].vx * vectors[nxt].vx + vectors[k].vy * vectors[nxt].vy;
            double th = std::atan2(cr, dt);
            if (!(th > 0)) th += TWO_PI;
            if (!(th > 1e-8)) return false;
            angles[k] = th;
        }
        std::vector<double> wk(nbrs.size());
        double sum = 0;
        for (size_t k = 0; k < nbrs.size(); ++k) {
            size_t prev = (k + nbrs.size() - 1) % nbrs.size();
            double w = (std::tan(angles[prev] / 2) + std::tan(angles[k] / 2)) / vectors[k].len;
            if (!(w > 0) || !std::isfinite(w)) return false;
            wk[k] = w;
            sum += w;
        }
        if (!(sum > 0)) return false;
        for (size_t k = 0; k < nbrs.size(); ++k) q0[rowOffset + k] = std::log(wk[k] / sum);
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
    double edgeScaleSum = 0; int edgeScaleCount = 0;
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
    for (int i = 0; i < (int)d.augIds.size(); ++i) R.positions[d.augIds[i]] = {r.x[i], r.y[i]};
    R.ok = true;
    return R;
}

void add_point_gradient(const Data& d, int augIdx, double gx, double gy,
                        std::vector<double>& zX, std::vector<double>& zY) {
    int idx = d.interiorIndexByAug[augIdx];
    if (idx >= 0) { zX[idx] += gx; zY[idx] += gy; }
}

struct WedgeEval {
    bool ok = false;
    double angle;
    double gradCenterX, gradCenterY, gradLeftX, gradLeftY, gradRightX, gradRightY;
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
    double cr = ux*vy - uy*vx;
    double dt = ux*vx + uy*vy;
    double angle = std::atan2(cr, dt);
    if (!(angle > 0)) angle += TWO_PI;
    if (!(angle > angleTol)) return W;
    double denom = lenU2 * lenV2;
    if (!(denom > 1e-24) || !std::isfinite(denom)) return W;
    double gradUx = (dt * vy - cr * vx) / denom;
    double gradUy = (-dt * vx - cr * vy) / denom;
    double gradVx = (-dt * uy - cr * ux) / denom;
    double gradVy = (dt * ux - cr * uy) / denom;
    W.ok = true;
    W.angle = angle;
    W.gradCenterX = -gradUx - gradVx;
    W.gradCenterY = -gradUy - gradVy;
    W.gradLeftX = gradUx; W.gradLeftY = gradUy;
    W.gradRightX = gradVx; W.gradRightY = gradVy;
    return W;
}

struct AngleObjResult { bool ok = false; std::string reason; double angleObjectiveTerm = 0; };

AngleObjResult evaluate_angle_terms(const Data& d, const std::vector<double>& x, const std::vector<double>& y,
                                    std::vector<double>& zX, std::vector<double>& zY) {
    AngleObjResult R;
    int wedgeCount = (int)d.wedges.size();
    if (!(wedgeCount > 0)) { R.reason = "FABalancer requires at least one valid objective angle"; return R; }
    double vertexWeightScale = d.objectiveVertexIds.empty()
                               ? (1.0 / wedgeCount) : (1.0 / d.objectiveVertexIds.size());
    bool useMinRatio = d.minRatioWeight > 0;
    double minRatioBeta = d.minRatioBeta > 0 ? d.minRatioBeta : 10;
    std::vector<double> minRatioVertexMax(d.objectiveVertexIds.size(),
                                           -std::numeric_limits<double>::infinity());
    std::vector<double> minRatioVertexSum(d.objectiveVertexIds.size(), 0);
    std::vector<WedgeEval> wedgeEvals(wedgeCount);
    std::vector<double> wedgeRatios(wedgeCount);
    std::vector<double> wedgeResiduals(wedgeCount);

    for (int i = 0; i < wedgeCount; ++i) {
        const auto& w = d.wedges[i];
        auto ev = compute_wedge(w.center, w.left, w.right, x, y, d.angleTol);
        if (!ev.ok) { R.reason = "invalid-angle-step"; return R; }
        double ratio = ev.angle / w.targetAngle;
        if (!(ratio > 0) || !std::isfinite(ratio)) { R.reason = "invalid-angle-step"; return R; }
        wedgeEvals[i] = ev;
        wedgeRatios[i] = ratio;
        wedgeResiduals[i] = ratio - 1;
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
    double angleObj = 0;
    for (int i = 0; i < wedgeCount; ++i) {
        const auto& w = d.wedges[i];
        const auto& ev = wedgeEvals[i];
        double ratio = wedgeRatios[i];
        double residual = wedgeResiduals[i];
        double weightScale = vertexWeightScale / std::max(1, d.wedgeCount[w.vertexIdx]);
        angleObj += weightScale * residual * residual;
        double coeff = weightScale * (2 * residual / w.targetAngle);
        if (d.angleBarrierWeight > 0) {
            angleObj -= weightScale * d.angleBarrierWeight * std::log(ratio);
            coeff -= weightScale * d.angleBarrierWeight / ev.angle;
        }
        if (useMinRatio) {
            double vertexSoftMinWeight = vertexWeightScale * d.minRatioWeight;
            double minRatioSum = minRatioVertexSum[w.vertexIdx];
            if (minRatioSum > 0) {
                if (i == d.wedgeStart[w.vertexIdx]) {
                    angleObj += vertexSoftMinWeight *
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
    R.ok = true;
    R.angleObjectiveTerm = angleObj;
    return R;
}

double evaluate_horizontality_terms(const Data& d, const std::vector<double>& x, const std::vector<double>& y,
                                    std::vector<double>& zX, std::vector<double>& zY) {
    if (d.objectiveEdges.empty()) return 0.0;
    double eps2 = std::max(1e-24, d.areaTol);
    double term = 0;
    double weight = 1.0 / d.objectiveEdges.size();
    for (const auto& [u, v] : d.objectiveEdges) {
        double dx = x[v] - x[u];
        double dy = y[v] - y[u];
        double absDy = std::sqrt(dy*dy + eps2);
        double len2 = dx*dx + dy*dy + eps2;
        double len = std::sqrt(len2);
        double penalty = absDy / len;
        double gradDx = -absDy * dx / (len2 * len);
        double gradDy = (dy / (absDy * len)) - (absDy * dy / (len2 * len));
        term += weight * penalty;
        add_point_gradient(d, u, -weight * gradDx, -weight * gradDy, zX, zY);
        add_point_gradient(d, v, weight * gradDx, weight * gradDy, zX, zY);
    }
    return term;
}

struct EvalResult {
    bool ok = false; std::string reason;
    double E = 0;
    std::vector<double> gradVec;
    double gradNorm = 0;
    std::vector<double> x, y;
    double maxRelError = 0;
};

enum class EvalKind { Face, AngleStage };

EvalResult evaluate(const std::vector<double>& q, const Data& d, EvalKind kind) {
    EvalResult R;
    double triangleSlack = std::max(d.areaTol, 1e-12);
    int nI = (int)d.interiorAugIndices.size();
    auto r = realize_state(q, d);
    if (!r.ok) { R.reason = "FABalancer linear solve failed"; return R; }

    std::vector<double> faceAreas(d.boundedFaces.size(), 0);
    double totalArea = 0;
    for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
        int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
        double area = 0.5 * ((r.x[b]-r.x[a])*(r.y[c]-r.y[a]) - (r.x[c]-r.x[a])*(r.y[b]-r.y[a]));
        if (!(area > -triangleSlack)) { R.reason = "invalid-triangulation-step"; return R; }
        faceAreas[i] = area > triangleSlack ? area : triangleSlack;
        totalArea += faceAreas[i];
    }
    for (double fa : faceAreas) if (!(fa > d.minFaceArea)) { R.reason = "invalid-face-step"; return R; }
    for (const auto& face : d.boundedFaces) {
        if (!(polygon_area2(face, r.x, r.y) > 2 * d.areaTol)) { R.reason = "invalid-face-step"; return R; }
    }
    if (kind == EvalKind::Face) {
        if (d.boundedFaces.empty() || !(totalArea > 1e-12)) {
            R.reason = "FABalancer total bounded area is not positive"; return R;
        }
    }

    std::vector<double> zX(nI, 0), zY(nI, 0);
    double E = 0;
    double maxRelError = 0;

    if (kind == EvalKind::AngleStage) {
        auto ae = evaluate_angle_terms(d, r.x, r.y, zX, zY);
        if (!ae.ok) { R.reason = ae.reason; return R; }
        E += ae.angleObjectiveTerm;
        if (d.horizontalityWeight > 0) {
            std::vector<double> hzX(nI, 0), hzY(nI, 0);
            double ht = evaluate_horizontality_terms(d, r.x, r.y, hzX, hzY);
            E += d.horizontalityWeight * ht;
            for (int i = 0; i < nI; ++i) { zX[i] += d.horizontalityWeight * hzX[i]; zY[i] += d.horizontalityWeight * hzY[i]; }
        }
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
    } else {  // Face (face-warm stage)
        // Angle term (conditionally on angleWeight).
        if (d.angleWeight > 0) {
            std::vector<double> azX(nI, 0), azY(nI, 0);
            auto ae = evaluate_angle_terms(d, r.x, r.y, azX, azY);
            if (!ae.ok) { R.reason = ae.reason; return R; }
            E += d.angleWeight * ae.angleObjectiveTerm;
            for (int i = 0; i < nI; ++i) { zX[i] += d.angleWeight * azX[i]; zY[i] += d.angleWeight * azY[i]; }
        }
        if (d.horizontalityWeight > 0) {
            std::vector<double> hzX(nI, 0), hzY(nI, 0);
            double ht = evaluate_horizontality_terms(d, r.x, r.y, hzX, hzY);
            E += d.horizontalityWeight * ht;
            for (int i = 0; i < nI; ++i) { zX[i] += d.horizontalityWeight * hzX[i]; zY[i] += d.horizontalityWeight * hzY[i]; }
        }
        // Face variance + barrier terms.
        double targetArea = totalArea / faceAreas.size();
        std::vector<double> residual(faceAreas.size(), 0);
        double faceScale = 1.0 / faceAreas.size();
        if (d.faceWeight > 0 || d.faceBarrierWeight > 0) {
            for (size_t i = 0; i < faceAreas.size(); ++i) {
                residual[i] = faceAreas[i] / targetArea - 1;
                double rel = std::abs(residual[i]);
                if (rel > maxRelError) maxRelError = rel;
                if (d.faceWeight > 0) E += d.faceWeight * faceScale * residual[i] * residual[i];
                if (d.faceBarrierWeight > 0)
                    E -= d.faceWeight * faceScale * d.faceBarrierWeight * std::log(faceAreas[i] / targetArea);
            }
            for (size_t i = 0; i < d.boundedFaces.size(); ++i) {
                int a = d.boundedFaces[i][0], b = d.boundedFaces[i][1], c = d.boundedFaces[i][2];
                double coeff = 0;
                if (d.faceWeight > 0) coeff += d.faceWeight * faceScale * (2 * residual[i] / targetArea);
                if (d.faceBarrierWeight > 0) coeff -= d.faceWeight * faceScale * d.faceBarrierWeight / faceAreas[i];
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
        if (d.edgeBarrierWeight > 0) {
            double edgeScale2 = d.edgeBarrierScale2 > 1e-12 ? d.edgeBarrierScale2 : 1;
            double edgeTol2 = std::max(1e-24, d.areaTol);
            double edgeBarrierScale = 1.0 / std::max((size_t)1, d.edges.size());
            for (const auto& [u, v] : d.edges) {
                double dx = r.x[u] - r.x[v];
                double dy = r.y[u] - r.y[v];
                double len2 = dx*dx + dy*dy;
                double safeLen2 = len2 > edgeTol2 ? len2 : edgeTol2;
                if (!(safeLen2 < edgeScale2)) continue;
                E -= d.edgeBarrierWeight * edgeBarrierScale * std::log(safeLen2 / edgeScale2);
                double edgeCoeff = -2 * d.edgeBarrierWeight * edgeBarrierScale / safeLen2;
                int iu = d.interiorIndexByAug[u], iv = d.interiorIndexByAug[v];
                if (iu >= 0) { zX[iu] += edgeCoeff * dx; zY[iu] += edgeCoeff * dy; }
                if (iv >= 0) { zX[iv] -= edgeCoeff * dx; zY[iv] -= edgeCoeff * dy; }
            }
        }
        if (d.edgeUniformWeight > 0 && d.edges.size() > 1) {
            double uniformTol2 = std::max(1e-24, d.areaTol);
            std::vector<double> logLen2(d.edges.size(), 0);
            double logMean = 0;
            for (size_t i = 0; i < d.edges.size(); ++i) {
                int u = d.edges[i].first, v = d.edges[i].second;
                double dx = r.x[u] - r.x[v];
                double dy = r.y[u] - r.y[v];
                double len2 = dx*dx + dy*dy;
                double safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
                logLen2[i] = std::log(safeLen2);
                logMean += logLen2[i];
            }
            logMean /= d.edges.size();
            double uniformScale = 2 * d.edgeUniformWeight / d.edges.size();
            for (size_t i = 0; i < d.edges.size(); ++i) {
                int u = d.edges[i].first, v = d.edges[i].second;
                double dx = r.x[u] - r.x[v];
                double dy = r.y[u] - r.y[v];
                double len2 = dx*dx + dy*dy;
                double safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
                double centered = logLen2[i] - logMean;
                E += d.edgeUniformWeight * centered * centered / d.edges.size();
                double uniformCoeff = uniformScale * centered / safeLen2;
                int iu = d.interiorIndexByAug[u], iv = d.interiorIndexByAug[v];
                if (iu >= 0) { zX[iu] += uniformCoeff * dx; zY[iu] += uniformCoeff * dy; }
                if (iv >= 0) { zX[iv] -= uniformCoeff * dx; zY[iv] -= uniformCoeff * dy; }
            }
        }
    }

    auto adj = la::solve_transpose_lu_with_two_rhs(r.factor, zX, zY);
    if (!adj) { R.reason = "FABalancer adjoint solve failed"; return R; }

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
    R.maxRelError = maxRelError;
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
        for (size_t j = 0; j < q.size(); ++j) { yy += Y[m-1][j]*Y[m-1][j]; sy += S[m-1][j]*Y[m-1][j]; }
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

double vec_norm(const std::vector<double>& v) { double s = 0; for (double x : v) s += x*x; return std::sqrt(s); }
double vec_dot(const std::vector<double>& a, const std::vector<double>& b) {
    double s = 0; for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i]; return s;
}

struct OptResult {
    bool ok = false; std::string reason;
    std::vector<double> q;
    std::unordered_map<std::string, Point> positions;
    double E = 0;
    std::string stopReason = "max-iters";
    int iters = 0;
    std::vector<double> x, y;
};

OptResult run_optimization(const std::vector<double>& q0, Data& d, const Config& cfg,
                           EvalKind kind, double maxPositionStep, gh::MovementTracker* tracker,
                           int maxIters) {
    OptResult OR;
    std::vector<double> q = q0;
    auto current = evaluate(q, d, kind);
    if (!current.ok) { OR.reason = current.reason; return OR; }
    auto best = current;
    auto bestQ = q;

    std::vector<std::vector<double>> S, Y;
    std::vector<double> Rho;
    std::string stopReason = "max-iters";
    int completed = 0;

    for (int iter = 1; iter <= maxIters; ++iter) {
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
                trial = evaluate(q_trial, d, kind);
                if (trial.ok) {
                    auto dist_fn = [&](int aug_idx, int) {
                        return std::hypot(trial.x[aug_idx] - current.x[aug_idx], trial.y[aug_idx] - current.y[aug_idx]);
                    };
                    auto tms = gh::compute_move_stats(d.interiorAugIndices, dist_fn, 1e-9);
                    if (tms.max_move > maxPositionStep) { alpha *= cfg.lineSearchTau; continue; }
                }
                if (trial.ok && trial.E <= current.E + cfg.lineSearchC1 * alpha * gtd + cfg.lineSearchAcceptTol) {
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
        if (current.E < best.E) { best = current; bestQ = q; }

        if (tracker) {
            auto dist_fn = [&](int aug_idx, int) {
                return std::hypot(current.x[aug_idx] - prev_x[aug_idx], current.y[aug_idx] - prev_y[aug_idx]);
            };
            auto ms = gh::compute_move_stats(d.interiorAugIndices, dist_fn, 1e-9);
            auto status = tracker->update(ms, iter);
            if (status.converged) { stopReason = status.reason.empty() ? "movement-converged" : status.reason; break; }
        }
        if (step_norm < cfg.stepTol) { stopReason = "step-converged"; break; }
        double ys = vec_dot(y_vec, s_vec);
        if (ys > 1e-14) {
            if ((int)S.size() == cfg.lbfgsMemory) { S.erase(S.begin()); Y.erase(Y.begin()); Rho.erase(Rho.begin()); }
            S.push_back(s_vec);
            Y.push_back(y_vec);
            Rho.push_back(1.0 / ys);
        }
    }

    OR.ok = true;
    OR.q = bestQ;
    for (int i = 0; i < (int)d.augIds.size(); ++i) OR.positions[d.augIds[i]] = {best.x[i], best.y[i]};
    OR.E = best.E;
    OR.x = best.x; OR.y = best.y;
    OR.stopReason = stopReason;
    OR.iters = completed;
    return OR;
}

void relax_min_face_area(Data& d, const std::vector<double>& q0, EvalKind kind) {
    if (!(d.minFaceArea > 0)) return;
    auto probe = evaluate(q0, d, kind);
    while (!probe.ok && probe.reason == "invalid-face-step" && d.minFaceArea > 1e-18) {
        d.minFaceArea *= 0.25;
        probe = evaluate(q0, d, kind);
    }
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

LayoutResult fabalancer(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    Config cfg;
    preprocessing::PrepareConfig pcfg;
    pcfg.failure_label = "FABalancer layout";
    pcfg.current_positions = initial_positions;
    auto prep = preprocessing::prepare_graph_data(g, pcfg);
    if (!prep.ok) { r.ok = false; r.message = prep.message.empty() ? "FABalancer failed" : prep.message; return r; }
    auto outer_pos = build_outer_positions(prep);
    auto weights = build_tutte_weights(prep.edge_pairs, prep.augmented_edge_pairs, prep.outer_dummy_ids);

    // ========== Stage 1: face-warm ==========
    auto fwBuild = build_data(prep.augmented_edge_pairs, prep.augmented_embedding, prep.augmented_outer_face,
                              outer_pos, g, prep.base_embedding, cfg, cfg.faceWarmStage);
    if (!fwBuild.ok) { r.ok = false; r.message = fwBuild.reason; return r; }
    auto& fwData = fwBuild.data;
    std::vector<double> fwQ0;
    if (!build_initial_seed(fwData, weights, fwQ0)) {
        r.ok = false; r.message = "FABalancer initialization requires positive Tutte weights"; return r;
    }
    auto fwBaseline = init_baseline(fwData, fwQ0);
    if (!fwBaseline.ok) { r.ok = false; r.message = "FABalancer initialization failed"; return r; }
    fwData.minFaceArea = std::max(0.0, cfg.faceWarmStage.minFaceAreaFactor * fwData.initialMinFaceArea);
    // Build seed from baseline positions (mean-value warm start); fallback to Tutte weights.
    std::vector<double> fwQ1;
    if (!build_initial_seed_from_positions(fwData, fwBaseline.positions, fwQ1)) {
        if (!build_initial_seed(fwData, weights, fwQ1)) {
            r.ok = false; r.message = "FABalancer initialization failed"; return r;
        }
    }
    relax_min_face_area(fwData, fwQ1, EvalKind::Face);
    PositionMap pm_scale;
    pm_scale.resize((int)prep.augmented_node_ids.size());
    for (int i = 0; i < (int)prep.augmented_node_ids.size(); ++i) {
        auto it = fwBaseline.positions.find(prep.augmented_node_ids[i]);
        if (it != fwBaseline.positions.end()) pm_scale.put(i, it->second[0], it->second[1]);
    }
    double fwScale = geo::compute_drawing_diameter((int)prep.augmented_node_ids.size(), pm_scale);
    gh::MovementTrackerConfig fwTcfg;
    fwTcfg.min_iters_before_stop = cfg.faceWarmStage.minItersBeforeStop;
    fwTcfg.stable_iter_limit = cfg.faceWarmStage.stableIterLimit;
    fwTcfg.max_move_tol = cfg.movementStopTol * fwScale;
    fwTcfg.avg_move_tol = cfg.avgMovementStopTol * fwScale;
    gh::MovementTracker fwTracker(fwTcfg);
    auto fwOpt = run_optimization(fwQ1, fwData, cfg, EvalKind::Face,
                                   cfg.faceWarmStage.maxPositionStepRatio * fwScale,
                                   &fwTracker, cfg.faceWarmStage.maxIters);
    if (!fwOpt.ok) { r.ok = false; r.message = fwOpt.reason; return r; }
    std::vector<double> faceWarmQ = fwOpt.q;

    // ========== Stage 2: angle ==========
    auto angBuild = build_data(prep.augmented_edge_pairs, prep.augmented_embedding, prep.augmented_outer_face,
                                outer_pos, g, prep.base_embedding, cfg, cfg.angleStage);
    if (!angBuild.ok) { r.ok = false; r.message = angBuild.reason; return r; }
    auto& angData = angBuild.data;
    // initialQ from face-warm result (if valid), else Tutte weights.
    std::vector<double> angQ0 = (!faceWarmQ.empty() && (int)faceWarmQ.size() == angData.qSize)
                                ? faceWarmQ
                                : (std::vector<double>{});
    if (angQ0.empty()) {
        if (!build_initial_seed(angData, weights, angQ0)) {
            r.ok = false; r.message = "FABalancer angle stage initialization failed"; return r;
        }
    }
    auto angBaseline = init_baseline(angData, angQ0);
    if (!angBaseline.ok) { r.ok = false; r.message = "FABalancer initialization failed"; return r; }
    angData.minFaceArea = std::max(0.0, cfg.angleStage.minFaceAreaFactor * angData.initialMinFaceArea);
    if (angData.objectiveVertexIds.empty() || angData.wedges.empty()) angData.angleWeight = 0;

    relax_min_face_area(angData, angQ0, EvalKind::AngleStage);

    PositionMap angPmScale;
    angPmScale.resize((int)prep.augmented_node_ids.size());
    for (int i = 0; i < (int)prep.augmented_node_ids.size(); ++i) {
        auto it = angBaseline.positions.find(prep.augmented_node_ids[i]);
        if (it != angBaseline.positions.end()) angPmScale.put(i, it->second[0], it->second[1]);
    }
    double angScale = geo::compute_drawing_diameter((int)prep.augmented_node_ids.size(), angPmScale);
    gh::MovementTrackerConfig angTcfg;
    angTcfg.min_iters_before_stop = cfg.angleStage.minItersBeforeStop;
    angTcfg.stable_iter_limit = cfg.angleStage.stableIterLimit;
    angTcfg.max_move_tol = cfg.movementStopTol * angScale;
    angTcfg.avg_move_tol = cfg.avgMovementStopTol * angScale;
    gh::MovementTracker angTracker(angTcfg);
    auto angOpt = run_optimization(angQ0, angData, cfg, EvalKind::AngleStage,
                                    cfg.angleStage.maxPositionStepRatio * angScale,
                                    &angTracker, cfg.angleStage.maxIters);
    if (!angOpt.ok) { r.ok = false; r.message = angOpt.reason; return r; }

    // Filter to original nodes, check crossings.
    std::unordered_map<std::string, Point> final_pos;
    for (const auto& nid : g.node_names) {
        auto it = angOpt.positions.find(nid);
        if (it != angOpt.positions.end()) final_pos[nid] = it->second;
    }
    // Verify no crossings.
    PositionMap pm_check;
    pm_check.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = final_pos.find(g.node_names[i]);
        if (it != final_pos.end()) pm_check.put(i, it->second[0], it->second[1]);
    }
    if (geo::has_position_crossings(pm_check, g.edges)) {
        r.ok = false;
        r.message = "FABalancer produced a non-plane drawing";
        r.stop_reason = angOpt.stopReason;
        return r;
    }

    // ========== Stage 3: axis alignment ==========
    std::vector<std::string> g_node_ids = g.node_names;
    std::vector<std::pair<std::string,std::string>> g_edges;
    for (const auto& [u, v] : g.edges) g_edges.emplace_back(g.node_names[u], g.node_names[v]);
    auto current = final_pos;
    for (int pass = 0; pass < std::max(1, cfg.alignMaxPasses); ++pass) {
        auto ar = alignment::align_to_axis_greedy(g_node_ids, g_edges, current);
        if (!ar.ok) {
            r.ok = false;
            r.message = ar.reason.empty() ? "FABalancer axis-align failed" : ar.reason;
            return r;
        }
        if (!ar.changed) break;
        current = std::move(ar.positions);
    }

    r.positions.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = current.find(g.node_names[i]);
        if (it != current.end() && std::isfinite(it->second[0]) && std::isfinite(it->second[1]))
            r.positions.put(i, it->second[0], it->second[1]);
    }
    r.ok = true;
    r.iters = angOpt.iters;
    r.stop_reason = angOpt.stopReason;
    r.message = "FABalancer layout";
    return r;
}

} // namespace planarvibe::layouts
