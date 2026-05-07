#pragma once

// Geometric primitives. Literal port of static/js/geometry-utils.js.
// Positions are indexed by int node id (PositionMap from graph.hpp).

#include "graph.hpp"

#include <cmath>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace planarvibe::geo {

inline bool is_finite(double x) { return std::isfinite(x); }

// Face area helpers. `face` is a sequence of node ids.
double polygon_area2(const std::vector<int>& face, const PositionMap& pos);
double polygon_area_abs(const std::vector<int>& face, const PositionMap& pos);

// Point helpers (pair-of-doubles).
inline Point point_sub(Point p, Point q) { return {p[0] - q[0], p[1] - q[1]}; }
inline Point point_add(Point p, Point q) { return {p[0] + q[0], p[1] + q[1]}; }
inline Point point_scale(double s, Point p) { return {s * p[0], s * p[1]}; }
inline double point_dot(Point p, Point q) { return p[0] * q[0] + p[1] * q[1]; }
inline Point point_rot90(Point p) { return {-p[1], p[0]}; }
inline double point_norm(Point p) { return std::sqrt(point_dot(p, p)); }
inline bool point_equals(Point a, Point b, double eps) {
    return std::abs(a[0] - b[0]) <= eps && std::abs(a[1] - b[1]) <= eps;
}

// Flat-vector helpers.
inline double vec_dot(const std::vector<double>& a, const std::vector<double>& b) {
    double s = 0.0;
    size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i) s += a[i] * b[i];
    return s;
}
inline double vec_norm(const std::vector<double>& a) { return std::sqrt(vec_dot(a, a)); }

// Segment-intersection primitives.
inline double triangle_area2(Point a, Point b, Point c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
bool point_on_segment(Point a, Point b, Point p, double eps);
bool point_on_segment_interior(Point a, Point b, Point p, double eps);
bool segments_intersect_or_touch(Point a, Point b, Point c, Point d, double eps);

// Drawing-level queries.
double compute_drawing_diameter(int n, const PositionMap& pos);
double outer_face_diameter(const PositionMap& pos, const std::vector<int>& outer_face);
Point compute_face_centroid(const PositionMap& pos, const std::vector<int>& face);

// String-keyed variants for layouts that work with names (CEG etc).
Point compute_face_centroid_names(const std::unordered_map<std::string, Point>& pos,
                                  const std::vector<std::string>& face);
std::unordered_map<std::string, Point> rotate_position_map_names(
    const std::unordered_map<std::string, Point>& pos, Point center, double angle);

// Planar-crossing brute force (O(m² + n·m)). Mirrors geometry-utils.js.
bool has_position_crossings(const PositionMap& pos,
                            const std::vector<std::pair<int,int>>& edges);

// Viewport normalization (used by random + 'input' pseudo-layout).
constexpr double VIEWPORT_WIDTH = 900.0;
constexpr double VIEWPORT_HEIGHT = 620.0;
PositionMap normalize_position_map_to_viewport(
    const PositionMap& pos,
    double width = VIEWPORT_WIDTH,
    double height = VIEWPORT_HEIGHT);

// Map filters. C++ variants take `n` (graph size) and a PositionMap indexed
// 0..n-1; they return a copy with the non-finite slots cleared.
PositionMap copy_position_map(const PositionMap& pos);
PositionMap filter_position_map(const PositionMap& pos, int n);

// Stats helpers used by metrics.
double compute_quantile(std::vector<double> values, double q = 0.2);
std::vector<double> collect_positive_gaps(const std::vector<double>& sorted_values, double range_);

} // namespace planarvibe::geo
