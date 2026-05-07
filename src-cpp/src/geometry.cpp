#include "geometry.hpp"

#include <algorithm>
#include <limits>

namespace planarvibe::geo {

double polygon_area2(const std::vector<int>& face, const PositionMap& pos) {
    size_t nf = face.size();
    if (nf < 3) return 0.0;
    double total = 0.0;
    for (size_t i = 0; i < nf; ++i) {
        int a = face[i];
        int b = face[(i + 1) % nf];
        if (!pos.has(a) || !pos.has(b)) return 0.0;
        total += pos.pos[a][0] * pos.pos[b][1] - pos.pos[b][0] * pos.pos[a][1];
    }
    return total;
}

double polygon_area_abs(const std::vector<int>& face, const PositionMap& pos) {
    return std::abs(polygon_area2(face, pos)) / 2.0;
}

bool point_on_segment(Point a, Point b, Point p, double eps) {
    return std::min(a[0], b[0]) - eps <= p[0] && p[0] <= std::max(a[0], b[0]) + eps
        && std::min(a[1], b[1]) - eps <= p[1] && p[1] <= std::max(a[1], b[1]) + eps;
}

bool point_on_segment_interior(Point a, Point b, Point p, double eps) {
    if (!point_on_segment(a, b, p, eps)) return false;
    if (std::abs(triangle_area2(a, b, p)) > eps) return false;
    if (std::abs(p[0] - a[0]) <= eps && std::abs(p[1] - a[1]) <= eps) return false;
    if (std::abs(p[0] - b[0]) <= eps && std::abs(p[1] - b[1]) <= eps) return false;
    return true;
}

bool segments_intersect_or_touch(Point a, Point b, Point c, Point d, double eps) {
    double o1 = triangle_area2(a, b, c);
    double o2 = triangle_area2(a, b, d);
    double o3 = triangle_area2(c, d, a);
    double o4 = triangle_area2(c, d, b);
    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps))
        && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
        return true;
    }
    if (std::abs(o1) <= eps && point_on_segment(a, b, c, eps)) return true;
    if (std::abs(o2) <= eps && point_on_segment(a, b, d, eps)) return true;
    if (std::abs(o3) <= eps && point_on_segment(c, d, a, eps)) return true;
    if (std::abs(o4) <= eps && point_on_segment(c, d, b, eps)) return true;
    return false;
}

double compute_drawing_diameter(int n, const PositionMap& pos) {
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = min_x, max_x = -min_x, max_y = -min_x;
    bool any_found = false;
    for (int i = 0; i < n; ++i) {
        if (!pos.has(i)) continue;
        double x = pos.pos[i][0], y = pos.pos[i][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        any_found = true;
        min_x = std::min(min_x, x); max_x = std::max(max_x, x);
        min_y = std::min(min_y, y); max_y = std::max(max_y, y);
    }
    if (!any_found) return 1.0;
    double dx = max_x - min_x, dy = max_y - min_y;
    double d = std::sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? d : 1.0;
}

double outer_face_diameter(const PositionMap& pos, const std::vector<int>& outer_face) {
    double diameter = 0.0;
    for (size_t i = 0; i < outer_face.size(); ++i) {
        int a = outer_face[i];
        if (!pos.has(a)) continue;
        Point pa = pos.pos[a];
        if (!is_finite(pa[0]) || !is_finite(pa[1])) continue;
        for (size_t j = i + 1; j < outer_face.size(); ++j) {
            int b = outer_face[j];
            if (!pos.has(b)) continue;
            Point pb = pos.pos[b];
            if (!is_finite(pb[0]) || !is_finite(pb[1])) continue;
            double dist = std::hypot(pa[0] - pb[0], pa[1] - pb[1]);
            if (dist > diameter) diameter = dist;
        }
    }
    return diameter > 1e-12 ? diameter : 1.0;
}

Point compute_face_centroid(const PositionMap& pos, const std::vector<int>& face) {
    double sx = 0.0, sy = 0.0;
    int count = 0;
    for (int fi : face) {
        if (!pos.has(fi)) continue;
        double x = pos.pos[fi][0], y = pos.pos[fi][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        sx += x; sy += y; ++count;
    }
    if (count < 1) return {0.0, 0.0};
    return {sx / count, sy / count};
}

bool has_position_crossings(const PositionMap& pos,
                            const std::vector<std::pair<int,int>>& edges) {
    const double EPS = 1e-9;
    int m = (int)edges.size();
    for (int i = 0; i < m; ++i) {
        int s1 = edges[i].first, t1 = edges[i].second;
        if (!pos.has(s1) || !pos.has(t1)) continue;
        Point p1 = pos.pos[s1], q1 = pos.pos[t1];
        for (int j = i + 1; j < m; ++j) {
            int s2 = edges[j].first, t2 = edges[j].second;
            if (s1 == s2 || s1 == t2 || t1 == s2 || t1 == t2) continue;
            if (!pos.has(s2) || !pos.has(t2)) continue;
            Point p2 = pos.pos[s2], q2 = pos.pos[t2];
            if (segments_intersect_or_touch(p1, q1, p2, q2, EPS)) return true;
        }
    }

    // Node on edge interior
    int n = (int)pos.pos.size();
    for (int nid = 0; nid < n; ++nid) {
        if (!pos.has(nid)) continue;
        double x = pos.pos[nid][0], y = pos.pos[nid][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        Point p = {x, y};
        for (int j = 0; j < m; ++j) {
            int u = edges[j].first, v = edges[j].second;
            if (nid == u || nid == v) continue;
            if (!pos.has(u) || !pos.has(v)) continue;
            Point a = pos.pos[u], b = pos.pos[v];
            double area2 = triangle_area2(a, b, p);
            if (std::abs(area2) <= EPS && point_on_segment_interior(a, b, p, EPS)) {
                return true;
            }
        }
    }
    return false;
}

PositionMap copy_position_map(const PositionMap& pos) {
    PositionMap out;
    out.resize((int)pos.pos.size());
    for (int i = 0; i < (int)pos.pos.size(); ++i) {
        if (!pos.has(i)) continue;
        double x = pos.pos[i][0], y = pos.pos[i][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        out.put(i, x, y);
    }
    return out;
}

PositionMap filter_position_map(const PositionMap& pos, int n) {
    PositionMap out;
    out.resize(n);
    for (int i = 0; i < n && i < (int)pos.pos.size(); ++i) {
        if (!pos.has(i)) continue;
        double x = pos.pos[i][0], y = pos.pos[i][1];
        if (!is_finite(x) || !is_finite(y)) continue;
        out.put(i, x, y);
    }
    return out;
}

PositionMap normalize_position_map_to_viewport(const PositionMap& pos,
                                               double width, double height) {
    PositionMap src = copy_position_map(pos);
    int n = (int)src.pos.size();
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = min_x, max_x = -min_x, max_y = -min_x;
    bool any = false;
    for (int i = 0; i < n; ++i) {
        if (!src.has(i)) continue;
        any = true;
        min_x = std::min(min_x, src.pos[i][0]); max_x = std::max(max_x, src.pos[i][0]);
        min_y = std::min(min_y, src.pos[i][1]); max_y = std::max(max_y, src.pos[i][1]);
    }
    if (!any) return src;
    double padding = 24.0;
    double box_w = max_x - min_x, box_h = max_y - min_y;
    double inner_w = std::max(1.0, width - 2 * padding);
    double inner_h = std::max(1.0, height - 2 * padding);
    if (box_w < 1e-9 && box_h < 1e-9) {
        for (int i = 0; i < n; ++i) if (src.has(i)) src.put(i, width / 2.0, height / 2.0);
        return src;
    }
    double safe_w = std::max(box_w, 1e-9);
    double safe_h = std::max(box_h, 1e-9);
    double scale = std::min(inner_w / safe_w, inner_h / safe_h);
    if (!is_finite(scale) || scale <= 0) scale = 1.0;
    double offset_x = (width - box_w * scale) / 2.0;
    double offset_y = (height - box_h * scale) / 2.0;
    for (int i = 0; i < n; ++i) {
        if (!src.has(i)) continue;
        double x = src.pos[i][0], y = src.pos[i][1];
        src.put(i, (x - min_x) * scale + offset_x, (y - min_y) * scale + offset_y);
    }
    return src;
}

double compute_quantile(std::vector<double> values, double q) {
    if (values.empty()) return std::numeric_limits<double>::quiet_NaN();
    if (!is_finite(q)) q = 0.2;
    q = std::max(0.0, std::min(1.0, q));
    std::sort(values.begin(), values.end());
    double idx = q * (values.size() - 1);
    size_t lo = (size_t)std::floor(idx);
    size_t hi = (size_t)std::ceil(idx);
    double t = idx - lo;
    if (lo == hi) return values[lo];
    return values[lo] * (1 - t) + values[hi] * t;
}

Point compute_face_centroid_names(const std::unordered_map<std::string, Point>& pos,
                                  const std::vector<std::string>& face) {
    double sx = 0, sy = 0;
    int count = 0;
    for (const auto& nid : face) {
        auto it = pos.find(nid);
        if (it == pos.end()) continue;
        if (!is_finite(it->second[0]) || !is_finite(it->second[1])) continue;
        sx += it->second[0];
        sy += it->second[1];
        ++count;
    }
    if (count < 1) return {0.0, 0.0};
    return {sx / count, sy / count};
}

std::unordered_map<std::string, Point> rotate_position_map_names(
    const std::unordered_map<std::string, Point>& pos, Point center, double angle) {
    std::unordered_map<std::string, Point> out;
    double c = std::cos(angle), s = std::sin(angle);
    for (const auto& [nid, p] : pos) {
        if (!is_finite(p[0]) || !is_finite(p[1])) continue;
        double dx = p[0] - center[0];
        double dy = p[1] - center[1];
        out[nid] = {center[0] + c * dx - s * dy, center[1] + s * dx + c * dy};
    }
    return out;
}

std::vector<double> collect_positive_gaps(const std::vector<double>& sv, double range_) {
    std::vector<double> gaps;
    if (sv.size() < 2) return gaps;
    double rv = is_finite(range_) ? range_ : 0.0;
    double min_gap = std::max(1e-12, rv * 1e-12);
    for (size_t i = 1; i < sv.size(); ++i) {
        double g = sv[i] - sv[i - 1];
        if (g > min_gap) gaps.push_back(g);
    }
    return gaps;
}

} // namespace planarvibe::geo
