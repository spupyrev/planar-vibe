"""Axis alignment (greedy). Port of static/js/alignment.js.

The port keeps position tuples immutable by cloning on mutation (matches JS's
`posById[id].x = ...` semantics since JS uses plain objects and we use tuples).
"""

from __future__ import annotations

import math
from typing import Sequence

from . import geometry as geo
from . import metrics as metric_mod


def _compute_axis_tolerance(values, options):
    if not values or len(values) < 2:
        return 0.0
    opts = options or {}
    if _finite(opts.get("tolerance")):
        return max(0.0, float(opts["tolerance"]))
    sorted_vals = sorted(values)
    rng = sorted_vals[-1] - sorted_vals[0]
    if not (rng > 0):
        return 0.0
    gaps = geo.collect_positive_gaps(sorted_vals, rng)
    quantile = geo.compute_quantile(gaps, opts.get("quantile"))
    scale = float(opts["toleranceScale"]) if _finite(opts.get("toleranceScale")) else 2.0
    min_tolerance = max(0.0, float(opts["minTolerance"])) if _finite(opts.get("minTolerance")) else max(1e-12, rng * 1e-9)
    cap_fraction = max(0.0, float(opts["toleranceCapFraction"])) if _finite(opts.get("toleranceCapFraction")) else 0.05
    fallback_fraction = max(0.0, float(opts["fallbackToleranceFraction"])) if _finite(opts.get("fallbackToleranceFraction")) else 0.01
    if len(gaps) >= 3 and _finite(quantile):
        return min(rng * cap_fraction, max(min_tolerance, scale * quantile))
    return rng * fallback_fraction


def _build_axis_groups(node_ids, pos_by_id, axis, tolerance):
    axis_idx = 0 if axis == "x" else 1
    entries = []
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id[nid]
        entries.append({"id": nid, "coord": p[axis_idx]})
    entries.sort(key=lambda e: e["coord"])
    if not entries:
        return []
    eps = max(0.0, tolerance) if _finite(tolerance) else 0.0
    groups = []
    current = {
        "ids": [entries[0]["id"]],
        "coord": entries[0]["coord"],
        "minCoord": entries[0]["coord"],
        "maxCoord": entries[0]["coord"],
        "totalCoord": entries[0]["coord"],
    }
    for i in range(1, len(entries)):
        entry = entries[i]
        prev = entries[i - 1]
        if entry["coord"] - prev["coord"] <= eps:
            current["ids"].append(entry["id"])
            current["maxCoord"] = entry["coord"]
            current["totalCoord"] += entry["coord"]
            current["coord"] = current["totalCoord"] / len(current["ids"])
        else:
            groups.append(current)
            current = {
                "ids": [entry["id"]],
                "coord": entry["coord"],
                "minCoord": entry["coord"],
                "maxCoord": entry["coord"],
                "totalCoord": entry["coord"],
            }
    groups.append(current)
    return groups


def _build_crossing_context(edge_pairs):
    edges = []
    incident = {}
    for i, (u_raw, v_raw) in enumerate(edge_pairs):
        u, v = str(u_raw), str(v_raw)
        edges.append({"u": u, "v": v})
        incident.setdefault(u, []).append(i)
        incident.setdefault(v, []).append(i)
    return {"edges": edges, "incidentEdgeIndexesByNode": incident}


def _boxes_overlap(a, b, c, d, eps):
    return (
        min(a[0], b[0]) - eps <= max(c[0], d[0])
        and min(c[0], d[0]) - eps <= max(a[0], b[0])
        and min(a[1], b[1]) - eps <= max(c[1], d[1])
        and min(c[1], d[1]) - eps <= max(a[1], b[1])
    )


def _edges_share_endpoint(a, b):
    return a["u"] == b["u"] or a["u"] == b["v"] or a["v"] == b["u"] or a["v"] == b["v"]


def _collect_affected_edge_indexes(context, affected_set, affected_ids):
    out = []
    flags = {}
    for raw in affected_ids:
        nid = str(raw)
        affected_set[nid] = True
        for ei in context["incidentEdgeIndexesByNode"].get(nid, []):
            if not flags.get(ei):
                flags[ei] = True
                out.append(ei)
    return out


def _has_local_crossings(context, node_ids, pos_by_id, affected_ids):
    EPS = 1e-9
    affected_set = {}
    indices = _collect_affected_edge_indexes(context, affected_set, affected_ids)
    edges = context["edges"]

    for ai in indices:
        ae = edges[ai]
        au = pos_by_id.get(ae["u"])
        av = pos_by_id.get(ae["v"])
        if au is None or av is None:
            continue
        for j, oe in enumerate(edges):
            if j == ai:
                continue
            if _edges_share_endpoint(ae, oe):
                continue
            ou = pos_by_id.get(oe["u"])
            ov = pos_by_id.get(oe["v"])
            if ou is None or ov is None or not _boxes_overlap(au, av, ou, ov, EPS):
                continue
            if geo.segments_intersect_or_touch(au, av, ou, ov, EPS):
                return True

    for raw in affected_ids:
        nid = str(raw)
        p = pos_by_id.get(nid)
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            continue
        for e in edges:
            if nid == e["u"] or nid == e["v"]:
                continue
            eu = pos_by_id.get(e["u"])
            ev = pos_by_id.get(e["v"])
            if eu is None or ev is None:
                continue
            if geo.point_on_segment_interior(eu, ev, p, EPS):
                return True

    for nid_raw in node_ids:
        nid = str(nid_raw)
        if affected_set.get(nid):
            continue
        np_ = pos_by_id.get(nid)
        if np_ is None or not math.isfinite(np_[0]) or not math.isfinite(np_[1]):
            continue
        for ei in indices:
            e = edges[ei]
            if nid == e["u"] or nid == e["v"]:
                continue
            eu = pos_by_id.get(e["u"])
            ev = pos_by_id.get(e["v"])
            if eu is None or ev is None:
                continue
            if geo.point_on_segment_interior(eu, ev, np_, EPS):
                return True
    return False


def _try_merge_groups(groups, index, axis, node_ids, pos_by_id, context):
    axis_idx = 0 if axis == "x" else 1
    left = groups[index]
    right = groups[index + 1]
    merged_coord = ((left["coord"] * len(left["ids"])) + (right["coord"] * len(right["ids"]))) / (len(left["ids"]) + len(right["ids"]))
    affected_ids = list(left["ids"]) + list(right["ids"])
    old_coords = {}
    for nid in affected_ids:
        old_coords[nid] = pos_by_id[nid][axis_idx]
        p = pos_by_id[nid]
        if axis_idx == 0:
            pos_by_id[nid] = (merged_coord, p[1])
        else:
            pos_by_id[nid] = (p[0], merged_coord)
    if _has_local_crossings(context, node_ids, pos_by_id, affected_ids):
        for nid in affected_ids:
            p = pos_by_id[nid]
            old = old_coords[nid]
            if axis_idx == 0:
                pos_by_id[nid] = (old, p[1])
            else:
                pos_by_id[nid] = (p[0], old)
        return None
    return {
        "ids": affected_ids,
        "coord": merged_coord,
        "minCoord": merged_coord,
        "maxCoord": merged_coord,
        "totalCoord": merged_coord * len(affected_ids),
    }


def _greedy_axis_sweep(node_ids, pos_by_id, context, axis, group_tolerance, merge_tolerance):
    groups = _build_axis_groups(node_ids, pos_by_id, axis, group_tolerance)
    merged_count = 0
    i = 0
    while i < len(groups) - 1:
        gap = groups[i + 1]["minCoord"] - groups[i]["maxCoord"]
        if not (gap <= merge_tolerance):
            i += 1
            continue
        merged = _try_merge_groups(groups, i, axis, node_ids, pos_by_id, context)
        if merged is None:
            i += 1
            continue
        groups[i:i + 2] = [merged]
        merged_count += 1
    return {
        "mergedCount": merged_count,
        "groupCount": len(groups),
        "tolerance": merge_tolerance,
        "baseTolerance": group_tolerance,
    }


def align_to_axis_greedy(node_ids, edge_pairs, pos_by_id, options=None):
    if not node_ids or len(node_ids) < 2:
        return {"ok": False, "reason": "Not enough nodes"}
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id.get(nid) if pos_by_id else None
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            return {"ok": False, "reason": "Not enough positioned nodes"}
    if geo.has_position_crossings(pos_by_id, edge_pairs):
        return {"ok": False, "reason": "Drawing is not plane"}
    context = _build_crossing_context(edge_pairs)

    opts = options or {}
    working = geo.copy_position_map(pos_by_id)
    score_eps = 1e-12
    score_before_result = metric_mod.compute_axis_alignment_score(node_ids, working)
    score_before = score_before_result["score"] if score_before_result.get("ok") else None
    current_score = score_before

    xs = []
    ys = []
    for raw in node_ids:
        nid = str(raw)
        xs.append(working[nid][0])
        ys.append(working[nid][1])

    x_base = _compute_axis_tolerance(xs, {
        "tolerance": opts.get("toleranceX"),
        "quantile": opts.get("quantile"),
        "toleranceScale": opts.get("toleranceScale"),
        "toleranceCapFraction": opts.get("toleranceCapFraction"),
        "minTolerance": opts.get("minToleranceX"),
        "fallbackToleranceFraction": opts.get("fallbackToleranceFraction"),
    })
    y_base = _compute_axis_tolerance(ys, {
        "tolerance": opts.get("toleranceY"),
        "quantile": opts.get("quantile"),
        "toleranceScale": opts.get("toleranceScale"),
        "toleranceCapFraction": opts.get("toleranceCapFraction"),
        "minTolerance": opts.get("minToleranceY"),
        "fallbackToleranceFraction": opts.get("fallbackToleranceFraction"),
    })
    merge_scale = max(1, opts["mergeToleranceScale"]) if _finite(opts.get("mergeToleranceScale")) else 1.5
    x_merge = max(0, opts["mergeToleranceX"]) if _finite(opts.get("mergeToleranceX")) else x_base * merge_scale
    y_merge = max(0, opts["mergeToleranceY"]) if _finite(opts.get("mergeToleranceY")) else y_base * merge_scale

    x_trial = geo.copy_position_map(working)
    x_trial_result = _greedy_axis_sweep(node_ids, x_trial, context, "x", x_base, x_merge)
    x_score_result = metric_mod.compute_axis_alignment_score(node_ids, x_trial)
    x_score = x_score_result["score"] if x_score_result.get("ok") else None
    x_result = {"mergedCount": 0, "groupCount": None, "tolerance": x_merge, "baseTolerance": x_base}
    if current_score is None or x_score is None or x_score + score_eps >= current_score:
        working = x_trial
        current_score = x_score
        x_result = x_trial_result

    y_trial = geo.copy_position_map(working)
    y_trial_result = _greedy_axis_sweep(node_ids, y_trial, context, "y", y_base, y_merge)
    y_score_result = metric_mod.compute_axis_alignment_score(node_ids, y_trial)
    y_score = y_score_result["score"] if y_score_result.get("ok") else None
    y_result = {"mergedCount": 0, "groupCount": None, "tolerance": y_merge, "baseTolerance": y_base}
    if current_score is None or y_score is None or y_score + score_eps >= current_score:
        working = y_trial
        current_score = y_score
        y_result = y_trial_result

    score_after_result = metric_mod.compute_axis_alignment_score(node_ids, working)
    return {
        "ok": True,
        "positions": working,
        "changed": x_result["mergedCount"] + y_result["mergedCount"] > 0,
        "mergedCountX": x_result["mergedCount"],
        "mergedCountY": y_result["mergedCount"],
        "toleranceX": x_result["tolerance"],
        "toleranceY": y_result["tolerance"],
        "baseToleranceX": x_result["baseTolerance"],
        "baseToleranceY": y_result["baseTolerance"],
        "scoreBefore": score_before,
        "scoreAfter": score_after_result["score"] if score_after_result.get("ok") else None,
    }


def _finite(x):
    if x is None or isinstance(x, bool):
        return False
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False
