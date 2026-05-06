"""Geometric primitives and drawing checks.

Literal port of static/js/geometry-utils.js.

Positions are represented as dicts mapping node-id -> (x, y) tuples. A
`Point` type alias is used for `(x, y)` pairs. Node ids must be strings, as in
JS; callers feeding integers should stringify first (load_benchmark already
produces strings).
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

# Type aliases
Point = tuple[float, float]
PositionMap = dict[str, Point]

# Defaults that JS reads from `global.PlanarVibeViewportDefaults`.
VIEWPORT_WIDTH = 900
VIEWPORT_HEIGHT = 620


def _as_str(x) -> str:
    return x if isinstance(x, str) else str(x)


def polygon_area2(face: Sequence, pos_by_id: PositionMap) -> float:
    if not face or len(face) < 3:
        return 0.0
    n = len(face)
    total = 0.0
    for i in range(n):
        a = pos_by_id.get(_as_str(face[i]))
        b = pos_by_id.get(_as_str(face[(i + 1) % n]))
        if a is None or b is None:
            return 0.0
        total += a[0] * b[1] - b[0] * a[1]
    return total


def polygon_area_abs(face: Sequence, pos_by_id: PositionMap) -> float:
    return abs(polygon_area2(face, pos_by_id)) / 2.0


# Point helpers (tuple-based).
def point_add(p: Point, q: Point) -> Point:
    return (p[0] + q[0], p[1] + q[1])


def point_sub(p: Point, q: Point) -> Point:
    return (p[0] - q[0], p[1] - q[1])


def point_scale(s: float, p: Point) -> Point:
    return (s * p[0], s * p[1])


def point_dot(p: Point, q: Point) -> float:
    return p[0] * q[0] + p[1] * q[1]


def point_rot90(p: Point) -> Point:
    return (-p[1], p[0])


def point_norm(p: Point) -> float:
    return math.sqrt(point_dot(p, p))


def point_equals(a: Point, b: Point, eps: float) -> bool:
    return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps


# Flat-vector helpers.
def vec_dot(a: Sequence[float], b: Sequence[float]) -> float:
    s = 0.0
    for ai, bi in zip(a, b):
        s += ai * bi
    return s


def vec_norm(a: Sequence[float]) -> float:
    return math.sqrt(vec_dot(a, a))


def vec_add_scaled(a: Sequence[float], b: Sequence[float], alpha: float) -> list[float]:
    return [ai + alpha * bi for ai, bi in zip(a, b)]


def vec_sub(a: Sequence[float], b: Sequence[float]) -> list[float]:
    return [ai - bi for ai, bi in zip(a, b)]


def vec_scale(a: Sequence[float], alpha: float) -> list[float]:
    return [alpha * ai for ai in a]


def create_zero_vector(n: int) -> list[float]:
    length = max(0, int(n or 0))
    return [0.0] * length


def compute_quantile(values: Sequence[float], q: float | None = None) -> float | None:
    if not values:
        return None
    qq = 0.2 if not _is_finite(q) else max(0.0, min(1.0, float(q)))
    sorted_vals = sorted(values)
    idx = qq * (len(sorted_vals) - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    t = idx - lo
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] * (1 - t) + sorted_vals[hi] * t


def collect_positive_gaps(sorted_values: Sequence[float], range_: float) -> list[float]:
    gaps: list[float] = []
    if not sorted_values or len(sorted_values) < 2:
        return gaps
    range_val = range_ if _is_finite(range_) else 0.0
    min_positive_gap = max(1e-12, range_val * 1e-12)
    for i in range(1, len(sorted_values)):
        gap = sorted_values[i] - sorted_values[i - 1]
        if gap > min_positive_gap:
            gaps.append(gap)
    return gaps


def orient_face_ccw(face: Sequence, pos_by_id: PositionMap) -> list[str]:
    out = [_as_str(x) for x in face]
    if polygon_area2(out, pos_by_id) < 0:
        out.reverse()
    return out


def outer_face_diameter(pos_by_id: PositionMap, outer_face: Sequence) -> float:
    face = list(outer_face) if outer_face else []
    diameter = 0.0
    for i, fi in enumerate(face):
        a = pos_by_id.get(_as_str(fi))
        if a is None or not _is_finite(a[0]) or not _is_finite(a[1]):
            continue
        for j in range(i + 1, len(face)):
            b = pos_by_id.get(_as_str(face[j]))
            if b is None or not _is_finite(b[0]) or not _is_finite(b[1]):
                continue
            dist = math.hypot(a[0] - b[0], a[1] - b[1])
            if dist > diameter:
                diameter = dist
    return diameter if diameter > 1e-12 else 1.0


def triangle_area2(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def point_on_segment(a: Point, b: Point, p: Point, eps: float) -> bool:
    return (
        min(a[0], b[0]) - eps <= p[0] <= max(a[0], b[0]) + eps
        and min(a[1], b[1]) - eps <= p[1] <= max(a[1], b[1]) + eps
    )


def point_on_segment_interior(a: Point, b: Point, p: Point, eps: float) -> bool:
    if not point_on_segment(a, b, p, eps):
        return False
    if abs(triangle_area2(a, b, p)) > eps:
        return False
    if abs(p[0] - a[0]) <= eps and abs(p[1] - a[1]) <= eps:
        return False
    if abs(p[0] - b[0]) <= eps and abs(p[1] - b[1]) <= eps:
        return False
    return True


def segments_intersect_or_touch(a: Point, b: Point, c: Point, d: Point, eps: float) -> bool:
    o1 = triangle_area2(a, b, c)
    o2 = triangle_area2(a, b, d)
    o3 = triangle_area2(c, d, a)
    o4 = triangle_area2(c, d, b)
    if (((o1 > eps and o2 < -eps) or (o1 < -eps and o2 > eps))
            and ((o3 > eps and o4 < -eps) or (o3 < -eps and o4 > eps))):
        return True
    if abs(o1) <= eps and point_on_segment(a, b, c, eps):
        return True
    if abs(o2) <= eps and point_on_segment(a, b, d, eps):
        return True
    if abs(o3) <= eps and point_on_segment(c, d, a, eps):
        return True
    if abs(o4) <= eps and point_on_segment(c, d, b, eps):
        return True
    return False


def compute_drawing_diameter(node_ids: Iterable[str], pos_by_id: PositionMap) -> float:
    min_x = math.inf
    min_y = math.inf
    max_x = -math.inf
    max_y = -math.inf
    any_found = False
    for raw_id in node_ids:
        nid = _as_str(raw_id)
        p = pos_by_id.get(nid) if pos_by_id else None
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        any_found = True
        if p[0] < min_x:
            min_x = p[0]
        if p[1] < min_y:
            min_y = p[1]
        if p[0] > max_x:
            max_x = p[0]
        if p[1] > max_y:
            max_y = p[1]
    if not any_found:
        return 1.0
    dx = max_x - min_x
    dy = max_y - min_y
    d = math.sqrt(dx * dx + dy * dy)
    return d if d > 1e-9 else 1.0


def copy_position_map(pos_by_id: PositionMap | None) -> PositionMap:
    out: PositionMap = {}
    if not pos_by_id:
        return out
    for nid, p in pos_by_id.items():
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        out[nid] = (p[0], p[1])
    return out


def filter_position_map(pos_by_id: PositionMap | None, node_ids: Iterable[str]) -> PositionMap:
    out: PositionMap = {}
    if not pos_by_id:
        return out
    for nid in node_ids:
        p = pos_by_id.get(nid)
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        out[nid] = (p[0], p[1])
    return out


def normalize_position_map_to_viewport(
    pos_by_id: PositionMap | None,
    width: float = VIEWPORT_WIDTH,
    height: float = VIEWPORT_HEIGHT,
) -> PositionMap:
    source = copy_position_map(pos_by_id or {})
    ids = list(source.keys())
    if not ids:
        return source
    padding = 24.0

    min_x = min_y = math.inf
    max_x = max_y = -math.inf
    for nid in ids:
        p = source[nid]
        if p[0] < min_x:
            min_x = p[0]
        if p[1] < min_y:
            min_y = p[1]
        if p[0] > max_x:
            max_x = p[0]
        if p[1] > max_y:
            max_y = p[1]
    if not (_is_finite(min_x) and _is_finite(min_y) and _is_finite(max_x) and _is_finite(max_y)):
        return source

    box_w = max_x - min_x
    box_h = max_y - min_y
    inner_w = max(1.0, width - 2 * padding)
    inner_h = max(1.0, height - 2 * padding)

    if box_w < 1e-9 and box_h < 1e-9:
        for nid in ids:
            source[nid] = (width / 2.0, height / 2.0)
        return source

    safe_w = max(box_w, 1e-9)
    safe_h = max(box_h, 1e-9)
    scale = min(inner_w / safe_w, inner_h / safe_h)
    if not _is_finite(scale) or scale <= 0:
        scale = 1.0
    offset_x = (width - box_w * scale) / 2.0
    offset_y = (height - box_h * scale) / 2.0
    for nid in ids:
        x, y = source[nid]
        source[nid] = ((x - min_x) * scale + offset_x, (y - min_y) * scale + offset_y)
    return source


def compute_face_centroid(pos_by_id: PositionMap, face: Sequence) -> Point:
    ids = list(face) if face else []
    sx = 0.0
    sy = 0.0
    count = 0
    for fi in ids:
        p = pos_by_id.get(_as_str(fi))
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        sx += p[0]
        sy += p[1]
        count += 1
    if count < 1:
        return (0.0, 0.0)
    return (sx / count, sy / count)


def rotate_position_map(pos_by_id: PositionMap, center: Point, angle: float) -> PositionMap:
    out: PositionMap = {}
    c = math.cos(angle)
    s = math.sin(angle)
    for nid, p in (pos_by_id or {}).items():
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        dx = p[0] - center[0]
        dy = p[1] - center[1]
        out[nid] = (center[0] + c * dx - s * dy, center[1] + s * dx + c * dy)
    return out


def has_position_crossings(pos_by_id: PositionMap, edge_pairs: Sequence[tuple[str, str]]) -> bool:
    EPS = 1e-9
    m = len(edge_pairs)

    for i in range(m):
        s1 = _as_str(edge_pairs[i][0])
        t1 = _as_str(edge_pairs[i][1])
        p1 = pos_by_id.get(s1)
        q1 = pos_by_id.get(t1)
        if p1 is None or q1 is None:
            continue
        for j in range(i + 1, m):
            s2 = _as_str(edge_pairs[j][0])
            t2 = _as_str(edge_pairs[j][1])
            if s1 == s2 or s1 == t2 or t1 == s2 or t1 == t2:
                continue
            p2 = pos_by_id.get(s2)
            q2 = pos_by_id.get(t2)
            if p2 is None or q2 is None:
                continue
            if segments_intersect_or_touch(p1, q1, p2, q2, EPS):
                return True

    node_ids = list(pos_by_id.keys()) if pos_by_id else []
    for nid in node_ids:
        p = pos_by_id.get(nid)
        if p is None or not _is_finite(p[0]) or not _is_finite(p[1]):
            continue
        for j in range(m):
            u = _as_str(edge_pairs[j][0])
            v = _as_str(edge_pairs[j][1])
            if nid == u or nid == v:
                continue
            a = pos_by_id.get(u)
            b = pos_by_id.get(v)
            if a is None or b is None:
                continue
            area2 = triangle_area2(a, b, p)
            if abs(area2) <= EPS and point_on_segment_interior(a, b, p, EPS):
                return True
    return False


# Small helpers to keep parity with Number.isFinite.
def _is_finite(x) -> bool:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)
