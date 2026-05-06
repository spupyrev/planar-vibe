"""Claude ensemble layout. Port of static/js/layout-claude.js.

Runs many candidate layouts (internal structural + core modules), builds
base/rot/align variants, then iteratively polishes with local moves,
convexity repair, and restarts. Picks the best-scoring plane drawing.
"""

from __future__ import annotations

import math
import time
from typing import Sequence

from .. import alignment
from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import planar_graph as pg
from .. import planarity
from . import anglebalancer as anglebalancer_layout
from . import areagrad as areagrad_layout
from . import ceg as ceg_layout
from . import edgebalancer as edgebalancer_layout
from . import fabalancer as fabalancer_layout
from . import facebalancer as facebalancer_layout
from . import reweight as reweight_layout
from . import schnyder as schnyder_layout
from . import tutte as tutte_layout

METRIC_KEYS = [
    "angularResolution", "aspectRatio", "convexity", "edgeLengthDeviation",
    "edgeRatio", "edgeOrthogonality", "face", "nodeUniformity", "alignment", "spacing",
]

DIRS8 = [
    (1, 0), (-1, 0), (0, 1), (0, -1),
    (0.707, 0.707), (-0.707, 0.707), (0.707, -0.707), (-0.707, -0.707),
]

CUSTOM_LIMITS = {
    "treeMaxNodes": 220,
    "radialTreeMaxNodes": 220,
    "unicyclicMaxNodes": 220,
    "gridMaxNodes": 240,
    "outerplanarMaxNodes": 180,
    "coreTreeMaxNodes": 110,
    "coreTreeMaxCoreNodes": 70,
}
BALANCER_MAX_INTERIOR_AUG_VERTICES = 400


def _now_ms():
    return time.monotonic() * 1000.0


_shared_ctx = {"graph": None}


def _compute_scores(node_ids, edge_pairs, pos_by_id, embedding):
    graph = _shared_ctx["graph"]
    aspect = metric_mod.compute_aspect_ratio_score(node_ids, pos_by_id)
    node_u = metric_mod.compute_node_uniformity_score(node_ids, pos_by_id)
    edge_dev = metric_mod.compute_edge_length_deviation_score(edge_pairs, pos_by_id)
    edge_rat = metric_mod.compute_edge_length_ratio(edge_pairs, pos_by_id)
    spacing = metric_mod.compute_spacing_uniformity_score(node_ids, pos_by_id)
    orth = metric_mod.compute_edge_orthogonality_score(edge_pairs, pos_by_id)
    align = metric_mod.compute_axis_alignment_score(node_ids, pos_by_id)
    ang_res = metric_mod.compute_angular_resolution_score(graph, pos_by_id)
    if embedding:
        face = metric_mod.compute_uniform_face_area_score(node_ids, edge_pairs, pos_by_id, embedding)
        conv = metric_mod.compute_convexity_score(node_ids, edge_pairs, pos_by_id, embedding)
    else:
        face = {"ok": False}
        conv = {"ok": False}

    m = {
        "angularResolution": ang_res["score"] if ang_res.get("ok") else 0,
        "aspectRatio": aspect["score"] if aspect.get("ok") else 0,
        "convexity": conv["score"] if conv.get("ok") else 0,
        "edgeLengthDeviation": edge_dev["score"] if edge_dev.get("ok") else 0,
        "edgeRatio": edge_rat["ratio"] if edge_rat.get("ok") else 0,
        "edgeOrthogonality": orth["score"] if orth.get("ok") else 0,
        "face": face["quality"] if face.get("ok") else 0,
        "nodeUniformity": node_u["score"] if node_u.get("ok") else 0,
        "alignment": align["score"] if align.get("ok") else 0,
        "spacing": spacing["score"] if spacing.get("ok") else 0,
    }
    total = sum(m[k] for k in METRIC_KEYS)
    m["total"] = total / len(METRIC_KEYS)
    return m


def _rotate_positions(pos_by_id, theta):
    ids = list(pos_by_id.keys())
    if not ids:
        return {}
    cx = sum(pos_by_id[nid][0] for nid in ids) / len(ids)
    cy = sum(pos_by_id[nid][1] for nid in ids) / len(ids)
    cos = math.cos(theta)
    sin = math.sin(theta)
    out = {}
    for nid in ids:
        q = pos_by_id[nid]
        dx = q[0] - cx
        dy = q[1] - cy
        out[nid] = (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
    return out


def _find_best_rotation(node_ids, edge_pairs, pos_by_id, embedding):
    best_pos = pos_by_id
    best_score = None
    for i in range(19):
        theta = (i / 18) * (math.pi / 2)
        cand = pos_by_id if i == 0 else _rotate_positions(pos_by_id, theta)
        s = _compute_scores(node_ids, edge_pairs, cand, embedding)
        if best_score is None or s["total"] > best_score["total"]:
            best_score = s
            best_pos = cand
    return {"posById": best_pos, "scores": best_score}


def _build_adj_index(node_ids, edge_pairs):
    id_index = {str(nid): i for i, nid in enumerate(node_ids)}
    n = len(node_ids)
    incident = [[] for _ in range(n)]
    edges = []
    for (u_raw, v_raw) in edge_pairs:
        u = id_index.get(str(u_raw))
        v = id_index.get(str(v_raw))
        if u is None or v is None or u == v:
            continue
        idx = len(edges)
        edges.append((u, v))
        incident[u].append(idx)
        incident[v].append(idx)
    return {"idIndex": id_index, "incident": incident, "edges": edges}


def _move_breaks_planarity(v_idx, nx, ny, pos_arr, adj_index):
    edges = adj_index["edges"]
    incident = adj_index["incident"]
    inc_set = {ei: True for ei in incident[v_idx]}
    inc_edges = incident[v_idx]
    EPS = 1e-9
    pv = (nx, ny)

    for ei, (a, b) in enumerate(edges):
        if ei in inc_set:
            continue
        pa = pos_arr[a]
        pb = pos_arr[b]
        if abs(geo.triangle_area2(pa, pb, pv)) <= EPS and geo.point_on_segment_interior(pa, pb, pv, EPS):
            return True
        for ej in inc_edges:
            other = edges[ej][1] if edges[ej][0] == v_idx else edges[ej][0]
            if other == a or other == b:
                continue
            if geo.segments_intersect_or_touch(pv, pos_arr[other], pa, pb, EPS):
                return True

    for ek in inc_edges:
        other_k = edges[ek][1] if edges[ek][0] == v_idx else edges[ek][0]
        po = pos_arr[other_k]
        for w in range(len(pos_arr)):
            if w == v_idx or w == other_k:
                continue
            pw = pos_arr[w]
            if abs(geo.triangle_area2(pv, po, pw)) <= EPS and geo.point_on_segment_interior(pv, po, pw, EPS):
                return True
    return False


def _polish_scaffold(node_ids, edge_pairs, pos_by_id):
    adj_index = _build_adj_index(node_ids, edge_pairs)
    n = len(node_ids)
    pos_arr = [None] * n
    min_x = math.inf; min_y = math.inf; max_x = -math.inf; max_y = -math.inf
    for i, nid in enumerate(node_ids):
        p = pos_by_id[str(nid)]
        pos_arr[i] = [p[0], p[1]]
        if p[0] < min_x: min_x = p[0]
        if p[0] > max_x: max_x = p[0]
        if p[1] < min_y: min_y = p[1]
        if p[1] > max_y: max_y = p[1]
    diag = math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2)
    if not (diag > 0):
        diag = 1.0

    def snapshot():
        return {str(node_ids[k]): (pos_arr[k][0], pos_arr[k][1]) for k in range(n)}

    return {"adjIndex": adj_index, "posArr": pos_arr, "n": n, "diag": diag, "snapshot": snapshot}


def _make_time_guard(start_time_ms, budget_ms):
    def time_up():
        if not start_time_ms or not budget_ms:
            return False
        return _now_ms() - start_time_ms > budget_ms
    return time_up


def _polish_by_local_moves(node_ids, edge_pairs, pos_by_id, opts=None):
    opts = opts or {}
    embedding = opts.get("embedding")
    max_passes = opts.get("maxPasses", 2)
    step_scale = opts.get("stepScale", 0.08)
    min_step_scale = opts.get("minStepScale", 0.005)
    time_up = _make_time_guard(opts.get("startTimeMs"), opts.get("budgetMs"))

    ctx = _polish_scaffold(node_ids, edge_pairs, pos_by_id)
    pos_arr = ctx["posArr"]; n = ctx["n"]; diag = ctx["diag"]; adj_index = ctx["adjIndex"]
    pos_tuples = lambda: [(p[0], p[1]) for p in pos_arr]
    best_total = _compute_scores(node_ids, edge_pairs, ctx["snapshot"](), embedding)["total"]

    scale = step_scale
    for pass_ in range(max_passes):
        if time_up():
            break
        step = scale * diag
        if step < min_step_scale * diag:
            break
        improved = False
        for vi in range(n):
            if time_up():
                break
            px = pos_arr[vi][0]; py = pos_arr[vi][1]
            best_dx = 0.0; best_dy = 0.0
            for dx_unit, dy_unit in DIRS8:
                dx = dx_unit * step
                dy = dy_unit * step
                # Convert pos_arr to tuples for predicate — planarity helpers want tuples.
                pos_tuples_list = [(p[0], p[1]) for p in pos_arr]
                if _move_breaks_planarity(vi, px + dx, py + dy, pos_tuples_list, adj_index):
                    continue
                pos_arr[vi][0] = px + dx
                pos_arr[vi][1] = py + dy
                sc = _compute_scores(node_ids, edge_pairs, ctx["snapshot"](), embedding)
                pos_arr[vi][0] = px
                pos_arr[vi][1] = py
                if sc["total"] > best_total + 1e-8:
                    best_total = sc["total"]
                    best_dx = dx
                    best_dy = dy
                    improved = True
            if best_dx != 0 or best_dy != 0:
                pos_arr[vi][0] += best_dx
                pos_arr[vi][1] += best_dy
        if not improved:
            scale *= 0.5

    final_pos = ctx["snapshot"]()
    return {"positions": final_pos, "embedding": embedding,
            "scores": _compute_scores(node_ids, edge_pairs, final_pos, embedding)}


def _convexity_repair(node_ids, edge_pairs, pos_by_id, opts=None):
    opts = opts or {}
    embedding = opts.get("embedding")
    max_passes = opts.get("maxPasses", 3)
    time_up = _make_time_guard(opts.get("startTimeMs"), opts.get("budgetMs"))

    ctx = _polish_scaffold(node_ids, edge_pairs, pos_by_id)
    pos_arr = ctx["posArr"]; n = ctx["n"]; diag = ctx["diag"]; adj_index = ctx["adjIndex"]
    id_index = adj_index["idIndex"]
    best_total = _compute_scores(node_ids, edge_pairs, ctx["snapshot"](), embedding)["total"]

    def reflex_indices_of(face):
        if not face or len(face) < 4:
            return []
        pts = []
        for k in face:
            idx = id_index.get(str(k))
            if idx is None:
                return []
            pts.append(pos_arr[idx])
        s_area = 0.0
        for k in range(len(pts)):
            a = pts[k]
            b = pts[(k + 1) % len(pts)]
            s_area += a[0] * b[1] - b[0] * a[1]
        orient = 1 if s_area >= 0 else -1
        eps = diag * 1e-9
        result = []
        for k in range(len(pts)):
            prev = pts[(k - 1) % len(pts)]
            cur = pts[k]
            nxt = pts[(k + 1) % len(pts)]
            turn = (cur[0] - prev[0]) * (nxt[1] - cur[1]) - (cur[1] - prev[1]) * (nxt[0] - cur[0])
            if abs(turn) <= eps:
                continue
            turn_sign = 1 if turn > 0 else -1
            if turn_sign != orient:
                result.append(id_index[str(face[k])])
        return result

    for _ in range(max_passes):
        if time_up():
            break
        emb = embedding
        if not emb or not emb.get("ok"):
            break
        outer_idx = pg.find_outer_face_index(emb.get("faces") or [], emb.get("outerFace") or [])
        improved = False
        for fi, face in enumerate(emb.get("faces") or []):
            if time_up():
                break
            if fi == outer_idx:
                continue
            if not isinstance(face, (list, tuple)) or len(face) < 4:
                continue
            reflex = reflex_indices_of(face)
            if not reflex:
                continue
            cx = 0.0; cy = 0.0; m = 0
            valid = True
            for fk in face:
                fidx = id_index.get(str(fk))
                if fidx is None:
                    valid = False
                    break
                cx += pos_arr[fidx][0]
                cy += pos_arr[fidx][1]
                m += 1
            if not valid or m == 0:
                continue
            cx /= m
            cy /= m
            for v_idx in reflex:
                if time_up():
                    break
                px = pos_arr[v_idx][0]; py = pos_arr[v_idx][1]
                dx = cx - px
                dy = cy - py
                dlen = math.sqrt(dx * dx + dy * dy)
                if not (dlen > 0):
                    continue
                dx /= dlen
                dy /= dlen
                steps = [0.4, 0.2, 0.1, 0.05, 0.02]
                best_dx = 0.0
                best_dy = 0.0
                for s in steps:
                    dist = min(dlen * s, 0.15 * diag)
                    nx = px + dx * dist
                    ny = py + dy * dist
                    pos_tuples_list = [(p[0], p[1]) for p in pos_arr]
                    if _move_breaks_planarity(v_idx, nx, ny, pos_tuples_list, adj_index):
                        continue
                    pos_arr[v_idx][0] = nx
                    pos_arr[v_idx][1] = ny
                    sc = _compute_scores(node_ids, edge_pairs, ctx["snapshot"](), embedding)
                    pos_arr[v_idx][0] = px
                    pos_arr[v_idx][1] = py
                    if sc["total"] > best_total + 1e-8:
                        best_total = sc["total"]
                        best_dx = dx * dist
                        best_dy = dy * dist
                if best_dx != 0 or best_dy != 0:
                    pos_arr[v_idx][0] += best_dx
                    pos_arr[v_idx][1] += best_dy
                    improved = True
        if not improved:
            break

    final_pos = ctx["snapshot"]()
    return {"positions": final_pos, "embedding": embedding,
            "scores": _compute_scores(node_ids, edge_pairs, final_pos, embedding)}


def _seeded_rng(node_ids, edge_pairs):
    key = ",".join(sorted(str(x) for x in node_ids)) + "|" + ";".join(sorted(
        (f"{min(str(a), str(b))}-{max(str(a), str(b))}") for (a, b) in edge_pairs
    ))
    h = 2166136261 & 0xFFFFFFFF
    for ch in key:
        h ^= ord(ch) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    state = [h if h != 0 else 1]

    def rng():
        state[0] = (state[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return state[0] / 4294967296
    return rng


def _restart_perturb_and_polish(node_ids, edge_pairs, pos_by_id, rng, opts=None):
    opts = opts or {}
    embedding = opts.get("embedding")
    perturb_scale = opts.get("perturbScale", 0.03)
    min_x = math.inf; min_y = math.inf; max_x = -math.inf; max_y = -math.inf
    for nid in node_ids:
        p = pos_by_id[str(nid)]
        if p[0] < min_x: min_x = p[0]
        if p[0] > max_x: max_x = p[0]
        if p[1] < min_y: min_y = p[1]
        if p[1] > max_y: max_y = p[1]
    diag = math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2) or 1.0
    perturbed = {}
    for nid in node_ids:
        sid = str(nid)
        q = pos_by_id[sid]
        perturbed[sid] = (
            q[0] + (rng() * 2 - 1) * perturb_scale * diag,
            q[1] + (rng() * 2 - 1) * perturb_scale * diag,
        )
    if geo.has_position_crossings(perturbed, edge_pairs):
        return {"positions": pos_by_id, "embedding": embedding,
                "scores": _compute_scores(node_ids, edge_pairs, pos_by_id, embedding)}
    return _polish_by_local_moves(node_ids, edge_pairs, perturbed, {
        "embedding": embedding,
        "maxPasses": opts.get("maxPasses", 3),
        "stepScale": opts.get("stepScale", 0.012),
        "minStepScale": 0.0005,
        "startTimeMs": opts.get("startTimeMs"),
        "budgetMs": opts.get("budgetMs"),
    })


# --- graph-structure helpers (same as gpt.py, but duplicated for fidelity) ---
def _graph_info(graph):
    degree = {}
    adjacency = {}
    for nid in graph.node_ids:
        sid = str(nid)
        degree[sid] = 0
        adjacency[sid] = []
    for (u, v) in graph.edge_pairs:
        su, sv = str(u), str(v)
        if su not in adjacency or sv not in adjacency:
            continue
        degree[su] += 1
        degree[sv] += 1
        adjacency[su].append(sv)
        adjacency[sv].append(su)
    return {"degree": degree, "adjacency": adjacency}


def _is_connected(graph, info):
    if len(graph.node_ids) <= 1:
        return True
    seen = {str(graph.node_ids[0])}
    queue = [str(graph.node_ids[0])]
    qi = 0
    while qi < len(queue):
        for v_raw in info["adjacency"].get(queue[qi], []):
            v = str(v_raw)
            if v not in seen:
                seen.add(v)
                queue.append(v)
        qi += 1
    return len(queue) == len(graph.node_ids)


def _is_tree_graph(graph):
    return (len(graph.node_ids) > 0
            and len(graph.edge_pairs) == len(graph.node_ids) - 1
            and _is_connected(graph, _graph_info(graph)))


def _ordered_path_nodes(graph, info):
    start = None
    endpoints = 0
    for nid in graph.node_ids:
        sid = str(nid)
        d = info["degree"].get(sid, 0)
        if d > 2:
            return None
        if d <= 1:
            endpoints += 1
            if start is None or sid < start:
                start = sid
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
        for cand in sorted(info["adjacency"].get(current, [])):
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
        positions[str(order[i])] = (float(col if row % 2 == 0 else width - 1 - col), float(row))
    return positions


def _find_tree_center(graph, info):
    degree = {}
    leaves = []
    remaining = len(graph.node_ids)
    for nid in graph.node_ids:
        sid = str(nid)
        degree[sid] = info["degree"].get(sid, 0)
        if degree[sid] <= 1:
            leaves.append(sid)
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
        children[u] = []
        for v_raw in sorted(info["adjacency"].get(u, [])):
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


def _sort_children_by_leaves(children, root):
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
    return leaf_count


def _compute_layered_tree_positions(graph, info):
    rooted = _build_rooted_tree(graph, info)
    if not rooted:
        return None
    leaf_count = _sort_children_by_leaves(rooted["children"], rooted["root"])
    positions = {}
    next_x = [0]
    max_depth = [0]

    def assign(u):
        kids = rooted["children"].get(u) or []
        if rooted["depth"].get(u, 0) > max_depth[0]:
            max_depth[0] = rooted["depth"].get(u, 0)
        if not kids:
            positions[u] = (float(next_x[0]), float(rooted["depth"].get(u, 0)))
            next_x[0] += 1
            return positions[u][0]
        for k in kids:
            assign(k)
        positions[u] = ((positions[kids[0]][0] + positions[kids[-1]][0]) / 2.0,
                        float(rooted["depth"].get(u, 0)))
        return positions[u][0]

    assign(rooted["root"])
    width = max(1, next_x[0] - 1)
    level_gap = max(0.75, min(2.5, width / (max_depth[0] + 1))) if (width > 0 and max_depth[0] > 0) else 1.0
    for k in list(positions.keys()):
        positions[k] = (positions[k][0], positions[k][1] * level_gap)
    leaf_count[rooted["root"]] = leaf_count.get(rooted["root"], 1) or 1
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


def _compute_radial_tree_positions(graph):
    info = _graph_info(graph)
    if len(graph.edge_pairs) != len(graph.node_ids) - 1 or not _is_connected(graph, info):
        return {"ok": False, "message": "Not a tree"}
    if len(graph.node_ids) == 1:
        return {"ok": True, "positions": {str(graph.node_ids[0]): (0.0, 0.0)}, "message": "Computed radial tree layout"}
    rooted = _build_rooted_tree(graph, info)
    if not rooted:
        return {"ok": False, "message": "Radial tree rooting failed"}
    leaf_count = _sort_children_by_leaves(rooted["children"], rooted["root"])
    positions = {rooted["root"]: (0.0, 0.0)}

    def assign(u, start_angle, end_angle):
        kids = rooted["children"].get(u) or []
        if not kids:
            return
        total = sum(leaf_count.get(k, 1) for k in kids)
        cursor = start_angle
        for k in kids:
            span = (end_angle - start_angle) * leaf_count.get(k, 1) / max(1, total)
            angle = cursor + span / 2
            radius = 1.15 * (rooted["depth"].get(k, 1))
            positions[k] = (radius * math.cos(angle), radius * math.sin(angle))
            assign(k, cursor, cursor + span)
            cursor += span

    assign(rooted["root"], -math.pi, math.pi)
    return {"ok": True, "positions": positions, "message": "Computed radial tree layout"}


def _extract_unicyclic_cycle(graph, info):
    if len(graph.node_ids) < 3 or len(graph.edge_pairs) != len(graph.node_ids) or not _is_connected(graph, info):
        return None
    degree = {}
    removed = {}
    queue = []
    for nid in graph.node_ids:
        sid = str(nid)
        degree[sid] = info["degree"].get(sid, 0)
        if degree[sid] <= 1:
            queue.append(sid)
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
    for nid in graph.node_ids:
        sid = str(nid)
        if not removed.get(sid):
            core.append(sid)
            in_core[sid] = True
    if len(core) < 3:
        return None
    for sid in core:
        core_degree = sum(1 for v_raw in info["adjacency"].get(sid, []) if in_core.get(str(v_raw)))
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
    return bool(_extract_unicyclic_cycle(graph, _graph_info(graph)))


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
        angle = -math.pi / 2 + math.pi * 2 * i / k
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

    for root in cycle:
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
        for j in kids:
            total += count_leaves(j)
        leaf_count[u] = total
        kids.sort(key=lambda a: (-leaf_count[a], a))
        return total

    for c in cycle:
        count_leaves(c)

    def assign_subtree(u, depth, start_angle, end_angle):
        kids = children.get(u) or []
        if not kids:
            return
        total = sum(leaf_count.get(k, 1) for k in kids)
        cursor = start_angle
        for child in kids:
            span = (end_angle - start_angle) * leaf_count.get(child, 1) / max(1, total)
            a0 = cursor
            a1 = cursor + span
            child_angle = (a0 + a1) / 2
            radius = cycle_radius + depth * 1.05
            positions[child] = (radius * math.cos(child_angle), radius * math.sin(child_angle))
            assign_subtree(child, depth + 1, a0, a1)
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
    for nid in graph.node_ids:
        d = info["degree"].get(str(nid), 0)
        if d > 4 or d < 2:
            return False
        if d == 2:
            corners += 1
    return corners == 4 and _is_connected(graph, info)


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


def _multi_source_distances(sources, info):
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


def _compute_two_row_grid_positions(graph, info, columns):
    edges = {}
    for (u, v) in graph.edge_pairs:
        edges[gu.edge_key(str(u), str(v))] = True
    corners = [str(nid) for nid in graph.node_ids if info["degree"].get(str(nid), 0) == 2]
    corners.sort()
    for top in corners:
        for bottom_raw in sorted(info["adjacency"].get(top, [])):
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
                top_next = [str(n) for n in info["adjacency"].get(top_cur, [])
                            if n != top_prev and n != bottom_cur and not seen.get(str(n))]
                bottom_next = [str(n) for n in info["adjacency"].get(bottom_cur, [])
                               if n != bottom_prev and n != top_cur and not seen.get(str(n))]
                if len(top_next) != 1 or len(bottom_next) != 1 or not edges.get(gu.edge_key(top_next[0], bottom_next[0])):
                    valid = False
                    break
                top_prev = top_cur
                bottom_prev = bottom_cur
                top_cur = top_next[0]
                bottom_cur = bottom_next[0]
            if valid and len(seen) == len(graph.node_ids):
                return {"ok": True, "positions": positions, "message": "Computed two-row grid layout"}
    return {"ok": False, "message": "Two-row grid coordinate recovery failed"}


def _compute_rectangular_grid_positions(graph):
    if not _has_rectangular_grid_signature(graph):
        return {"ok": False, "message": "Not a rectangular grid"}
    info = _graph_info(graph)
    dims = _rectangular_grid_dimensions(graph)
    if dims and (dims["rows"] == 2 or dims["cols"] == 2):
        return _compute_two_row_grid_positions(graph, info, max(dims["rows"], dims["cols"]))
    corners = sorted(str(nid) for nid in graph.node_ids if info["degree"].get(str(nid), 0) == 2)
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
            dist_to_y = _multi_source_distances(path_y, info)
            dist_to_x = _multi_source_distances(path_x, info)
            positions = {}
            occupied = {}
            valid = True
            for nid in graph.node_ids:
                sid = str(nid)
                x = dist_to_y.get(sid)
                y = dist_to_x.get(sid)
                if x is None or y is None or x < 0 or y < 0 or x > width or y > height:
                    valid = False
                    break
                key = f"{x},{y}"
                if occupied.get(key):
                    valid = False
                    break
                occupied[key] = True
                positions[sid] = (float(x), float(y))
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
    node_ids = [str(x) for x in graph.node_ids]
    id_set = set(node_ids)
    hub = "@claudeOuterHub"
    suffix = 1
    while hub in id_set:
        hub = f"@claudeOuterHub{suffix}"
        suffix += 1
    edge_pairs = [(str(u), str(v)) for (u, v) in graph.edge_pairs]
    for nid in node_ids:
        edge_pairs.append((hub, nid))
    embedding = planarity.compute_planar_embedding(node_ids + [hub], edge_pairs)
    if not embedding or not embedding.get("ok") or not isinstance(embedding.get("rotation"), list):
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
    max_nodes = opts.get("coreTreeMaxNodes", CUSTOM_LIMITS["coreTreeMaxNodes"])
    max_core = opts.get("coreTreeMaxCoreNodes", CUSTOM_LIMITS["coreTreeMaxCoreNodes"])
    if len(graph.node_ids) > max_nodes:
        return None
    info = _graph_info(graph)
    if not _is_connected(graph, info):
        return None
    degree = {}
    removed = {}
    queue = []
    for nid in graph.node_ids:
        sid = str(nid)
        degree[sid] = info["degree"].get(sid, 0)
        if degree[sid] <= 1:
            queue.append(sid)
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
    for nid in graph.node_ids:
        sid = str(nid)
        if not removed.get(sid):
            core.append(sid)
            core_set[sid] = True
    if len(core) < 3 or len(core) == len(graph.node_ids) or len(core) > max_core:
        return None
    core_edges = []
    for (u, v) in graph.edge_pairs:
        a, b = str(u), str(v)
        if core_set.get(a) and core_set.get(b):
            core_edges.append((a, b))
    if len(core_edges) < len(core):
        return None
    return {"info": info, "core": core, "coreSet": core_set,
            "coreGraph": gu.create_graph(core, core_edges)}


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
    for (u, v) in graph.edge_pairs:
        su, sv = str(u), str(v)
        if edge_filter and not edge_filter(su, sv):
            continue
        pu = pos_by_id.get(su)
        pv = pos_by_id.get(sv)
        if pu is None or pv is None:
            continue
        length = math.hypot(pu[0] - pv[0], pu[1] - pv[1])
        if length > 0:
            lengths.append(length)
    return _median_finite(lengths)


def _copy_positions_for_nodes(pos_by_id, node_ids):
    out = {}
    for raw in node_ids:
        nid = str(raw)
        p = pos_by_id.get(nid)
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            return None
        out[nid] = (p[0], p[1])
    return out


def _compute_core_tree_positions(graph, options):
    core_info = _compute_two_core_info(graph, options)
    if not core_info:
        return {"ok": False, "message": "Not an eligible core-tree graph"}
    core_result = edgebalancer_layout.apply_layout(core_info["coreGraph"])
    positions_full = core_result.get("positions") if core_result else None
    if not core_result or not core_result.get("ok") or not positions_full:
        return {"ok": False, "message": "CoreTree core layout failed"}
    positions = _copy_positions_for_nodes(positions_full, core_info["core"])
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

    cx = 0.0; cy = 0.0
    for cid in core_info["core"]:
        cx += positions[cid][0]; cy += positions[cid][1]
    cx /= len(core_info["core"]); cy /= len(core_info["core"])
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
            angle = cursor + span / 2
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


def _extract_candidate_embedding(graph, pos_by_id):
    embedding = pg.extract_embedding_from_positions(graph.node_ids, graph.edge_pairs, pos_by_id)
    return embedding if embedding and embedding.get("ok") else None


def _run_module_candidate(apply_fn, graph, runtime):
    result = apply_fn(graph, options=runtime)
    positions = result.get("positions") if result else None
    embedding = _extract_candidate_embedding(graph, positions) if positions else None
    return {"ok": bool(result and result.get("ok") and embedding), "posById": positions, "embedding": embedding}


def _run_internal_candidate(compute_fn, graph, *args):
    result = compute_fn(graph, *args)
    positions = result.get("positions") if result else None
    embedding = _extract_candidate_embedding(graph, positions) if positions else None
    return {"ok": bool(result and result.get("ok") and embedding), "posById": positions, "embedding": embedding}


def _custom_limit(options, key):
    v = options.get(key)
    return v if (isinstance(v, (int, float)) and math.isfinite(v)) else CUSTOM_LIMITS[key]


def _balancer_interior_limit(options):
    v = options.get("balancerMaxInteriorAugVertices")
    return max(0, int(v)) if (isinstance(v, (int, float)) and math.isfinite(v)) else BALANCER_MAX_INTERIOR_AUG_VERTICES


def _build_candidate_runners(graph, options, runtime):
    opts = options
    n = len(graph.node_ids)
    runners = []

    if n <= _custom_limit(opts, "treeMaxNodes") and _is_tree_graph(graph):
        runners.append(("Tree", lambda: _run_internal_candidate(_compute_tree_positions, graph)))
    if n <= _custom_limit(opts, "radialTreeMaxNodes") and _is_tree_graph(graph):
        runners.append(("RadialTree", lambda: _run_internal_candidate(_compute_radial_tree_positions, graph)))
    if n <= _custom_limit(opts, "unicyclicMaxNodes") and _is_unicyclic_graph(graph):
        runners.append(("Unicyclic", lambda: _run_internal_candidate(_compute_unicyclic_positions, graph)))
    if n <= _custom_limit(opts, "gridMaxNodes") and _has_rectangular_grid_signature(graph):
        runners.append(("Grid", lambda: _run_internal_candidate(_compute_rectangular_grid_positions, graph)))
    if n <= _custom_limit(opts, "outerplanarMaxNodes") and _is_outerplanar_graph(graph):
        runners.append(("OuterCircle", lambda: _run_internal_candidate(_compute_outerplanar_circle_positions, graph)))
    if n <= _custom_limit(opts, "coreTreeMaxNodes") and _should_try_core_tree(graph, opts):
        runners.append(("CoreTree", lambda: _run_internal_candidate(_compute_core_tree_positions, graph, opts)))

    # Module candidates — JS adds per-module size limits via interior-aug-vertex counts,
    # but since our balancer runs return an augmented graph, we can approximate by
    # always trying them (port-fidelity: same order as JS).
    def run_apply(apply_fn):
        return lambda: _run_module_candidate(apply_fn, graph, runtime)

    runners.append(("EdgeBalancer", run_apply(edgebalancer_layout.apply_layout)))
    runners.append(("FABalancer", run_apply(fabalancer_layout.apply_layout)))
    runners.append(("AngleBalancer", run_apply(anglebalancer_layout.apply_layout)))
    runners.append(("AreaGrad", run_apply(areagrad_layout.apply_layout)))
    runners.append(("FaceBalancer", run_apply(facebalancer_layout.apply_layout)))
    runners.append(("Reweight", run_apply(reweight_layout.apply_layout)))
    runners.append(("Schnyder", run_apply(schnyder_layout.apply_layout)))
    runners.append(("CEGBfs", run_apply(ceg_layout.apply_bfs)))
    runners.append(("Tutte", run_apply(tutte_layout.apply_layout)))

    return runners


def _expand_variants(label, pos_by_id, embedding, node_ids, edge_pairs, time_left):
    variants = [{"label": f"{label}:base", "posById": pos_by_id, "embedding": embedding,
                 "scores": _compute_scores(node_ids, edge_pairs, pos_by_id, embedding)}]
    if time_left and time_left() < 1000:
        return variants
    rot = _find_best_rotation(node_ids, edge_pairs, pos_by_id, embedding)
    variants.append({"label": f"{label}:rot", "posById": rot["posById"], "embedding": embedding, "scores": rot["scores"]})
    if not time_left or time_left() > 500:
        a1 = alignment.align_to_axis_greedy(node_ids, edge_pairs, rot["posById"], {})
        if a1.get("ok"):
            variants.append({"label": f"{label}:rot+align", "posById": a1["positions"], "embedding": embedding,
                             "scores": _compute_scores(node_ids, edge_pairs, a1["positions"], embedding)})
    return variants


def _try_align(node_ids, edge_pairs, best):
    a = alignment.align_to_axis_greedy(node_ids, edge_pairs, best["posById"], {})
    if not a.get("ok"):
        return best
    s = _compute_scores(node_ids, edge_pairs, a["positions"], best["embedding"])
    if s["total"] > best["scores"]["total"]:
        return {"label": best["label"] + "+align", "posById": a["positions"], "embedding": best["embedding"], "scores": s}
    return best


def _try_rot(node_ids, edge_pairs, best):
    r = _find_best_rotation(node_ids, edge_pairs, best["posById"], best["embedding"])
    if r["scores"]["total"] > best["scores"]["total"]:
        return {"label": best["label"] + "+rot", "posById": r["posById"], "embedding": best["embedding"], "scores": r["scores"]}
    return best


def _try_polish(node_ids, edge_pairs, best, opts, tag):
    opts = {**(opts or {}), "embedding": best["embedding"]}
    res = _polish_by_local_moves(node_ids, edge_pairs, best["posById"], opts)
    if res["scores"]["total"] > best["scores"]["total"]:
        return {"label": best["label"] + tag, "posById": res["positions"], "embedding": best["embedding"], "scores": res["scores"]}
    return best


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    start_ms = _now_ms()
    global_budget_ms = opts.get("claudeBudgetMs", 22000)

    def time_left():
        return global_budget_ms - (_now_ms() - start_ms)

    node_ids = list(graph.node_ids)
    edge_pairs = list(graph.edge_pairs)
    _shared_ctx["graph"] = graph
    runtime = {**opts, "currentPositions": initial_positions or {}}

    runners = _build_candidate_runners(graph, opts, runtime)

    variants = []
    for i, (label, runner) in enumerate(runners):
        if i > 0 and time_left() < 3000:
            break
        try:
            out = runner()
        except Exception:
            continue
        if out.get("ok"):
            for v in _expand_variants(label, out["posById"], out["embedding"], node_ids, edge_pairs, time_left):
                variants.append(v)

    if not variants:
        return gu.build_layout_error({"message": "Claude failed (no valid candidates)"})
    variants.sort(key=lambda a: -a["scores"]["total"])
    best = variants[0]

    n = len(node_ids)
    polish_passes = 2 if n > 80 else (3 if n > 60 else (4 if n > 40 else 5))
    polish_step = 0.03 if n > 80 else (0.04 if n > 60 else (0.05 if n > 40 else 0.06))

    if n <= 150 and time_left() > 1500:
        total_budget = min(7000 if n > 75 else (16000 if n > 50 else 22000), time_left() - 1500)
        num_starts = 1 if n > 75 else (2 if n > 50 else 3)
        top_k = variants[:min(num_starts, len(variants))]
        per_variant = max(1500, total_budget // len(top_k))
        for start_var in top_k:
            polished = _polish_by_local_moves(node_ids, edge_pairs, start_var["posById"], {
                "embedding": start_var["embedding"],
                "maxPasses": polish_passes, "stepScale": polish_step,
                "startTimeMs": _now_ms(), "budgetMs": per_variant,
            })
            if polished["scores"]["total"] > best["scores"]["total"]:
                best = {"label": start_var["label"] + "+polish",
                        "posById": polished["positions"],
                        "embedding": start_var["embedding"],
                        "scores": polished["scores"]}

        best = _try_rot(node_ids, edge_pairs, best)
        best = _try_align(node_ids, edge_pairs, best)

        if n <= 75 and time_left() > 1000:
            best = _try_polish(node_ids, edge_pairs, best, {
                "maxPasses": 4, "stepScale": 0.015, "minStepScale": 0.001,
                "startTimeMs": _now_ms(), "budgetMs": min(3500 if n > 50 else 5000, time_left() - 1000),
            }, "+fine")

            if time_left() > 800:
                best = _try_polish(node_ids, edge_pairs, best, {
                    "maxPasses": 3, "stepScale": 0.004, "minStepScale": 0.0003,
                    "startTimeMs": _now_ms(), "budgetMs": min(2000 if n > 50 else 3000, time_left() - 500),
                }, "+micro")
                best = _try_align(node_ids, edge_pairs, best)

            if time_left() > 600:
                repaired = _convexity_repair(node_ids, edge_pairs, best["posById"], {
                    "embedding": best["embedding"], "maxPasses": 3,
                    "startTimeMs": _now_ms(), "budgetMs": min(2500 if n > 50 else 4000, time_left() - 500),
                })
                if repaired["scores"]["total"] > best["scores"]["total"]:
                    best = {"label": best["label"] + "+cvx", "posById": repaired["positions"],
                            "embedding": best["embedding"], "scores": repaired["scores"]}
                if time_left() > 400:
                    best = _try_polish(node_ids, edge_pairs, best, {
                        "maxPasses": 2, "stepScale": 0.008, "minStepScale": 0.0005,
                        "startTimeMs": _now_ms(), "budgetMs": min(1500, time_left() - 300),
                    }, "+cvxpol")

            if n <= 50 and time_left() > 2000:
                rng = _seeded_rng(node_ids, edge_pairs)
                restart_budget = min(4000, time_left() - 1500)
                num_restarts = 2 if n > 30 else 3
                per_restart = restart_budget // num_restarts
                perturb_scales = [0.015, 0.03, 0.06]
                for ri in range(num_restarts):
                    if time_left() < 800:
                        break
                    res = _restart_perturb_and_polish(node_ids, edge_pairs, best["posById"], rng, {
                        "embedding": best["embedding"],
                        "perturbScale": perturb_scales[ri % len(perturb_scales)],
                        "maxPasses": 3, "stepScale": 0.012,
                        "startTimeMs": _now_ms(), "budgetMs": per_restart,
                    })
                    if res["scores"]["total"] > best["scores"]["total"]:
                        best = {"label": best["label"] + f"+restart{ri}", "posById": res["positions"],
                                "embedding": best["embedding"], "scores": res["scores"]}

            if time_left() > 300:
                best = _try_polish(node_ids, edge_pairs, best, {
                    "maxPasses": 2, "stepScale": 0.003, "minStepScale": 0.0002,
                    "startTimeMs": _now_ms(), "budgetMs": min(1500, time_left() - 200),
                }, "+settle")

    if n <= 70 and time_left() > 1500:
        outer_iters = 2 if n > 40 else 3
        for _ in range(outer_iters):
            if time_left() < 800:
                break
            before = best["scores"]["total"]
            best = _try_rot(node_ids, edge_pairs, best)
            best = _try_align(node_ids, edge_pairs, best)
            if time_left() > 800:
                best = _try_polish(node_ids, edge_pairs, best, {
                    "maxPasses": 3, "stepScale": 0.006, "minStepScale": 0.0003,
                    "startTimeMs": _now_ms(), "budgetMs": min(1800, time_left() - 500),
                }, "+fineIter")
            if best["scores"]["total"] <= before + 1e-6:
                break

    return gu.build_layout_result({
        "ok": True,
        "positions": geo.normalize_position_map_to_viewport(best["posById"]),
        "message": f"Claude selected {best['label']} (score={best['scores']['total']:.4f})",
        "bestScore": best["scores"]["total"],
    })
