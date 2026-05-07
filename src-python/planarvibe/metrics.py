"""Drawing-quality metrics.

Literal port of static/js/metrics.js. Each function returns a dict with an
`ok` key matching the JS shape (so callers can do the same null-handling).

Depends on:
  - geometry.compute_quantile, collect_positive_gaps, polygon_area_abs,
    triangle_area2, compute_drawing_diameter (matching JS GeometryUtils).
  - planar_graph.find_outer_face_index (matching JS PlanarGraphUtils), used
    by face-dependent metrics. Imported lazily to avoid a cycle at import
    time if planar_graph depends on metrics in the future.
"""

from __future__ import annotations

import math
from typing import Sequence

from . import geometry as geo


USE_SIMPLE_AXIS_ALIGNMENT = True
SIMPLE_AXIS_ALIGNMENT_EPSILON = 1e-5
USE_SQUARE_NODE_UNIFORMITY_GRID = True


def uniform_ideal_distribution(n: int) -> list[float]:
    if not (n > 0):
        return []
    v = 1.0 / n
    return [v] * n


def compute_uniformity_score(values: Sequence[float] | None, ideal_values: Sequence[float] | None) -> float | None:
    if values is None or ideal_values is None:
        return None
    if len(values) == 0 or len(values) != len(ideal_values):
        return None
    k = len(values)
    if k == 1:
        return 1.0

    sum_sq = 0.0
    sum_ideal_sq = 0.0
    min_ideal = math.inf
    for x, p in zip(values, ideal_values):
        if not _finite(x) or not _finite(p):
            return None
        d = x - p
        sum_sq += d * d
        sum_ideal_sq += p * p
        if p < min_ideal:
            min_ideal = p
    if not math.isfinite(min_ideal):
        return None

    max_sq = 1 - 2 * min_ideal + sum_ideal_sq
    if not (max_sq > 0):
        return 1.0
    normalized = math.sqrt(sum_sq / max_sq)
    quality = 1 - normalized
    return max(0.0, min(1.0, quality))


def build_weighted_distribution_result(
    raw_values: Sequence[float],
    raw_ideal_weights: Sequence[float],
    no_data_reason: str,
    degenerate_reason: str,
) -> dict:
    if (not raw_values
            or len(raw_values) == 0
            or raw_ideal_weights is None
            or len(raw_ideal_weights) != len(raw_values)):
        return {"ok": False, "reason": no_data_reason}

    value_total = sum(raw_values)
    weight_total = sum(raw_ideal_weights)
    if not (value_total > 0) or not (weight_total > 0):
        return {"ok": False, "reason": degenerate_reason}

    pairs: list[tuple[float, float]] = []
    for v, w in zip(raw_values, raw_ideal_weights):
        value = v / value_total
        ideal = w / weight_total
        if not _finite(value) or not _finite(ideal) or not (ideal > 0):
            return {"ok": False, "reason": degenerate_reason}
        pairs.append((value, ideal))
    # Match JS sort: ideal asc, value asc as tie-breaker.
    pairs.sort(key=lambda p: (p[1], p[0]))
    normalized = [p[0] for p in pairs]
    ideals = [p[1] for p in pairs]
    return {
        "ok": True,
        "values": normalized,
        "idealValues": ideals,
        "quality": compute_uniformity_score(normalized, ideals),
    }


def _cluster_sorted_values(sorted_values: Sequence[float], tolerance: float) -> list[int]:
    if not sorted_values or len(sorted_values) == 0:
        return []
    eps = max(0.0, tolerance) if _finite(tolerance) else 0.0
    sizes = [1]
    for i in range(1, len(sorted_values)):
        gap = sorted_values[i] - sorted_values[i - 1]
        if gap > eps:
            sizes.append(1)
        else:
            sizes[-1] += 1
    return sizes


def _cluster_sorted_values_by_span(sorted_values: Sequence[float], tolerance: float) -> list[int]:
    if not sorted_values or len(sorted_values) == 0:
        return []
    eps = max(0.0, tolerance) if _finite(tolerance) else 0.0
    sizes = [1]
    cluster_start = sorted_values[0]
    for i in range(1, len(sorted_values)):
        if sorted_values[i] - cluster_start > eps:
            sizes.append(1)
            cluster_start = sorted_values[i]
        else:
            sizes[-1] += 1
    return sizes


def _compute_effective_line_count(cluster_sizes: Sequence[int], total_count: int) -> float | None:
    if not cluster_sizes or len(cluster_sizes) == 0 or not (total_count > 0):
        return None
    sum_sq = 0.0
    for size in cluster_sizes:
        frac = size / total_count
        sum_sq += frac * frac
    if not (sum_sq > 0):
        return None
    return 1 / sum_sq


def _compute_axis_clustering(values: Sequence[float], options: dict | None = None) -> dict | None:
    if not values or len(values) == 0:
        return None
    opts = options or {}
    sorted_vals = sorted(values)
    vmin = sorted_vals[0]
    vmax = sorted_vals[-1]
    rng = vmax - vmin
    raw_tolerance: float | None = None
    tolerance = 0.0
    source = "range-zero"

    if rng > 0:
        if _finite(opts.get("tolerance")):
            tolerance = max(0.0, float(opts["tolerance"]))
            raw_tolerance = tolerance
            source = "fixed"
        else:
            gaps = geo.collect_positive_gaps(sorted_vals, rng)
            quantile = geo.compute_quantile(gaps, opts.get("quantile"))
            scale = float(opts["toleranceScale"]) if _finite(opts.get("toleranceScale")) else 2.0
            min_tolerance = max(0.0, float(opts["minTolerance"])) if _finite(opts.get("minTolerance")) else max(1e-12, rng * 1e-9)
            cap_fraction = max(0.0, float(opts["toleranceCapFraction"])) if _finite(opts.get("toleranceCapFraction")) else 0.05
            fallback_fraction = max(0.0, float(opts["fallbackToleranceFraction"])) if _finite(opts.get("fallbackToleranceFraction")) else 0.01
            if len(gaps) >= 3 and _finite(quantile):
                raw_tolerance = scale * quantile
                tolerance = min(rng * cap_fraction, max(min_tolerance, raw_tolerance))
                source = "quantile"
            else:
                raw_tolerance = rng * fallback_fraction
                tolerance = raw_tolerance
                source = "fallback"

    cluster_sizes = _cluster_sorted_values(sorted_vals, tolerance)
    effective_line_count = _compute_effective_line_count(cluster_sizes, len(sorted_vals))
    return {
        "sortedValues": sorted_vals,
        "clusterSizes": cluster_sizes,
        "lineCount": len(cluster_sizes),
        "effectiveLineCount": effective_line_count,
        "tolerance": tolerance,
        "rawTolerance": raw_tolerance,
        "toleranceSource": source,
        "range": rng,
    }


def _compute_simple_axis_clustering(values: Sequence[float]) -> dict | None:
    if not values or len(values) == 0:
        return None
    sorted_vals = sorted(values)
    vmin = sorted_vals[0]
    vmax = sorted_vals[-1]
    rng = vmax - vmin
    if rng > 0:
        normalized = [(v - vmin) / rng for v in sorted_vals]
    else:
        normalized = [0.0] * len(sorted_vals)

    tolerance = SIMPLE_AXIS_ALIGNMENT_EPSILON if rng > 0 else 0.0
    cluster_sizes = _cluster_sorted_values_by_span(normalized, tolerance)
    effective_line_count = _compute_effective_line_count(cluster_sizes, len(sorted_vals))
    return {
        "sortedValues": sorted_vals,
        "normalizedValues": normalized,
        "clusterSizes": cluster_sizes,
        "lineCount": len(cluster_sizes),
        "effectiveLineCount": effective_line_count,
        "tolerance": tolerance,
        "rawTolerance": tolerance,
        "toleranceSource": "normalized-fixed" if rng > 0 else "range-zero",
        "range": rng,
    }


def compute_axis_alignment_score(node_ids: Sequence[str], pos_by_id: dict, options: dict | None = None) -> dict:
    if not node_ids or len(node_ids) == 0:
        return {"ok": False, "reason": "No nodes"}
    opts = options or {}
    xs: list[float] = []
    ys: list[float] = []
    used: list[str] = []
    for raw_id in node_ids:
        nid = str(raw_id)
        p = pos_by_id.get(nid)
        if p is None or not _finite(p[0]) or not _finite(p[1]):
            continue
        xs.append(p[0])
        ys.append(p[1])
        used.append(nid)
    if len(xs) < 2:
        return {"ok": False, "reason": "Not enough positioned nodes"}

    if USE_SIMPLE_AXIS_ALIGNMENT:
        x_axis = _compute_simple_axis_clustering(xs)
        y_axis = _compute_simple_axis_clustering(ys)
    else:
        shared_tolerance = opts["tolerance"] if _finite(opts.get("tolerance")) else None
        x_axis = _compute_axis_clustering(xs, {
            "tolerance": opts["toleranceX"] if _finite(opts.get("toleranceX")) else shared_tolerance,
            "quantile": opts.get("quantile"),
            "toleranceScale": opts.get("toleranceScale"),
            "toleranceCapFraction": opts.get("toleranceCapFraction"),
            "minTolerance": opts.get("minToleranceX"),
            "fallbackToleranceFraction": opts.get("fallbackToleranceFraction"),
        })
        y_axis = _compute_axis_clustering(ys, {
            "tolerance": opts["toleranceY"] if _finite(opts.get("toleranceY")) else shared_tolerance,
            "quantile": opts.get("quantile"),
            "toleranceScale": opts.get("toleranceScale"),
            "toleranceCapFraction": opts.get("toleranceCapFraction"),
            "minTolerance": opts.get("minToleranceY"),
            "fallbackToleranceFraction": opts.get("fallbackToleranceFraction"),
        })
    if (x_axis is None or y_axis is None
            or not _finite(x_axis["effectiveLineCount"])
            or not _finite(y_axis["effectiveLineCount"])):
        return {"ok": False, "reason": "Invalid axis clustering"}

    denom = len(xs) - 1
    score_x = (len(xs) - x_axis["effectiveLineCount"]) / denom if denom > 0 else 1.0
    score_y = (len(ys) - y_axis["effectiveLineCount"]) / denom if denom > 0 else 1.0
    score = (score_x + score_y) / 2.0
    return {
        "ok": True,
        "score": max(0.0, min(1.0, score)),
        "scoreX": max(0.0, min(1.0, score_x)),
        "scoreY": max(0.0, min(1.0, score_y)),
        "usedNodeCount": len(xs),
        "usedNodeIds": used,
        "lineCountX": x_axis["lineCount"],
        "lineCountY": y_axis["lineCount"],
        "effectiveLineCountX": x_axis["effectiveLineCount"],
        "effectiveLineCountY": y_axis["effectiveLineCount"],
        "clusterSizesX": x_axis["clusterSizes"],
        "clusterSizesY": y_axis["clusterSizes"],
        "toleranceX": x_axis["tolerance"],
        "toleranceY": y_axis["tolerance"],
        "toleranceSourceX": x_axis["toleranceSource"],
        "toleranceSourceY": y_axis["toleranceSource"],
    }


def compute_uniform_face_area_score(
    node_ids: Sequence[str],
    edge_pairs: Sequence[tuple[str, str]],
    pos_by_id: dict,
    embedding: dict | None,
) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "reason": "Planar embedding required"}
    faces = embedding.get("faces")
    if not faces or len(faces) == 0:
        return {"ok": False, "reason": "No faces available"}

    # Lazy import to avoid circular import on module load.
    from . import planar_graph as pg

    outer_idx = pg.find_outer_face_index(faces, embedding.get("outerFace") or [])
    areas: list[float] = []
    ideal_weights: list[float] = []
    for i, face in enumerate(faces):
        if i == outer_idx:
            continue
        a = geo.polygon_area_abs(face, pos_by_id)
        if a > 0:
            areas.append(a)
            ideal_weights.append(max(1.0, len(face) - 2))

    if len(areas) == 0:
        return {"ok": True, "values": [], "idealValues": [], "quality": 1.0, "faceCount": 0}

    result = build_weighted_distribution_result(
        areas, ideal_weights,
        "No bounded face areas available",
        "Degenerate face areas",
    )
    if not result.get("ok"):
        return result
    result["faceCount"] = len(result["values"])
    return result


def _is_convex_face(face: Sequence[str], pos_by_id: dict, eps: float) -> bool:
    if not face or len(face) < 3:
        return False
    sign = 0
    n = len(face)
    for i in range(n):
        prev = pos_by_id.get(str(face[(i - 1) % n]))
        cur = pos_by_id.get(str(face[i]))
        nxt = pos_by_id.get(str(face[(i + 1) % n]))
        if (prev is None or cur is None or nxt is None
                or not _finite(prev[0]) or not _finite(prev[1])
                or not _finite(cur[0]) or not _finite(cur[1])
                or not _finite(nxt[0]) or not _finite(nxt[1])):
            return False
        turn = geo.triangle_area2(prev, cur, nxt)
        if abs(turn) <= eps:
            return False
        current_sign = 1 if turn > 0 else -1
        if sign == 0:
            sign = current_sign
        elif current_sign != sign:
            return False
    return True


def compute_convexity_score(
    node_ids: Sequence[str],
    edge_pairs: Sequence[tuple[str, str]],
    pos_by_id: dict,
    embedding: dict | None,
) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "reason": "Planar embedding required"}
    faces = embedding.get("faces")
    if not faces or len(faces) == 0:
        return {"ok": False, "reason": "No faces available"}

    from . import planar_graph as pg

    outer_idx = pg.find_outer_face_index(faces, embedding.get("outerFace") or [])
    eps = max(1e-12, geo.compute_drawing_diameter(node_ids or [], pos_by_id or {}) * 1e-9)
    face_count = 0
    convex_face_count = 0
    for i, face in enumerate(faces):
        if i == outer_idx:
            continue
        face_count += 1
        if _is_convex_face(face, pos_by_id, eps):
            convex_face_count += 1
    if face_count == 0:
        return {"ok": True, "score": 1.0, "convexFaceCount": 0, "faceCount": 0}
    return {
        "ok": True,
        "score": convex_face_count / face_count,
        "convexFaceCount": convex_face_count,
        "faceCount": face_count,
    }


def compute_edge_length_ratio(edge_pairs: Sequence[tuple[str, str]], pos_by_id: dict) -> dict:
    if not edge_pairs or len(edge_pairs) == 0:
        return {"ok": False, "reason": "No edges"}
    min_len = math.inf
    max_len = 0.0
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if (pu is None or pv is None
                or not _finite(pu[0]) or not _finite(pu[1])
                or not _finite(pv[0]) or not _finite(pv[1])):
            return {"ok": False, "reason": "Metrics unavailable"}
        dx = pu[0] - pv[0]
        dy = pu[1] - pv[1]
        length = math.sqrt(dx * dx + dy * dy)
        if not (length > 0):
            continue
        if length < min_len:
            min_len = length
        if length > max_len:
            max_len = length
    if not (max_len > 0) or not math.isfinite(min_len):
        return {"ok": False, "reason": "No edge lengths available"}
    return {"ok": True, "ratio": min_len / max_len, "minLength": min_len, "maxLength": max_len}


def _collect_positioned_points(node_ids: Sequence[str], pos_by_id: dict) -> list[dict]:
    out: list[dict] = []
    if not node_ids:
        return out
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id.get(nid)
        if p is None or not _finite(p[0]) or not _finite(p[1]):
            continue
        out.append({"id": nid, "x": p[0], "y": p[1]})
    return out


def compute_aspect_ratio_score(node_ids: Sequence[str], pos_by_id: dict) -> dict:
    points = _collect_positioned_points(node_ids, pos_by_id)
    if not points:
        return {"ok": False, "reason": "No positioned nodes"}
    min_x = min(p["x"] for p in points)
    max_x = max(p["x"] for p in points)
    min_y = min(p["y"] for p in points)
    max_y = max(p["y"] for p in points)
    width = max_x - min_x
    height = max_y - min_y
    min_side = min(width, height)
    max_side = max(width, height)
    return {
        "ok": True,
        "score": 1.0 if not (min_side > 0) else (min_side / max_side),
        "width": width,
        "height": height,
        "usedNodeCount": len(points),
    }


def compute_node_uniformity_score(node_ids: Sequence[str], pos_by_id: dict) -> dict:
    points = _collect_positioned_points(node_ids, pos_by_id)
    n = len(points)
    if n == 0:
        return {"ok": False, "reason": "No positioned nodes"}
    min_x = min(p["x"] for p in points)
    max_x = max(p["x"] for p in points)
    min_y = min(p["y"] for p in points)
    max_y = max(p["y"] for p in points)
    width = max_x - min_x
    height = max_y - min_y
    rows = max(1, int(math.floor(math.sqrt(n))))
    cols = rows if USE_SQUARE_NODE_UNIFORMITY_GRID else max(1, int(math.ceil(n / rows)))
    cell_count = rows * cols
    counts = [0] * cell_count
    for p in points:
        col = 0
        row = 0
        if width > 0:
            col = int(math.floor(((p["x"] - min_x) / width) * cols))
            if col < 0:
                col = 0
            if col >= cols:
                col = cols - 1
        if height > 0:
            row = int(math.floor(((p["y"] - min_y) / height) * rows))
            if row < 0:
                row = 0
            if row >= rows:
                row = rows - 1
        counts[row * cols + col] += 1
    mu = n / cell_count
    deviation = 0.0
    for c in counts:
        deviation += abs(c - mu)
    max_deviation = (2 * n * (cell_count - 1)) / cell_count
    return {
        "ok": True,
        "score": 1.0 if not (max_deviation > 0) else max(0.0, min(1.0, 1 - (deviation / max_deviation))),
        "rows": rows,
        "cols": cols,
        "cellCount": cell_count,
        "deviation": deviation,
        "maxDeviation": max_deviation,
        "counts": counts,
    }


def compute_edge_length_deviation_score(edge_pairs: Sequence[tuple[str, str]], pos_by_id: dict) -> dict:
    if not edge_pairs or len(edge_pairs) == 0:
        return {"ok": False, "reason": "No edges"}
    lengths: list[float] = []
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if (pu is None or pv is None
                or not _finite(pu[0]) or not _finite(pu[1])
                or not _finite(pv[0]) or not _finite(pv[1])):
            return {"ok": False, "reason": "Metrics unavailable"}
        dx = pu[0] - pv[0]
        dy = pu[1] - pv[1]
        length = math.sqrt(dx * dx + dy * dy)
        if length > 0:
            lengths.append(length)
    if not lengths:
        return {"ok": False, "reason": "No edge lengths available"}
    mean_length = sum(lengths) / len(lengths)
    avg_rel_dev = sum(abs(x - mean_length) / mean_length for x in lengths) / len(lengths)
    return {
        "ok": True,
        "score": 1.0 / (1 + avg_rel_dev),
        "meanLength": mean_length,
        "avgRelativeDeviation": avg_rel_dev,
        "usedEdgeCount": len(lengths),
    }


def _angle_to_nearest_orthogonal(angle: float) -> float:
    half_pi = math.pi / 2
    wrapped = angle or 0
    wrapped = wrapped % half_pi
    if wrapped < 0:
        wrapped += half_pi
    return min(wrapped, half_pi - wrapped)


def compute_edge_orthogonality_score(edge_pairs: Sequence[tuple[str, str]], pos_by_id: dict) -> dict:
    if not edge_pairs or len(edge_pairs) == 0:
        return {"ok": False, "reason": "No edges"}
    used = 0
    dev_sum = 0.0
    max_dev = math.pi / 4
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if (pu is None or pv is None
                or not _finite(pu[0]) or not _finite(pu[1])
                or not _finite(pv[0]) or not _finite(pv[1])):
            return {"ok": False, "reason": "Metrics unavailable"}
        dx = pv[0] - pu[0]
        dy = pv[1] - pu[1]
        length = math.sqrt(dx * dx + dy * dy)
        if not (length > 0):
            continue
        dev_sum += _angle_to_nearest_orthogonal(math.atan2(dy, dx))
        used += 1
    if used == 0:
        return {"ok": False, "reason": "No edge lengths available"}
    mean_deviation = dev_sum / used
    return {
        "ok": True,
        "score": max(0.0, min(1.0, 1 - (mean_deviation / max_dev))),
        "meanDeviation": mean_deviation,
        "usedEdgeCount": used,
    }


def compute_spacing_uniformity_score(
    node_ids: Sequence[str],
    pos_by_id: dict,
    options: dict | None = None,
) -> dict:
    opts = options or {}
    trim_quantile = max(0.0, min(0.45, float(opts["boundaryTrimQuantile"]))) if _finite(opts.get("boundaryTrimQuantile")) else 0.1

    if not node_ids or len(node_ids) == 0:
        return {"ok": False, "reason": "No nodes"}
    points: list[dict] = []
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id.get(nid)
        if p is None or not _finite(p[0]) or not _finite(p[1]):
            continue
        points.append({"id": nid, "x": p[0], "y": p[1]})
    if len(points) < 2:
        return {"ok": False, "reason": "Not enough positioned nodes"}

    min_x = min(p["x"] for p in points)
    max_x = max(p["x"] for p in points)
    min_y = min(p["y"] for p in points)
    max_y = max(p["y"] for p in points)

    kept = list(points)
    if trim_quantile > 0 and len(points) >= 10:
        boundary_dist = []
        for i, p in enumerate(points):
            d = min(p["x"] - min_x, max_x - p["x"], p["y"] - min_y, max_y - p["y"])
            boundary_dist.append((i, d))
        boundary_dist.sort(key=lambda ab: ab[1])
        drop_count = int(math.floor(trim_quantile * len(boundary_dist)))
        keep_mask = set()
        for i in range(drop_count, len(boundary_dist)):
            keep_mask.add(boundary_dist[i][0])
        trimmed = [points[i] for i in range(len(points)) if i in keep_mask]
        if len(trimmed) >= 2:
            kept = trimmed

    nn: list[float] = []
    for i in range(len(kept)):
        best = math.inf
        for j in range(len(kept)):
            if i == j:
                continue
            dx = kept[i]["x"] - kept[j]["x"]
            dy = kept[i]["y"] - kept[j]["y"]
            dist = math.sqrt(dx * dx + dy * dy)
            if dist < best:
                best = dist
        if math.isfinite(best) and best > 0:
            nn.append(best)
    if not nn:
        return {"ok": False, "reason": "Not enough valid nearest-neighbor distances"}
    mean = sum(nn) / len(nn)
    if not (mean > 0):
        return {"ok": False, "reason": "Degenerate nearest-neighbor distances"}
    var_sum = sum((x - mean) ** 2 for x in nn)
    std = math.sqrt(var_sum / len(nn))
    cv = std / mean
    score = 1.0 / (1 + cv)
    if not math.isfinite(score):
        return {"ok": False, "reason": "Invalid spacing score"}
    return {
        "ok": True,
        "score": max(0.0, min(1.0, score)),
        "cv": cv,
        "meanNN": mean,
        "stdNN": std,
        "usedNodeCount": len(kept),
    }


def compute_distribution_quality(values: Sequence[float] | None) -> float | None:
    ideal = uniform_ideal_distribution(len(values) if values is not None else 0)
    return compute_uniformity_score(values or [], ideal)


def compute_angular_resolution_score(graph, pos_by_id: dict) -> dict:
    node_ids = graph.node_ids
    adjacency = graph.adjacency
    if not node_ids or len(node_ids) == 0:
        return {"ok": False, "reason": "No nodes"}
    TWO_PI = 2 * math.pi
    vertex_count = 0
    score_sum = 0.0
    ratios: list[float] = []
    for raw in node_ids:
        nid = str(raw)
        neighbors = adjacency.get(nid, [])
        if len(neighbors) < 2:
            continue
        p = pos_by_id.get(nid)
        if p is None or not _finite(p[0]) or not _finite(p[1]):
            return {"ok": False, "reason": "Metrics unavailable"}
        dirs: list[float] = []
        for n_raw in neighbors:
            q = pos_by_id.get(str(n_raw))
            if q is None or not _finite(q[0]) or not _finite(q[1]):
                return {"ok": False, "reason": "Metrics unavailable"}
            a = math.atan2(q[1] - p[1], q[0] - p[0])
            if a < 0:
                a += TWO_PI
            dirs.append(a)
        dirs.sort()
        min_gap = math.inf
        for j in range(len(dirs)):
            nxt = dirs[(j + 1) % len(dirs)]
            cur = dirs[j]
            gap = nxt - cur
            if gap <= 0:
                gap += TWO_PI
            if gap < min_gap:
                min_gap = gap
        ideal_gap = TWO_PI / len(dirs)
        ratio = min_gap / ideal_gap
        score_sum += ratio
        ratios.append(ratio)
        vertex_count += 1
    if vertex_count == 0:
        return {"ok": False, "reason": "No angle data"}
    ratios.sort()
    return {
        "ok": True,
        "score": max(0.0, min(1.0, score_sum / vertex_count)),
        "usedNodeCount": vertex_count,
        "values": ratios,
    }


def is_bipartite_graph(graph) -> bool:
    node_ids = graph.node_ids
    adjacency = graph.adjacency
    color: dict[str, int] = {}
    for raw in node_ids:
        start = str(raw)
        if start in color:
            continue
        color[start] = 0
        queue = [start]
        head = 0
        while head < len(queue):
            x = queue[head]
            head += 1
            for y in adjacency.get(x, []):
                if y not in color:
                    color[y] = 1 - color[x]
                    queue.append(y)
                elif color[y] == color[x]:
                    return False
    return True


def _finite(x) -> bool:
    if x is None or isinstance(x, bool):
        return False
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)
