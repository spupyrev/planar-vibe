"""GPT ensemble layout. Port of static/js/layout-gpt.js.

Tries multiple specialized (tree/grid/outerplanar/unicyclic/coretree/leafspread)
and core (tutte/edgebalancer/fabalancer/air/p3t) candidate layouts, evaluates
each against 10 metrics, optionally applies a local polish, and returns the
best-scoring plane drawing.
"""

from __future__ import annotations

import math
import time
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import planar_graph as pg
from .. import planarity
from . import air as air_layout
from . import edgebalancer as edgebalancer_layout
from . import fabalancer as fabalancer_layout
from . import p3t as p3t_layout
from . import tutte as tutte_layout

METRIC_KEYS = [
    "angularResolution", "aspectRatio", "convexity",
    "edgeLengthDeviation", "edgeRatio", "edgeOrthogonality",
    "face", "nodeUniformity", "alignment", "spacing",
]

DEFAULT_OPTIONS = {
    "budgetMs": 22000,
    "edgeBalancerMaxNodes": 220,
    "fabalancerMaxNodes": 120,
    "airMaxNodes": 96,
    "airMinEdgeRatio": 0.01,
    "treeMaxNodes": 220,
    "radialTreeMaxNodes": 220,
    "unicyclicMaxNodes": 220,
    "gridMaxNodes": 240,
    "p3tMaxNodes": 220,
    "outerplanarMaxNodes": 180,
    "coreTreeMaxNodes": 110,
    "coreTreeMaxCoreNodes": 70,
    "leafSpreadMaxNodes": 120,
    "leafSpreadMinLeaves": 4,
    "leafSpreadMaxEdgeSurplusRatio": 0.65,
    "leafSpreadMaxEdgeRatioDrop": 0.16,
    "polishMaxNodes": 96,
    "polishMaxScore": 0.90,
    "polishMaxEvaluations": 450,
    "polishLargeNodeThreshold": 50,
    "polishLargeMaxEvaluations": 320,
    "polishMinRemainingMs": 900,
    "rotationSamples": 96,
    "affineMaxNodes": 160,
    "affineStretchFactors": [1, 1.04, 1.1, 1.2],
}


def _now_ms():
    return time.monotonic() * 1000.0


def _copy_positions_for_nodes(pos_by_id, node_ids):
    out = {}
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id.get(nid) if pos_by_id else None
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            return None
        out[nid] = (p[0], p[1])
    return out


def _transform_positions(pos_by_id, node_ids, angle, stretch):
    sxy = float(stretch) if (isinstance(stretch, (int, float)) and math.isfinite(stretch) and stretch > 0) else 1.0
    if (not isinstance(angle, (int, float)) or not math.isfinite(angle) or abs(angle) < 1e-12) and abs(sxy - 1) < 1e-12:
        return _copy_positions_for_nodes(pos_by_id, node_ids)
    cx = 0.0
    cy = 0.0
    n = 0
    for raw in node_ids:
        p = pos_by_id.get(str(raw))
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            return None
        cx += p[0]
        cy += p[1]
        n += 1
    if n == 0:
        return {}
    cx /= n
    cy /= n
    c = math.cos(angle)
    s = math.sin(angle)
    inv = 1 / sxy
    out = {}
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id[nid]
        dx = p[0] - cx
        dy = p[1] - cy
        rx = c * dx - s * dy
        ry = s * dx + c * dy
        out[nid] = (cx + sxy * rx, cy + inv * ry)
    return out


def _metric_value(result, key):
    if not result or not result.get("ok"):
        return 0.0
    if key == "edgeRatio":
        val = result.get("ratio")
    elif key == "face":
        val = result.get("quality")
    else:
        val = result.get("score")
    return val if (isinstance(val, (int, float)) and math.isfinite(val)) else 0.0


def _evaluate_positions(graph, pos_by_id, options):
    opts = options or {}
    positions = _copy_positions_for_nodes(pos_by_id, graph.node_ids)
    if positions is None:
        return {"ok": False, "score": -math.inf, "reason": "missing positions"}
    if not opts.get("assumePlane") and geo.has_position_crossings(positions, graph.edge_pairs):
        return {"ok": False, "score": -math.inf, "reason": "non-plane drawing"}
    embedding = None
    try:
        embedding = pg.extract_embedding_from_positions(graph.node_ids, graph.edge_pairs, positions)
    except Exception:
        embedding = None
    raw = {}
    raw["aspectRatio"] = _metric_value(metric_mod.compute_aspect_ratio_score(graph.node_ids, positions), "aspectRatio")
    raw["nodeUniformity"] = _metric_value(metric_mod.compute_node_uniformity_score(graph.node_ids, positions), "nodeUniformity")
    raw["edgeLengthDeviation"] = _metric_value(metric_mod.compute_edge_length_deviation_score(graph.edge_pairs, positions), "edgeLengthDeviation")
    raw["edgeRatio"] = _metric_value(metric_mod.compute_edge_length_ratio(graph.edge_pairs, positions), "edgeRatio")
    raw["spacing"] = _metric_value(metric_mod.compute_spacing_uniformity_score(graph.node_ids, positions), "spacing")
    raw["edgeOrthogonality"] = _metric_value(metric_mod.compute_edge_orthogonality_score(graph.edge_pairs, positions), "edgeOrthogonality")
    raw["alignment"] = _metric_value(metric_mod.compute_axis_alignment_score(graph.node_ids, positions), "alignment")
    raw["angularResolution"] = _metric_value(metric_mod.compute_angular_resolution_score(graph, positions), "angularResolution")
    if embedding is not None:
        raw["face"] = _metric_value(metric_mod.compute_uniform_face_area_score(graph.node_ids, graph.edge_pairs, positions, embedding), "face")
        raw["convexity"] = _metric_value(metric_mod.compute_convexity_score(graph.node_ids, graph.edge_pairs, positions, embedding), "convexity")
    else:
        raw["face"] = 0.0
        raw["convexity"] = 0.0
    total = sum(raw[k] for k in METRIC_KEYS)
    return {"ok": True, "score": total / len(METRIC_KEYS), "metrics": raw, "positions": positions}


def _normalize_stretch_factors(raw_factors, node_count, affine_max_nodes):
    if not (node_count <= affine_max_nodes):
        return [1.0]
    source = raw_factors if isinstance(raw_factors, list) and raw_factors else DEFAULT_OPTIONS["affineStretchFactors"]
    out = []
    seen = {}
    for v in source:
        try:
            value = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(value) or not (value > 0):
            continue
        factor = max(1.0, value)
        key = f"{factor:.6f}"
        if key in seen:
            continue
        seen[key] = True
        out.append(factor)
    return out or [1.0]


def _graph_info(graph):
    degree = {}
    adjacency = {}
    for raw in graph.node_ids:
        nid = str(raw)
        degree[nid] = 0
        adjacency[nid] = []
    for (u_raw, v_raw) in graph.edge_pairs:
        u, v = str(u_raw), str(v_raw)
        if u not in adjacency or v not in adjacency:
            continue
        degree[u] += 1
        degree[v] += 1
        adjacency[u].append(v)
        adjacency[v].append(u)
    return {"degree": degree, "adjacency": adjacency}


def _is_connected(graph, info):
    if len(graph.node_ids) <= 1:
        return True
    adjacency = info["adjacency"]
    start = str(graph.node_ids[0])
    seen = {start}
    queue = [start]
    qi = 0
    while qi < len(queue):
        u = queue[qi]
        qi += 1
        for v_raw in adjacency.get(u, []):
            v = str(v_raw)
            if v in seen:
                continue
            seen.add(v)
            queue.append(v)
    return len(queue) == len(graph.node_ids)


def _is_tree_graph(graph):
    if len(graph.node_ids) == 0 or len(graph.edge_pairs) != len(graph.node_ids) - 1:
        return False
    return _is_connected(graph, _graph_info(graph))


def _ordered_path_nodes(graph, info):
    degree = info["degree"]
    adjacency = info["adjacency"]
    start = None
    endpoints = 0
    for raw in graph.node_ids:
        nid = str(raw)
        if degree[nid] > 2:
            return None
        if degree[nid] <= 1:
            endpoints += 1
            if start is None or nid < start:
                start = nid
    if len(graph.node_ids) > 1 and endpoints != 2:
        return None
    if start is None:
        start = str(graph.node_ids[0])
    order = []
    previous = None
    current = start
    seen = {}
    while current is not None:
        order.append(current)
        seen[current] = True
        nxt = None
        neighbors = sorted(adjacency.get(current, []))
        for cand in neighbors:
            if cand != previous and cand not in seen:
                nxt = cand
                break
        previous = current
        current = nxt
    return order if len(order) == len(graph.node_ids) else None


def _compute_path_snake_positions(order):
    n = len(order)
    positions = {}
    if n == 1:
        positions[str(order[0])] = (0.0, 0.0)
        return positions
    width = max(2, math.ceil(math.sqrt(n)))
    for i in range(n):
        row = i // width
        col = i % width
        x = col if row % 2 == 0 else width - 1 - col
        positions[str(order[i])] = (float(x), float(row))
    return positions


def _find_tree_center(graph, info):
    degree = {}
    leaves = []
    remaining = len(graph.node_ids)
    for raw in graph.node_ids:
        nid = str(raw)
        degree[nid] = info["degree"].get(nid, 0)
        if degree[nid] <= 1:
            leaves.append(nid)
    leaves.sort()
    while remaining > 2 and leaves:
        next_leaves = []
        remaining -= len(leaves)
        for leaf in leaves:
            for v_raw in info["adjacency"].get(leaf, []):
                v = str(v_raw)
                degree[v] -= 1
                if degree[v] == 1:
                    next_leaves.append(v)
        next_leaves.sort()
        leaves = next_leaves
    return str(leaves[0]) if leaves else str(graph.node_ids[0])


def _compute_layered_tree_positions(graph, info):
    root = _find_tree_center(graph, info)
    parent = {root: None}
    children = {}
    depth = {root: 0}
    stack = [root]
    si = 0
    while si < len(stack):
        u = stack[si]
        si += 1
        neighbors = sorted(info["adjacency"].get(u, []))
        children[u] = []
        for v_raw in neighbors:
            v = str(v_raw)
            if v == parent[u]:
                continue
            parent[v] = u
            depth[v] = depth[u] + 1
            children[u].append(v)
            stack.append(v)
    if len(stack) != len(graph.node_ids):
        return None

    leaf_count = {}

    def count_leaves(u):
        kids = children.get(u) or []
        if not kids:
            leaf_count[u] = 1
            return 1
        total = 0
        for k in kids:
            total += count_leaves(k)
        leaf_count[u] = total
        kids.sort(key=lambda a: (-leaf_count[a], a))
        return total

    count_leaves(root)

    positions = {}
    next_x = [0]
    max_depth = [0]

    def assign(u):
        kids = children.get(u) or []
        if depth.get(u, 0) > max_depth[0]:
            max_depth[0] = depth.get(u, 0)
        if not kids:
            positions[u] = (float(next_x[0]), float(depth.get(u, 0)))
            next_x[0] += 1
            return positions[u][0]
        for k in kids:
            assign(k)
        first_x = positions[kids[0]][0]
        last_x = positions[kids[-1]][0]
        positions[u] = ((first_x + last_x) / 2.0, float(depth.get(u, 0)))
        return positions[u][0]

    assign(root)
    width = max(1, next_x[0] - 1)
    if width > 0 and max_depth[0] > 0:
        level_gap = max(0.75, min(2.5, width / (max_depth[0] + 1)))
    else:
        level_gap = 1.0
    for k, v in list(positions.items()):
        positions[k] = (v[0], v[1] * level_gap)
    return positions


def _compute_tree_positions(graph):
    info = _graph_info(graph)
    if len(graph.edge_pairs) != len(graph.node_ids) - 1 or not _is_connected(graph, info):
        return {"ok": False, "message": "Not a tree"}
    order = _ordered_path_nodes(graph, info)
    positions = _compute_path_snake_positions(order) if order else _compute_layered_tree_positions(graph, info)
    if not positions:
        return {"ok": False, "message": "Tree layout failed"}
    return {"ok": True, "positions": positions, "message": "Computed tree layout"}


def _build_rooted_tree(graph, info):
    root = _find_tree_center(graph, info)
    parent = {root: None}
    children = {}
    depth = {root: 0}
    order = [root]
    qi = 0
    while qi < len(order):
        u = order[qi]
        qi += 1
        neighbors = sorted(info["adjacency"].get(u, []))
        children[u] = []
        for v_raw in neighbors:
            v = str(v_raw)
            if v == parent[u]:
                continue
            parent[v] = u
            depth[v] = depth[u] + 1
            children[u].append(v)
            order.append(v)
    if len(order) != len(graph.node_ids):
        return None
    return {"root": root, "parent": parent, "children": children, "depth": depth, "order": order}


def _compute_radial_tree_positions(graph):
    info = _graph_info(graph)
    if len(graph.edge_pairs) != len(graph.node_ids) - 1 or not _is_connected(graph, info):
        return {"ok": False, "message": "Not a tree"}
    if len(graph.node_ids) == 1:
        only = str(graph.node_ids[0])
        return {"ok": True, "positions": {only: (0.0, 0.0)}, "message": "Computed radial tree layout"}
    rooted = _build_rooted_tree(graph, info)
    if not rooted:
        return {"ok": False, "message": "Radial tree rooting failed"}
    children = rooted["children"]
    leaf_count = {}

    def count_leaves(u):
        kids = children.get(u) or []
        if not kids:
            leaf_count[u] = 1
            return 1
        total = 0
        for k in kids:
            total += count_leaves(k)
        leaf_count[u] = total
        kids.sort(key=lambda a: (-leaf_count[a], a))
        return total

    count_leaves(rooted["root"])

    positions = {rooted["root"]: (0.0, 0.0)}
    level_gap = 1.15

    def assign(u, start_angle, end_angle):
        kids = children.get(u) or []
        if not kids:
            return
        span = end_angle - start_angle
        cursor = start_angle
        total_leaves = sum(leaf_count.get(k, 1) for k in kids)
        for k in kids:
            part = span * leaf_count.get(k, 1) / max(1, total_leaves)
            a0 = cursor
            a1 = cursor + part
            angle = (a0 + a1) / 2.0
            radius = level_gap * (rooted["depth"].get(k, 1))
            positions[k] = (radius * math.cos(angle), radius * math.sin(angle))
            assign(k, a0, a1)
            cursor = a1

    assign(rooted["root"], -math.pi, math.pi)
    return {"ok": True, "positions": positions, "message": "Computed radial tree layout"}


def _extract_unicyclic_cycle(graph, info):
    if len(graph.node_ids) < 3 or len(graph.edge_pairs) != len(graph.node_ids) or not _is_connected(graph, info):
        return None
    degree = {}
    removed = {}
    queue = []
    for raw in graph.node_ids:
        nid = str(raw)
        degree[nid] = info["degree"].get(nid, 0)
        if degree[nid] <= 1:
            queue.append(nid)
    qi = 0
    while qi < len(queue):
        u = queue[qi]
        qi += 1
        if removed.get(u):
            continue
        removed[u] = True
        for v_raw in info["adjacency"].get(u, []):
            v = str(v_raw)
            if removed.get(v):
                continue
            degree[v] -= 1
            if degree[v] == 1:
                queue.append(v)
    core = []
    in_core = {}
    for raw in graph.node_ids:
        nid = str(raw)
        if not removed.get(nid):
            core.append(nid)
            in_core[nid] = True
    if len(core) < 3:
        return None
    for nid in core:
        core_degree = 0
        for v_raw in info["adjacency"].get(nid, []):
            if in_core.get(str(v_raw)):
                core_degree += 1
        if core_degree != 2:
            return None
    core.sort()
    start = core[0]
    order = []
    seen = {}
    previous = None
    current = start
    for i in range(len(core)):
        order.append(current)
        seen[current] = True
        core_neighbors = sorted(str(v) for v in info["adjacency"].get(current, []) if in_core.get(str(v)))
        nxt = None
        for cand in core_neighbors:
            if cand != previous:
                nxt = cand
                break
        if i == len(core) - 1:
            if nxt != start:
                return None
            break
        if nxt is None or seen.get(nxt):
            return None
        previous = current
        current = nxt
    return order


def _is_unicyclic_graph(graph):
    info = _graph_info(graph)
    return bool(_extract_unicyclic_cycle(graph, info))


def _compute_unicyclic_positions(graph):
    info = _graph_info(graph)
    cycle = _extract_unicyclic_cycle(graph, info)
    if not cycle:
        return {"ok": False, "message": "Not a connected unicyclic graph"}
    in_cycle = {c: True for c in cycle}
    positions = {}
    k = len(cycle)
    cycle_radius = max(1.2, 0.5 / math.sin(math.pi / k))
    for i in range(k):
        angle = -math.pi / 2 + (math.pi * 2 * i / k)
        positions[cycle[i]] = (cycle_radius * math.cos(angle), cycle_radius * math.sin(angle))

    children = {}

    def build_tree(u, parent):
        kids = []
        for v_raw in sorted(info["adjacency"].get(u, [])):
            v = str(v_raw)
            if v == parent or in_cycle.get(v):
                continue
            kids.append(v)
            build_tree(v, u)
        children[u] = kids

    for i in range(k):
        root = cycle[i]
        root_kids = []
        for v_raw in sorted(info["adjacency"].get(root, [])):
            v = str(v_raw)
            if in_cycle.get(v):
                continue
            root_kids.append(v)
            build_tree(v, root)
        children[root] = root_kids

    leaf_count = {}

    def count_leaves(u):
        kids = children.get(u) or []
        if not kids:
            leaf_count[u] = 1
            return 1
        total = 0
        for kid in kids:
            total += count_leaves(kid)
        leaf_count[u] = total
        kids.sort(key=lambda a: (-leaf_count[a], a))
        return total

    for c in cycle:
        count_leaves(c)

    level_gap = 1.05

    def assign_subtree(u, depth, start_angle, end_angle):
        kids = children.get(u) or []
        if not kids:
            return
        total = sum(leaf_count.get(k, 1) for k in kids)
        cursor = start_angle
        for kid in kids:
            span = (end_angle - start_angle) * leaf_count.get(kid, 1) / max(1, total)
            a0 = cursor
            a1 = cursor + span
            angle = (a0 + a1) / 2.0
            radius = cycle_radius + depth * level_gap
            positions[kid] = (radius * math.cos(angle), radius * math.sin(angle))
            assign_subtree(kid, depth + 1, a0, a1)
            cursor = a1

    base_sector = math.pi * 2 / k
    for c in cycle:
        angle = math.atan2(positions[c][1], positions[c][0])
        half = min(base_sector * 0.42, math.pi / 3)
        assign_subtree(c, 1, angle - half, angle + half)

    return {"ok": True, "positions": positions, "message": "Computed unicyclic layout"}


def _rectangular_grid_dimensions(graph):
    n = len(graph.node_ids)
    m = len(graph.edge_pairs)
    if n < 4:
        return None
    side_sum = 2 * n - m
    r = 2
    while r * r <= n:
        if n % r == 0:
            c = n // r
            if r + c == side_sum:
                return {"rows": r, "cols": c}
        r += 1
    return None


def _has_rectangular_grid_signature(graph):
    dims = _rectangular_grid_dimensions(graph)
    if not dims:
        return False
    info = _graph_info(graph)
    corners = 0
    for raw in graph.node_ids:
        d = info["degree"].get(str(raw), 0)
        if d > 4 or d < 2:
            return False
        if d == 2:
            corners += 1
    return corners == 4 and _is_connected(graph, info)


def _has_grid_edge(edge_set, u, v):
    return edge_set.get(gu.edge_key(str(u), str(v)), False)


def _compute_two_row_grid_positions(graph, info, columns):
    edge_set = {}
    for (u, v) in graph.edge_pairs:
        edge_set[gu.edge_key(str(u), str(v))] = True
    corners = []
    for raw in graph.node_ids:
        nid = str(raw)
        if info["degree"].get(nid, 0) == 2:
            corners.append(nid)
    corners.sort()
    for top in corners:
        neighbors = sorted(info["adjacency"].get(top, []))
        for bottom_raw in neighbors:
            bottom = str(bottom_raw)
            if info["degree"].get(bottom, 0) != 2:
                continue
            positions = {}
            seen = {}
            top_prev = None
            bottom_prev = None
            top_cur = top
            bottom_cur = bottom
            valid = True
            for col in range(columns):
                if seen.get(top_cur) or seen.get(bottom_cur):
                    valid = False
                    break
                seen[top_cur] = True
                seen[bottom_cur] = True
                positions[top_cur] = (float(col), 0.0)
                positions[bottom_cur] = (float(col), 1.0)
                if col == columns - 1:
                    break
                top_next = []
                for n_raw in info["adjacency"].get(top_cur, []):
                    n = str(n_raw)
                    if n != top_prev and n != bottom_cur and not seen.get(n):
                        top_next.append(n)
                bottom_next = []
                for n_raw in info["adjacency"].get(bottom_cur, []):
                    n = str(n_raw)
                    if n != bottom_prev and n != top_cur and not seen.get(n):
                        bottom_next.append(n)
                if len(top_next) != 1 or len(bottom_next) != 1 or not _has_grid_edge(edge_set, top_next[0], bottom_next[0]):
                    valid = False
                    break
                top_prev = top_cur
                bottom_prev = bottom_cur
                top_cur = top_next[0]
                bottom_cur = bottom_next[0]
            if not valid or len(seen) != len(graph.node_ids):
                continue
            for (u, v) in graph.edge_pairs:
                a = positions.get(str(u))
                b = positions.get(str(v))
                if a is None or b is None or abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
                    valid = False
                    break
            if valid:
                return {"ok": True, "positions": positions, "message": "Computed two-row grid layout"}
    return {"ok": False, "message": "Two-row grid coordinate recovery failed"}


def _is_planar_3tree(graph):
    try:
        info = planarity.analyze_planar_3_tree(graph)
        return bool(info and info.get("ok"))
    except Exception:
        return False


def _trace_grid_boundary_path(start, nxt, info):
    path = [str(start), str(nxt)]
    previous = str(start)
    current = str(nxt)
    seen = {previous: True, current: True}
    while info["degree"].get(current, 0) != 2:
        candidates = []
        for v_raw in info["adjacency"].get(current, []):
            v = str(v_raw)
            if v != previous and not seen.get(v) and info["degree"].get(v, 0) < 4:
                candidates.append(v)
        if len(candidates) != 1:
            return None
        candidates.sort()
        previous = current
        current = candidates[0]
        seen[current] = True
        path.append(current)
    return path


def _multi_source_distances(graph, sources, info):
    dist = {}
    queue = []
    for s_raw in sources:
        s = str(s_raw)
        if dist.get(s) == 0:
            continue
        dist[s] = 0
        queue.append(s)
    qi = 0
    while qi < len(queue):
        u = queue[qi]
        qi += 1
        for v_raw in info["adjacency"].get(u, []):
            v = str(v_raw)
            if v in dist:
                continue
            dist[v] = dist[u] + 1
            queue.append(v)
    return dist


def _compute_rectangular_grid_positions(graph):
    if not _has_rectangular_grid_signature(graph):
        return {"ok": False, "message": "Not a rectangular grid"}
    info = _graph_info(graph)
    dims = _rectangular_grid_dimensions(graph)
    if dims and (dims["rows"] == 2 or dims["cols"] == 2):
        return _compute_two_row_grid_positions(graph, info, max(dims["rows"], dims["cols"]))
    corners = [str(raw) for raw in graph.node_ids if info["degree"].get(str(raw), 0) == 2]
    corners.sort()
    for corner in corners:
        neighbors = sorted(info["adjacency"].get(corner, []))
        for flip in range(2):
            if flip >= len(neighbors):
                continue
            path_x = _trace_grid_boundary_path(corner, neighbors[flip], info)
            path_y = _trace_grid_boundary_path(corner, neighbors[1 - flip] if (1 - flip) < len(neighbors) else neighbors[flip], info)
            if not path_x or not path_y:
                continue
            width = len(path_x) - 1
            height = len(path_y) - 1
            if (width + 1) * (height + 1) != len(graph.node_ids):
                continue
            dist_to_y = _multi_source_distances(graph, path_y, info)
            dist_to_x = _multi_source_distances(graph, path_x, info)
            positions = {}
            occupied = {}
            valid = True
            for raw in graph.node_ids:
                nid = str(raw)
                x = dist_to_y.get(nid)
                y = dist_to_x.get(nid)
                if x is None or y is None or x < 0 or y < 0 or x > width or y > height:
                    valid = False
                    break
                key = f"{x},{y}"
                if occupied.get(key):
                    valid = False
                    break
                occupied[key] = True
                positions[nid] = (float(x), float(y))
            if not valid:
                continue
            for (u, v) in graph.edge_pairs:
                a = positions.get(str(u))
                b = positions.get(str(v))
                if a is None or b is None or abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
                    valid = False
                    break
            if valid:
                return {"ok": True, "positions": positions, "message": "Computed rectangular grid layout"}
    return {"ok": False, "message": "Rectangular grid coordinate recovery failed"}


def _compute_outerplanar_order(graph):
    n = len(graph.node_ids)
    if n < 3:
        return None
    node_ids = [str(raw) for raw in graph.node_ids]
    id_set = set(node_ids)
    hub = "@gptOuterHub"
    suffix = 1
    while hub in id_set:
        hub = f"@gptOuterHub{suffix}"
        suffix += 1
    edge_pairs = [(str(u), str(v)) for (u, v) in graph.edge_pairs]
    for nid in node_ids:
        edge_pairs.append((hub, nid))
    embedding = planarity.compute_planar_embedding(node_ids + [hub], edge_pairs)
    if not embedding or not embedding.get("ok") or not embedding.get("indexById") or not isinstance(embedding.get("rotation"), list):
        return None
    hub_index = embedding["indexById"].get(hub)
    if not isinstance(hub_index, int):
        return None
    rotation = embedding["rotation"][hub_index] if 0 <= hub_index < len(embedding["rotation"]) else None
    if not isinstance(rotation, list) or len(rotation) != len(node_ids):
        return None
    seen = set()
    order = []
    for r in rotation:
        nid = str(r)
        if nid not in id_set or nid in seen:
            return None
        seen.add(nid)
        order.append(nid)
    return order if len(order) == len(node_ids) else None


def _is_outerplanar_graph(graph):
    return _compute_outerplanar_order(graph) is not None


def _compute_outerplanar_circle_positions(graph):
    order = _compute_outerplanar_order(graph)
    if not order:
        return {"ok": False, "message": "Not outerplanar"}
    n = len(order)
    radius = max(1.0, n / (math.pi * 2))
    positions = {}
    for i in range(n):
        angle = -math.pi / 2 + math.pi * 2 * i / n
        positions[order[i]] = (radius * math.cos(angle), radius * math.sin(angle))
    if geo.has_position_crossings(positions, graph.edge_pairs):
        return {"ok": False, "message": "Outerplanar circle drawing crossed edges"}
    return {"ok": True, "positions": positions, "message": "Computed outerplanar circle layout"}


def _compute_two_core_info(graph, options):
    opts = options or {}
    max_nodes = opts.get("coreTreeMaxNodes", DEFAULT_OPTIONS["coreTreeMaxNodes"])
    max_core_nodes = opts.get("coreTreeMaxCoreNodes", DEFAULT_OPTIONS["coreTreeMaxCoreNodes"])
    if len(graph.node_ids) > max_nodes:
        return None
    info = _graph_info(graph)
    if not _is_connected(graph, info):
        return None
    degree = {}
    removed = {}
    queue = []
    for raw in graph.node_ids:
        nid = str(raw)
        degree[nid] = info["degree"].get(nid, 0)
        if degree[nid] <= 1:
            queue.append(nid)
    qi = 0
    while qi < len(queue):
        u = queue[qi]
        qi += 1
        if removed.get(u):
            continue
        removed[u] = True
        for v_raw in info["adjacency"].get(u, []):
            v = str(v_raw)
            if removed.get(v):
                continue
            degree[v] -= 1
            if degree[v] == 1:
                queue.append(v)
    core = []
    core_set = {}
    for raw in graph.node_ids:
        nid = str(raw)
        if not removed.get(nid):
            core.append(nid)
            core_set[nid] = True
    if len(core) < 3 or len(core) == len(graph.node_ids) or len(core) > max_core_nodes:
        return None
    core_edges = []
    for (u, v) in graph.edge_pairs:
        a, b = str(u), str(v)
        if core_set.get(a) and core_set.get(b):
            core_edges.append((a, b))
    if len(core_edges) < len(core):
        return None
    return {
        "info": info,
        "core": core,
        "coreSet": core_set,
        "coreGraph": gu.create_graph(core, core_edges),
    }


def _should_try_core_tree(graph, options):
    return _compute_two_core_info(graph, options) is not None


def _median_finite(values):
    out = [float(v) for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    if not out:
        return None
    out.sort()
    mid = len(out) // 2
    return out[mid] if len(out) % 2 == 1 else (out[mid - 1] + out[mid]) / 2.0


def _median_edge_length(graph, pos_by_id, edge_filter=None):
    lengths = []
    for (u_raw, v_raw) in graph.edge_pairs:
        u, v = str(u_raw), str(v_raw)
        if edge_filter and not edge_filter(u, v):
            continue
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if pu is None or pv is None:
            continue
        dx = pu[0] - pv[0]
        dy = pu[1] - pv[1]
        length = math.sqrt(dx * dx + dy * dy)
        if length > 0:
            lengths.append(length)
    return _median_finite(lengths)


def _compute_core_tree_positions(graph, options):
    core_info = _compute_two_core_info(graph, options)
    if not core_info:
        return {"ok": False, "message": "Not an eligible core-tree graph"}
    core_result = edgebalancer_layout.apply_layout(core_info["coreGraph"])
    if not core_result or not core_result.get("ok") or not core_result.get("positions"):
        return {"ok": False, "message": "CoreTree core layout failed"}
    positions = _copy_positions_for_nodes(core_result["positions"], core_info["core"])
    if positions is None or geo.has_position_crossings(positions, core_info["coreGraph"].edge_pairs):
        return {"ok": False, "message": "CoreTree core drawing is not plane"}
    children = {}
    parent = {}
    queue = sorted(core_info["core"])
    for cid in core_info["core"]:
        parent[cid] = None
        children[cid] = []
    qi = 0
    while qi < len(queue):
        u = queue[qi]
        qi += 1
        for v_raw in sorted(core_info["info"]["adjacency"].get(u, [])):
            v = str(v_raw)
            if core_info["coreSet"].get(v) or v in parent:
                continue
            parent[v] = u
            children.setdefault(u, []).append(v)
            children[v] = []
            queue.append(v)
    if len(parent) != len(graph.node_ids):
        return {"ok": False, "message": "CoreTree attachment forest failed"}

    cx = 0.0
    cy = 0.0
    for cid in core_info["core"]:
        cx += positions[cid][0]
        cy += positions[cid][1]
    cx /= len(core_info["core"])
    cy /= len(core_info["core"])

    level_gap = (_median_edge_length(core_info["coreGraph"], positions) or 1.0) * 0.95

    leaf_memo = {}

    def leaf_count(u):
        if u in leaf_memo:
            return leaf_memo[u]
        kids = children.get(u) or []
        if not kids:
            leaf_memo[u] = 1
            return 1
        total = 0
        for k in kids:
            total += leaf_count(k)
        leaf_memo[u] = total
        return total

    def assign_subtree(root, anchor, depth, start_angle, end_angle):
        kids = (children.get(root) or [])[:]
        kids.sort(key=lambda a: (-leaf_count(a), a))
        if not kids:
            return
        total = sum(leaf_count(k) for k in kids)
        cursor = start_angle
        for k in kids:
            span = (end_angle - start_angle) * leaf_count(k) / max(1, total)
            angle = cursor + span / 2.0
            positions[k] = (anchor[0] + level_gap * depth * math.cos(angle),
                            anchor[1] + level_gap * depth * math.sin(angle))
            assign_subtree(k, anchor, depth + 1, cursor, cursor + span)
            cursor += span

    for cid in core_info["core"]:
        attachment_count = 0
        for r in children.get(cid) or []:
            if not core_info["coreSet"].get(r):
                attachment_count += 1
        if attachment_count == 0:
            continue
        p = positions[cid]
        outward = math.atan2(p[1] - cy, p[0] - cx)
        half = min(math.pi * 0.72, max(math.pi / 5, attachment_count * math.pi / 9))
        assign_subtree(cid, p, 1, outward - half, outward + half)

    out = _copy_positions_for_nodes(positions, graph.node_ids)
    if out is None or geo.has_position_crossings(out, graph.edge_pairs):
        return {"ok": False, "message": "CoreTree could not keep drawing plane"}
    return {"ok": True, "positions": out, "message": "Computed core-tree layout"}


def _normalized_positive_angle(angle):
    two_pi = math.pi * 2
    out = angle % two_pi
    if out < 0:
        out += two_pi
    return out


def _is_leaf_spread_source(name):
    return name in ("edgebalancer", "fabalancer", "air")


def _should_try_leaf_spread(graph, options):
    opts = options or {}
    n = len(graph.node_ids)
    max_nodes = opts.get("leafSpreadMaxNodes", DEFAULT_OPTIONS["leafSpreadMaxNodes"])
    if n > max_nodes or len(graph.edge_pairs) <= n:
        return False
    max_surplus = opts.get("leafSpreadMaxEdgeSurplusRatio", DEFAULT_OPTIONS["leafSpreadMaxEdgeSurplusRatio"])
    if len(graph.edge_pairs) - n > max(6, int(n * max_surplus)):
        return False
    min_leaves = opts.get("leafSpreadMinLeaves", DEFAULT_OPTIONS["leafSpreadMinLeaves"])
    info = _graph_info(graph)
    if not _is_connected(graph, info):
        return False
    leaves = sum(1 for raw in graph.node_ids if info["degree"].get(str(raw), 0) == 1)
    return leaves >= min_leaves


def _compute_leaf_spread_positions(graph, base_positions, options):
    opts = options or {}
    info = _graph_info(graph)
    positions = _copy_positions_for_nodes(base_positions, graph.node_ids)
    if positions is None or geo.has_position_crossings(positions, graph.edge_pairs):
        return {"ok": False, "message": "LeafSpread base is not plane"}
    min_leaves = opts.get("leafSpreadMinLeaves", DEFAULT_OPTIONS["leafSpreadMinLeaves"])
    leaf_set = {}
    leaves = []
    parent_leaves = {}
    for raw in graph.node_ids:
        nid = str(raw)
        if info["degree"].get(nid, 0) != 1:
            continue
        adj = info["adjacency"].get(nid) or []
        parent = str(adj[0]) if adj else ""
        if not parent or parent not in positions:
            continue
        leaf_set[nid] = True
        leaves.append(nid)
        parent_leaves.setdefault(parent, []).append(nid)
    if len(leaves) < min_leaves:
        return {"ok": False, "message": "LeafSpread needs more leaves"}

    non_leaf_median = _median_edge_length(graph, positions, lambda u, v: not leaf_set.get(u) and not leaf_set.get(v))
    all_median = _median_edge_length(graph, positions)
    target_length = non_leaf_median or all_median or 1.0
    if not (target_length > 0):
        return {"ok": False, "message": "LeafSpread has no length scale"}

    assignment = {}
    parents = sorted(parent_leaves.keys())
    two_pi = math.pi * 2
    for parent in parents:
        center = positions[parent]
        kids = sorted(parent_leaves[parent])
        occupied = []
        for n_raw in sorted(info["adjacency"].get(parent, [])):
            neighbor = str(n_raw)
            if leaf_set.get(neighbor):
                continue
            q = positions.get(neighbor)
            if q is None:
                continue
            occupied.append(_normalized_positive_angle(math.atan2(q[1] - center[1], q[0] - center[0])))

        local_median = _median_edge_length(
            graph, positions,
            lambda u, v, p=parent: (u == p or v == p) and not leaf_set.get(u) and not leaf_set.get(v),
        )
        radius = local_median or target_length
        radius *= 1 + min(0.35, 0.04 * max(0, len(kids) - 1))

        if not occupied:
            for ki, kid in enumerate(kids):
                assignment[kid] = {"parent": parent, "radius": radius,
                                   "angle": -math.pi + two_pi * (ki + 1) / (len(kids) + 1)}
            continue
        occupied.sort()
        gaps = []
        for gi in range(len(occupied)):
            start = occupied[gi]
            end = occupied[(gi + 1) % len(occupied)]
            span = end - start
            if span <= 0:
                span += two_pi
            gaps.append({"start": start, "span": span, "leaves": []})
        for kid in kids:
            best_gap = gaps[0]
            best_score = -math.inf
            for g in gaps:
                score = g["span"] / (len(g["leaves"]) + 1)
                if score > best_score:
                    best_score = score
                    best_gap = g
            best_gap["leaves"].append(kid)
        for g in gaps:
            gap_leaves = g["leaves"]
            if not gap_leaves:
                continue
            margin = min(g["span"] * 0.18, math.pi / 8)
            usable = max(g["span"] - 2 * margin, g["span"] * 0.35)
            base = g["start"] + (g["span"] - usable) / 2
            for ki, kid in enumerate(gap_leaves):
                assignment[kid] = {"parent": parent, "radius": radius,
                                   "angle": base + usable * (ki + 1) / (len(gap_leaves) + 1)}

    factors = [1.15, 1, 0.85, 0.7, 0.55, 0.4, 0.28]
    for fi, factor in enumerate(factors):
        out = _copy_positions_for_nodes(positions, graph.node_ids)
        for leaf in leaves:
            item = assignment.get(leaf)
            if not item:
                continue
            center = positions[item["parent"]]
            r = item["radius"] * factor
            out[leaf] = (center[0] + r * math.cos(item["angle"]), center[1] + r * math.sin(item["angle"]))
        if not geo.has_position_crossings(out, graph.edge_pairs):
            return {"ok": True, "positions": out, "message": "Computed sparse leaf-spread layout"}
    return {"ok": False, "message": "LeafSpread could not keep drawing plane"}


def _best_transform_for_candidate(graph, pos_by_id, options, deadline_ms):
    opts = options or {}
    base = _copy_positions_for_nodes(pos_by_id, graph.node_ids)
    if base is None or geo.has_position_crossings(base, graph.edge_pairs):
        return None
    samples = max(1, int(float(opts.get("rotationSamples", 1) or 1)))
    affine_max_nodes = opts.get("affineMaxNodes", DEFAULT_OPTIONS["affineMaxNodes"])
    stretch_factors = _normalize_stretch_factors(opts.get("affineStretchFactors"), len(graph.node_ids), affine_max_nodes)
    best = None
    period = math.pi
    for stretch in stretch_factors:
        for i in range(samples):
            if best is not None and deadline_ms is not None and _now_ms() >= deadline_ms:
                return best
            angle = period * i / samples
            transformed = _transform_positions(base, graph.node_ids, angle, stretch)
            evaluated = _evaluate_positions(graph, transformed, {**opts, "assumePlane": True})
            if not evaluated.get("ok"):
                continue
            evaluated["rotation"] = angle
            evaluated["stretch"] = stretch
            if best is None or evaluated["score"] > best["score"]:
                best = evaluated
    return best


def _should_try_polish(graph, evaluated, options, deadline_ms):
    opts = options or {}
    if not evaluated or not evaluated.get("ok") or not evaluated.get("positions"):
        return False
    max_nodes = opts.get("polishMaxNodes", DEFAULT_OPTIONS["polishMaxNodes"])
    if len(graph.node_ids) > max_nodes:
        return False
    max_score = opts.get("polishMaxScore", DEFAULT_OPTIONS["polishMaxScore"])
    if isinstance(max_score, (int, float)) and math.isfinite(max_score) and evaluated["score"] > max_score:
        return False
    min_remaining = opts.get("polishMinRemainingMs", DEFAULT_OPTIONS["polishMinRemainingMs"])
    return deadline_ms is None or _now_ms() + min_remaining < deadline_ms


def _compute_polished_positions(graph, seed_positions, seed_score, options, deadline_ms):
    opts = options or {}
    positions = _copy_positions_for_nodes(seed_positions, graph.node_ids)
    if positions is None or geo.has_position_crossings(positions, graph.edge_pairs):
        return None
    best = _evaluate_positions(graph, positions, opts)
    if not best or not best.get("ok"):
        return None
    original_score = seed_score if (isinstance(seed_score, (int, float)) and math.isfinite(seed_score)) else best["score"]
    max_evaluations = max(0, int(opts.get("polishMaxEvaluations", DEFAULT_OPTIONS["polishMaxEvaluations"]) or 0))
    large_threshold = opts.get("polishLargeNodeThreshold", DEFAULT_OPTIONS["polishLargeNodeThreshold"])
    large_max = max(0, int(opts.get("polishLargeMaxEvaluations", DEFAULT_OPTIONS["polishLargeMaxEvaluations"]) or 0))
    if len(graph.node_ids) > large_threshold:
        max_evaluations = min(max_evaluations, large_max)
    if max_evaluations <= 0:
        return None
    ids = sorted(str(raw) for raw in graph.node_ids)
    base_length = _median_edge_length(graph, positions) or 1.0
    step_factors = [0.16, 0.09, 0.05, 0.028]
    directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    evaluations = 0
    moves = 0

    def past_deadline():
        return deadline_ms is not None and _now_ms() >= deadline_ms

    for factor in step_factors:
        improved = True
        pass_no = 0
        while improved and pass_no < 2:
            improved = False
            for nid in ids:
                if past_deadline() or evaluations >= max_evaluations:
                    break
                p = positions.get(nid)
                if p is None:
                    continue
                local_directions = list(directions)
                radial_length = math.sqrt(p[0] * p[0] + p[1] * p[1])
                if radial_length > 1e-9:
                    local_directions.append((p[0] / radial_length, p[1] / radial_length))
                    local_directions.append((-p[0] / radial_length, -p[1] / radial_length))
                local_best = best
                local_positions = None
                for d in local_directions:
                    if past_deadline() or evaluations >= max_evaluations:
                        break
                    norm = math.sqrt(d[0] * d[0] + d[1] * d[1]) or 1
                    candidate = _copy_positions_for_nodes(positions, graph.node_ids)
                    if candidate is None:
                        continue
                    candidate[nid] = (p[0] + base_length * factor * d[0] / norm,
                                      p[1] + base_length * factor * d[1] / norm)
                    evaluations += 1
                    evaluated = _evaluate_positions(graph, candidate, opts)
                    if evaluated and evaluated.get("ok") and evaluated["score"] > local_best["score"] + 1e-6:
                        local_best = evaluated
                        local_positions = candidate
                if local_positions is not None:
                    positions = local_positions
                    best = local_best
                    moves += 1
                    improved = True
            pass_no += 1

    if moves == 0 or best["score"] <= original_score + 1e-6:
        return None
    best["moves"] = moves
    best["evaluations"] = evaluations
    return best


def _run_candidate(name, graph, compute_options, initial_positions=None):
    if name == "tutte":
        return tutte_layout.apply_layout(graph, initial_positions=initial_positions, options=compute_options)
    if name == "edgebalancer":
        return edgebalancer_layout.apply_layout(graph, initial_positions=initial_positions, options=compute_options)
    if name == "fabalancer":
        return fabalancer_layout.apply_layout(graph, initial_positions=initial_positions, options=compute_options)
    if name == "air":
        return air_layout.apply_layout(graph, initial_positions=initial_positions, options=compute_options)
    if name == "tree":
        return _compute_tree_positions(graph)
    if name == "radialtree":
        return _compute_radial_tree_positions(graph)
    if name == "unicyclic":
        return _compute_unicyclic_positions(graph)
    if name == "grid":
        return _compute_rectangular_grid_positions(graph)
    if name == "outercircle":
        return _compute_outerplanar_circle_positions(graph)
    if name == "coretree":
        return _compute_core_tree_positions(graph, compute_options)
    if name == "p3t":
        return p3t_layout.apply_layout(graph, options=compute_options)
    return {"ok": False, "message": "Unknown GPT candidate: " + str(name)}


def _build_candidate_specs(graph, options):
    opts = options or {}
    if isinstance(opts.get("candidates"), list) and opts["candidates"]:
        return [str(c) for c in opts["candidates"]]
    n = len(graph.node_ids)
    specs = ["tutte"]

    def get(name):
        return opts.get(name, DEFAULT_OPTIONS[name])

    if n <= get("treeMaxNodes") and _is_tree_graph(graph):
        specs.append("tree")
    if n <= get("radialTreeMaxNodes") and _is_tree_graph(graph):
        specs.append("radialtree")
    if n <= get("unicyclicMaxNodes") and _is_unicyclic_graph(graph):
        specs.append("unicyclic")
    if n <= get("gridMaxNodes") and _has_rectangular_grid_signature(graph):
        specs.append("grid")
    if n <= get("outerplanarMaxNodes") and _is_outerplanar_graph(graph):
        specs.append("outercircle")
    if n <= get("coreTreeMaxNodes") and _should_try_core_tree(graph, opts):
        specs.append("coretree")
    if n <= get("p3tMaxNodes") and _is_planar_3tree(graph):
        specs.append("p3t")
    if n <= get("edgeBalancerMaxNodes"):
        specs.append("edgebalancer")
    if n <= get("fabalancerMaxNodes"):
        specs.append("fabalancer")
    if n <= get("airMaxNodes"):
        specs.append("air")
    return specs


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = {**DEFAULT_OPTIONS, **(options or {})}
    candidate_names = _build_candidate_specs(graph, opts)
    started_at = _now_ms()
    budget = opts.get("budgetMs")
    deadline_ms = (started_at + budget) if (isinstance(budget, (int, float)) and math.isfinite(budget)) else None
    best = None
    leaf_spread_seed = None
    leaf_spread_eligible = _should_try_leaf_spread(graph, opts)
    failures = []

    for name in candidate_names:
        if best is not None and isinstance(budget, (int, float)) and math.isfinite(budget) and _now_ms() - started_at >= budget:
            break
        try:
            result = _run_candidate(name, graph, opts, initial_positions)
        except Exception as err:
            failures.append(f"{name}: {err}")
            continue
        if not result or not result.get("ok") or not result.get("positions"):
            failures.append(f"{name}: {(result or {}).get('message', 'failed')}")
            continue
        evaluated = _best_transform_for_candidate(graph, result["positions"], opts, deadline_ms)
        if not evaluated or not evaluated.get("ok"):
            failures.append(f"{name}: invalid scored drawing")
            continue
        if (name == "air"
                and isinstance(opts.get("airMinEdgeRatio"), (int, float))
                and math.isfinite(opts["airMinEdgeRatio"])
                and evaluated.get("metrics")
                and isinstance(evaluated["metrics"].get("edgeRatio"), (int, float))
                and evaluated["metrics"]["edgeRatio"] < opts["airMinEdgeRatio"]):
            failures.append(f"{name}: edge ratio below floor")
            continue
        evaluated["name"] = name
        evaluated["result"] = result
        if best is None or evaluated["score"] > best["score"]:
            best = evaluated
        if leaf_spread_eligible and _is_leaf_spread_source(name) and (leaf_spread_seed is None or evaluated["score"] > leaf_spread_seed["score"]):
            leaf_spread_seed = {
                "name": name,
                "score": evaluated["score"],
                "metrics": evaluated.get("metrics"),
                "positions": result["positions"],
            }

    if leaf_spread_seed and (deadline_ms is None or _now_ms() < deadline_ms):
        spread_result = _compute_leaf_spread_positions(graph, leaf_spread_seed["positions"], opts)
        if spread_result and spread_result.get("ok") and spread_result.get("positions"):
            spread_evaluated = _best_transform_for_candidate(graph, spread_result["positions"], opts, deadline_ms)
            if spread_evaluated and spread_evaluated.get("ok"):
                max_drop = opts.get("leafSpreadMaxEdgeRatioDrop", DEFAULT_OPTIONS["leafSpreadMaxEdgeRatioDrop"])
                seed_ratio = (leaf_spread_seed.get("metrics") or {}).get("edgeRatio")
                spread_ratio = (spread_evaluated.get("metrics") or {}).get("edgeRatio")
                drops_too_much = (isinstance(max_drop, (int, float)) and math.isfinite(max_drop)
                                  and isinstance(seed_ratio, (int, float)) and math.isfinite(seed_ratio)
                                  and isinstance(spread_ratio, (int, float)) and math.isfinite(spread_ratio)
                                  and spread_ratio < seed_ratio - max_drop)
                if drops_too_much:
                    failures.append(f"leafspread-{leaf_spread_seed['name']}: edge ratio drop above floor")
                else:
                    spread_evaluated["name"] = f"leafspread-{leaf_spread_seed['name']}"
                    spread_evaluated["result"] = spread_result
                    if best is None or spread_evaluated["score"] > best["score"]:
                        best = spread_evaluated

    if best and _should_try_polish(graph, best, opts, deadline_ms):
        polished = _compute_polished_positions(graph, best["positions"], best["score"], opts, deadline_ms)
        if polished and polished.get("ok") and polished["score"] > best["score"]:
            polished["name"] = f"polish-{best['name']}"
            polished["result"] = {"ok": True, "positions": polished["positions"], "message": "Computed polished layout"}
            best = polished

    if best is None:
        return gu.build_layout_error({
            "message": ("GPT failed (" + "; ".join(failures[:3]) + ")") if failures else "GPT failed (no valid candidates)",
        })
    return gu.build_layout_result({
        "ok": True,
        "positions": geo.normalize_position_map_to_viewport(best["positions"]),
        "candidate": best["name"],
        "score": best["score"],
        "rotation": best.get("rotation"),
        "stretch": best.get("stretch"),
        "message": f"Applied GPT ({best['name']}, score {best['score']:.3f})",
    })
