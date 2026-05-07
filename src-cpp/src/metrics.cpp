#include "metrics.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace planarvibe::metrics {

namespace {

bool is_finite(double x) { return std::isfinite(x); }

constexpr bool USE_SIMPLE_AXIS_ALIGNMENT = true;
constexpr double SIMPLE_AXIS_ALIGNMENT_EPSILON = 1e-5;
constexpr bool USE_SQUARE_NODE_UNIFORMITY_GRID = true;

// --- axis-alignment helpers ---

std::vector<int> cluster_sorted_values(const std::vector<double>& sv, double tolerance) {
    std::vector<int> sizes;
    if (sv.empty()) return sizes;
    double eps = std::max(0.0, is_finite(tolerance) ? tolerance : 0.0);
    sizes.push_back(1);
    for (size_t i = 1; i < sv.size(); ++i) {
        double g = sv[i] - sv[i - 1];
        if (g > eps) sizes.push_back(1);
        else ++sizes.back();
    }
    return sizes;
}

std::vector<int> cluster_sorted_values_by_span(const std::vector<double>& sv, double tolerance) {
    std::vector<int> sizes;
    if (sv.empty()) return sizes;
    double eps = std::max(0.0, is_finite(tolerance) ? tolerance : 0.0);
    sizes.push_back(1);
    double cluster_start = sv[0];
    for (size_t i = 1; i < sv.size(); ++i) {
        if (sv[i] - cluster_start > eps) {
            sizes.push_back(1);
            cluster_start = sv[i];
        } else {
            ++sizes.back();
        }
    }
    return sizes;
}

double compute_effective_line_count(const std::vector<int>& sizes, int total) {
    if (sizes.empty() || total <= 0) return std::numeric_limits<double>::quiet_NaN();
    double sum_sq = 0.0;
    for (int s : sizes) {
        double f = double(s) / total;
        sum_sq += f * f;
    }
    if (!(sum_sq > 0)) return std::numeric_limits<double>::quiet_NaN();
    return 1.0 / sum_sq;
}

struct AxisClustering {
    std::vector<int> cluster_sizes;
    int line_count = 0;
    double effective_line_count = std::numeric_limits<double>::quiet_NaN();
};

std::optional<AxisClustering> compute_axis_clustering(std::vector<double> values) {
    if (values.empty()) return std::nullopt;
    std::sort(values.begin(), values.end());
    double rng = values.back() - values.front();
    double tolerance = 0.0;
    if (rng > 0) {
        auto gaps = geo::collect_positive_gaps(values, rng);
        double quantile = geo::compute_quantile(gaps, 0.2);
        double scale = 2.0;
        double min_tolerance = std::max(1e-12, rng * 1e-9);
        double cap_fraction = 0.05;
        double fallback_fraction = 0.01;
        if (gaps.size() >= 3 && is_finite(quantile)) {
            double raw = scale * quantile;
            tolerance = std::min(rng * cap_fraction, std::max(min_tolerance, raw));
        } else {
            tolerance = rng * fallback_fraction;
        }
    }
    AxisClustering out;
    out.cluster_sizes = cluster_sorted_values(values, tolerance);
    out.line_count = (int)out.cluster_sizes.size();
    out.effective_line_count = compute_effective_line_count(out.cluster_sizes, (int)values.size());
    return out;
}

std::optional<AxisClustering> compute_simple_axis_clustering(std::vector<double> values) {
    if (values.empty()) return std::nullopt;
    std::sort(values.begin(), values.end());
    double rng = values.back() - values.front();
    std::vector<double> normalized;
    normalized.reserve(values.size());
    if (rng > 0) {
        double mn = values.front();
        for (double v : values) normalized.push_back((v - mn) / rng);
    } else {
        normalized.assign(values.size(), 0.0);
    }
    double tolerance = rng > 0 ? SIMPLE_AXIS_ALIGNMENT_EPSILON : 0.0;
    AxisClustering out;
    out.cluster_sizes = cluster_sorted_values_by_span(normalized, tolerance);
    out.line_count = (int)out.cluster_sizes.size();
    out.effective_line_count = compute_effective_line_count(out.cluster_sizes, (int)values.size());
    return out;
}

// --- small helpers ---

struct PositionedPoint { int id; double x, y; };

std::vector<PositionedPoint> collect_positioned(int n, const PositionMap& pos) {
    std::vector<PositionedPoint> out;
    for (int i = 0; i < n; ++i) {
        if (!pos.has(i)) continue;
        double x = pos.pos[i][0], y = pos.pos[i][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        out.push_back({i, x, y});
    }
    return out;
}

double angle_to_nearest_orthogonal(double angle) {
    const double HALF_PI = M_PI / 2.0;
    double w = std::fmod(angle, HALF_PI);
    if (w < 0) w += HALF_PI;
    return std::min(w, HALF_PI - w);
}

} // namespace

MetricResult compute_angular_resolution_score(const Graph& g, const PositionMap& pos) {
    const double TWO_PI = 2.0 * M_PI;
    if (g.n == 0) return {false, "No nodes", {}, {}, {}};
    int vertex_count = 0;
    double score_sum = 0.0;
    for (int nid = 0; nid < g.n; ++nid) {
        const auto& neighbors = g.adjacency[nid];
        if (neighbors.size() < 2) continue;
        if (!pos.has(nid)) return {false, "Metrics unavailable", {}, {}, {}};
        double px = pos.pos[nid][0], py = pos.pos[nid][1];
        if (!is_finite(px) || !is_finite(py)) return {false, "Metrics unavailable", {}, {}, {}};
        std::vector<double> dirs;
        dirs.reserve(neighbors.size());
        for (int nb : neighbors) {
            if (!pos.has(nb)) return {false, "Metrics unavailable", {}, {}, {}};
            double qx = pos.pos[nb][0], qy = pos.pos[nb][1];
            if (!is_finite(qx) || !is_finite(qy)) return {false, "Metrics unavailable", {}, {}, {}};
            double a = std::atan2(qy - py, qx - px);
            if (a < 0) a += TWO_PI;
            dirs.push_back(a);
        }
        std::sort(dirs.begin(), dirs.end());
        double min_gap = std::numeric_limits<double>::infinity();
        for (size_t j = 0; j < dirs.size(); ++j) {
            double nxt = dirs[(j + 1) % dirs.size()];
            double gap = nxt - dirs[j];
            if (gap <= 0) gap += TWO_PI;
            if (gap < min_gap) min_gap = gap;
        }
        double ideal_gap = TWO_PI / dirs.size();
        score_sum += min_gap / ideal_gap;
        ++vertex_count;
    }
    if (vertex_count == 0) return {false, "No angle data", {}, {}, {}};
    double s = std::max(0.0, std::min(1.0, score_sum / vertex_count));
    return {true, "", s, {}, {}};
}

MetricResult compute_axis_alignment_score(int n, const PositionMap& pos) {
    auto pts = collect_positioned(n, pos);
    if (pts.size() < 2) return {false, "Not enough positioned nodes", {}, {}, {}};
    std::vector<double> xs, ys;
    xs.reserve(pts.size()); ys.reserve(pts.size());
    for (const auto& p : pts) { xs.push_back(p.x); ys.push_back(p.y); }
    auto ax = USE_SIMPLE_AXIS_ALIGNMENT ? compute_simple_axis_clustering(xs) : compute_axis_clustering(xs);
    auto ay = USE_SIMPLE_AXIS_ALIGNMENT ? compute_simple_axis_clustering(ys) : compute_axis_clustering(ys);
    if (!ax || !ay || !is_finite(ax->effective_line_count) || !is_finite(ay->effective_line_count)) {
        return {false, "Invalid axis clustering", {}, {}, {}};
    }
    int denom = (int)xs.size() - 1;
    double sx = denom > 0 ? (xs.size() - ax->effective_line_count) / denom : 1.0;
    double sy = denom > 0 ? (ys.size() - ay->effective_line_count) / denom : 1.0;
    double score = std::max(0.0, std::min(1.0, (sx + sy) / 2.0));
    return {true, "", score, {}, {}};
}

MetricResult compute_aspect_ratio_score(int n, const PositionMap& pos) {
    auto pts = collect_positioned(n, pos);
    if (pts.empty()) return {false, "No positioned nodes", {}, {}, {}};
    double mn_x = pts[0].x, mx_x = pts[0].x, mn_y = pts[0].y, mx_y = pts[0].y;
    for (const auto& p : pts) {
        mn_x = std::min(mn_x, p.x); mx_x = std::max(mx_x, p.x);
        mn_y = std::min(mn_y, p.y); mx_y = std::max(mx_y, p.y);
    }
    double w = mx_x - mn_x, h = mx_y - mn_y;
    double min_side = std::min(w, h), max_side = std::max(w, h);
    double score = (min_side > 0) ? (min_side / max_side) : 1.0;
    return {true, "", score, {}, {}};
}

MetricResult compute_node_uniformity_score(int n, const PositionMap& pos) {
    auto pts = collect_positioned(n, pos);
    int k = (int)pts.size();
    if (k == 0) return {false, "No positioned nodes", {}, {}, {}};
    double mn_x = pts[0].x, mx_x = pts[0].x, mn_y = pts[0].y, mx_y = pts[0].y;
    for (const auto& p : pts) {
        mn_x = std::min(mn_x, p.x); mx_x = std::max(mx_x, p.x);
        mn_y = std::min(mn_y, p.y); mx_y = std::max(mx_y, p.y);
    }
    double w = mx_x - mn_x, h = mx_y - mn_y;
    int rows = std::max(1, (int)std::floor(std::sqrt((double)k)));
    int cols = USE_SQUARE_NODE_UNIFORMITY_GRID
        ? rows
        : std::max(1, (int)std::ceil((double)k / rows));
    int cell_count = rows * cols;
    std::vector<int> counts(cell_count, 0);
    for (const auto& p : pts) {
        int col = 0, row = 0;
        if (w > 0) {
            col = (int)std::floor(((p.x - mn_x) / w) * cols);
            if (col < 0) col = 0;
            if (col >= cols) col = cols - 1;
        }
        if (h > 0) {
            row = (int)std::floor(((p.y - mn_y) / h) * rows);
            if (row < 0) row = 0;
            if (row >= rows) row = rows - 1;
        }
        ++counts[row * cols + col];
    }
    double mu = double(k) / cell_count;
    double deviation = 0.0;
    for (int c : counts) deviation += std::abs(c - mu);
    double max_deviation = (2.0 * k * (cell_count - 1)) / cell_count;
    double score = (max_deviation > 0)
        ? std::max(0.0, std::min(1.0, 1.0 - deviation / max_deviation))
        : 1.0;
    return {true, "", score, {}, {}};
}

MetricResult compute_edge_length_deviation_score(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos) {
    if (edges.empty()) return {false, "No edges", {}, {}, {}};
    std::vector<double> lengths;
    lengths.reserve(edges.size());
    for (const auto& [u, v] : edges) {
        if (!pos.has(u) || !pos.has(v)) return {false, "Metrics unavailable", {}, {}, {}};
        double dx = pos.pos[u][0] - pos.pos[v][0];
        double dy = pos.pos[u][1] - pos.pos[v][1];
        double len = std::sqrt(dx * dx + dy * dy);
        if (!is_finite(len)) return {false, "Metrics unavailable", {}, {}, {}};
        if (len > 0) lengths.push_back(len);
    }
    if (lengths.empty()) return {false, "No edge lengths available", {}, {}, {}};
    double mean = 0.0;
    for (double x : lengths) mean += x;
    mean /= lengths.size();
    double avg_rel = 0.0;
    for (double x : lengths) avg_rel += std::abs(x - mean) / mean;
    avg_rel /= lengths.size();
    return {true, "", 1.0 / (1.0 + avg_rel), {}, {}};
}

MetricResult compute_edge_length_ratio(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos) {
    if (edges.empty()) return {false, "No edges", {}, {}, {}};
    double mn = std::numeric_limits<double>::infinity();
    double mx = 0.0;
    for (const auto& [u, v] : edges) {
        if (!pos.has(u) || !pos.has(v)) return {false, "Metrics unavailable", {}, {}, {}};
        double dx = pos.pos[u][0] - pos.pos[v][0];
        double dy = pos.pos[u][1] - pos.pos[v][1];
        double len = std::sqrt(dx * dx + dy * dy);
        if (!is_finite(len)) return {false, "Metrics unavailable", {}, {}, {}};
        if (len > 0) {
            if (len < mn) mn = len;
            if (len > mx) mx = len;
        }
    }
    if (!(mx > 0) || !is_finite(mn)) return {false, "No edge lengths available", {}, {}, {}};
    MetricResult r{true, "", {}, {}, mn / mx};
    return r;
}

MetricResult compute_edge_orthogonality_score(
    const std::vector<std::pair<int,int>>& edges, const PositionMap& pos) {
    if (edges.empty()) return {false, "No edges", {}, {}, {}};
    const double MAX_DEV = M_PI / 4.0;
    int used = 0;
    double dev_sum = 0.0;
    for (const auto& [u, v] : edges) {
        if (!pos.has(u) || !pos.has(v)) return {false, "Metrics unavailable", {}, {}, {}};
        double dx = pos.pos[v][0] - pos.pos[u][0];
        double dy = pos.pos[v][1] - pos.pos[u][1];
        double len = std::sqrt(dx * dx + dy * dy);
        if (!is_finite(len) || !(len > 0)) continue;
        dev_sum += angle_to_nearest_orthogonal(std::atan2(dy, dx));
        ++used;
    }
    if (used == 0) return {false, "No edge lengths available", {}, {}, {}};
    double mean_dev = dev_sum / used;
    double s = std::max(0.0, std::min(1.0, 1.0 - mean_dev / MAX_DEV));
    return {true, "", s, {}, {}};
}

MetricResult compute_spacing_uniformity_score(int n, const PositionMap& pos) {
    const double TRIM_Q = 0.1;
    auto pts = collect_positioned(n, pos);
    if (pts.size() < 2) return {false, "Not enough positioned nodes", {}, {}, {}};
    double mn_x = pts[0].x, mx_x = pts[0].x, mn_y = pts[0].y, mx_y = pts[0].y;
    for (const auto& p : pts) {
        mn_x = std::min(mn_x, p.x); mx_x = std::max(mx_x, p.x);
        mn_y = std::min(mn_y, p.y); mx_y = std::max(mx_y, p.y);
    }
    std::vector<PositionedPoint> kept = pts;
    if (pts.size() >= 10) {
        std::vector<std::pair<int,double>> bd;
        bd.reserve(pts.size());
        for (int i = 0; i < (int)pts.size(); ++i) {
            double d = std::min(std::min(pts[i].x - mn_x, mx_x - pts[i].x),
                                std::min(pts[i].y - mn_y, mx_y - pts[i].y));
            bd.emplace_back(i, d);
        }
        std::stable_sort(bd.begin(), bd.end(),
                         [](const auto& a, const auto& b){ return a.second < b.second; });
        int drop = (int)std::floor(TRIM_Q * bd.size());
        std::vector<PositionedPoint> trimmed;
        for (size_t i = drop; i < bd.size(); ++i) trimmed.push_back(pts[bd[i].first]);
        if (trimmed.size() >= 2) kept = std::move(trimmed);
    }
    std::vector<double> nn;
    nn.reserve(kept.size());
    for (size_t i = 0; i < kept.size(); ++i) {
        double best = std::numeric_limits<double>::infinity();
        for (size_t j = 0; j < kept.size(); ++j) {
            if (i == j) continue;
            double dx = kept[i].x - kept[j].x;
            double dy = kept[i].y - kept[j].y;
            double d = std::sqrt(dx * dx + dy * dy);
            if (d < best) best = d;
        }
        if (is_finite(best) && best > 0) nn.push_back(best);
    }
    if (nn.empty()) return {false, "Not enough valid nearest-neighbor distances", {}, {}, {}};
    double mean = 0.0;
    for (double x : nn) mean += x;
    mean /= nn.size();
    if (!(mean > 0)) return {false, "Degenerate nearest-neighbor distances", {}, {}, {}};
    double var = 0.0;
    for (double x : nn) { double d = x - mean; var += d * d; }
    double std_ = std::sqrt(var / nn.size());
    double cv = std_ / mean;
    double score = 1.0 / (1.0 + cv);
    if (!is_finite(score)) return {false, "Invalid spacing score", {}, {}, {}};
    score = std::max(0.0, std::min(1.0, score));
    return {true, "", score, {}, {}};
}

namespace {

double polygon_area_abs_str(const std::vector<std::string>& face,
                            const std::unordered_map<std::string, Point>& pos) {
    if (face.size() < 3) return 0.0;
    double total = 0.0;
    int n = (int)face.size();
    for (int i = 0; i < n; ++i) {
        auto ia = pos.find(face[i]);
        auto ib = pos.find(face[(i + 1) % n]);
        if (ia == pos.end() || ib == pos.end()) return 0.0;
        total += ia->second[0] * ib->second[1] - ib->second[0] * ia->second[1];
    }
    return std::abs(total) / 2.0;
}

// Same cyclic-direction check used by find_outer_face_index.
bool same_cyclic_direction(const std::vector<std::string>& a, const std::vector<std::string>& b) {
    if (a.size() != b.size() || a.empty()) return false;
    int n = (int)a.size();
    for (int off = 0; off < n; ++off) {
        bool ok = true;
        for (int i = 0; i < n; ++i) {
            if (a[(off + i) % n] != b[i]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}
bool same_cyclic_either_direction(const std::vector<std::string>& a, const std::vector<std::string>& b) {
    if (same_cyclic_direction(a, b)) return true;
    std::vector<std::string> rb(b.rbegin(), b.rend());
    return same_cyclic_direction(a, rb);
}

int find_outer_face_idx(const std::vector<std::vector<std::string>>& faces,
                        const std::vector<std::string>& outer) {
    if (faces.empty() || outer.empty()) return -1;
    for (int i = 0; i < (int)faces.size(); ++i) {
        if (same_cyclic_either_direction(faces[i], outer)) return i;
    }
    return -1;
}

// Weighted distribution quality (compute_uniformity_score) mirror.
double uniformity_quality(const std::vector<double>& values, const std::vector<double>& ideals) {
    if (values.empty() || values.size() != ideals.size()) return std::numeric_limits<double>::quiet_NaN();
    int k = (int)values.size();
    if (k == 1) return 1.0;
    double sum_sq = 0.0, sum_ideal_sq = 0.0;
    double min_ideal = std::numeric_limits<double>::infinity();
    for (int i = 0; i < k; ++i) {
        double d = values[i] - ideals[i];
        sum_sq += d * d;
        sum_ideal_sq += ideals[i] * ideals[i];
        if (ideals[i] < min_ideal) min_ideal = ideals[i];
    }
    if (!is_finite(min_ideal)) return std::numeric_limits<double>::quiet_NaN();
    double max_sq = 1.0 - 2.0 * min_ideal + sum_ideal_sq;
    if (!(max_sq > 0)) return 1.0;
    double normalized = std::sqrt(sum_sq / max_sq);
    double q = 1.0 - normalized;
    return std::max(0.0, std::min(1.0, q));
}

bool is_convex_face(const std::vector<std::string>& face,
                    const std::unordered_map<std::string, Point>& pos, double eps) {
    if (face.size() < 3) return false;
    int n = (int)face.size();
    int sign = 0;
    for (int i = 0; i < n; ++i) {
        auto ip = pos.find(face[(i - 1 + n) % n]);
        auto ic = pos.find(face[i]);
        auto in_ = pos.find(face[(i + 1) % n]);
        if (ip == pos.end() || ic == pos.end() || in_ == pos.end()) return false;
        double turn = (ic->second[0] - ip->second[0]) * (in_->second[1] - ip->second[1])
                    - (ic->second[1] - ip->second[1]) * (in_->second[0] - ip->second[0]);
        if (std::abs(turn) <= eps) return false;
        int cs = turn > 0 ? 1 : -1;
        if (sign == 0) sign = cs;
        else if (cs != sign) return false;
    }
    return true;
}

} // anonymous namespace

MetricResult compute_uniform_face_area_score(
    const FaceMetricInput& in,
    const std::unordered_map<std::string, Point>& pos_by_name) {
    if (!in.faces || in.faces->empty()) return {false, "No faces available", {}, {}, {}};
    int outer_idx = in.outer_face ? find_outer_face_idx(*in.faces, *in.outer_face) : -1;

    std::vector<double> areas;
    std::vector<double> ideal_weights;
    for (int i = 0; i < (int)in.faces->size(); ++i) {
        if (i == outer_idx) continue;
        const auto& f = (*in.faces)[i];
        double a = polygon_area_abs_str(f, pos_by_name);
        if (a > 0) {
            areas.push_back(a);
            ideal_weights.push_back(std::max(1.0, double((int)f.size() - 2)));
        }
    }
    if (areas.empty()) {
        MetricResult r; r.ok = true; r.quality = 1.0; return r;
    }

    double value_total = 0.0, weight_total = 0.0;
    for (double v : areas) value_total += v;
    for (double w : ideal_weights) weight_total += w;
    if (!(value_total > 0) || !(weight_total > 0)) return {false, "Degenerate face areas", {}, {}, {}};

    std::vector<std::pair<double,double>> pairs;
    pairs.reserve(areas.size());
    for (size_t i = 0; i < areas.size(); ++i) {
        double value = areas[i] / value_total;
        double ideal = ideal_weights[i] / weight_total;
        if (!is_finite(value) || !is_finite(ideal) || !(ideal > 0)) return {false, "Degenerate face areas", {}, {}, {}};
        pairs.emplace_back(value, ideal);
    }
    std::stable_sort(pairs.begin(), pairs.end(),
        [](const auto& a, const auto& b) {
            if (a.second != b.second) return a.second < b.second;
            return a.first < b.first;
        });
    std::vector<double> values, ideals;
    values.reserve(pairs.size()); ideals.reserve(pairs.size());
    for (auto& p : pairs) { values.push_back(p.first); ideals.push_back(p.second); }
    double q = uniformity_quality(values, ideals);
    MetricResult r; r.ok = true; r.quality = q; return r;
}

MetricResult compute_convexity_score(
    const FaceMetricInput& in,
    const std::unordered_map<std::string, Point>& pos_by_name,
    const std::vector<std::string>& node_ids) {
    if (!in.faces || in.faces->empty()) return {false, "No faces available", {}, {}, {}};
    int outer_idx = in.outer_face ? find_outer_face_idx(*in.faces, *in.outer_face) : -1;

    // Compute drawing diameter from pos_by_name.
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = min_x, max_x = -min_x, max_y = -min_x;
    bool any = false;
    for (const auto& nid : node_ids) {
        auto it = pos_by_name.find(nid);
        if (it == pos_by_name.end()) continue;
        if (!is_finite(it->second[0]) || !is_finite(it->second[1])) continue;
        any = true;
        min_x = std::min(min_x, it->second[0]); max_x = std::max(max_x, it->second[0]);
        min_y = std::min(min_y, it->second[1]); max_y = std::max(max_y, it->second[1]);
    }
    double diameter = 1.0;
    if (any) {
        double dx = max_x - min_x, dy = max_y - min_y;
        double d = std::sqrt(dx * dx + dy * dy);
        if (d > 1e-9) diameter = d;
    }
    double eps = std::max(1e-12, diameter * 1e-9);

    int face_count = 0, convex_count = 0;
    for (int i = 0; i < (int)in.faces->size(); ++i) {
        if (i == outer_idx) continue;
        ++face_count;
        if (is_convex_face((*in.faces)[i], pos_by_name, eps)) ++convex_count;
    }
    MetricResult r; r.ok = true;
    r.score = face_count == 0 ? 1.0 : double(convex_count) / face_count;
    return r;
}

} // namespace planarvibe::metrics
