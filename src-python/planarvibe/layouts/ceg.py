"""CEG-bfs and CEG-xy layouts. Port of static/js/layout-ceg.js.

Exports two apply functions: `apply_bfs` and `apply_xy`.
"""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import preprocessing
from . import tutte

CEG_CONFIG = {
    "bfsBaseWeight": 1.0,
    "bfsDepthRatio": 1.35,
    "xyLambda": 0.5,
}


def _build_uniform_weights(edge_pairs, value: float = 1.0) -> dict:
    w = value if (isinstance(value, (int, float)) and math.isfinite(value) and value > 0) else 1.0
    return {gu.edge_key(u, v): w for (u, v) in edge_pairs}


def _bfs_depth_from_outer(node_ids, adjacency, outer_face) -> dict[str, float]:
    depth: dict[str, float] = {str(nid): math.inf for nid in node_ids}
    q: list[str] = []
    head = 0
    for root in outer_face:
        r = str(root)
        depth[r] = 0
        q.append(r)
    while head < len(q):
        u = q[head]; head += 1
        du = depth[u]
        for v_raw in adjacency.get(u, []):
            v = str(v_raw)
            if depth[v] <= du + 1:
                continue
            depth[v] = du + 1
            q.append(v)
    for nid in node_ids:
        if not math.isfinite(depth.get(str(nid), math.inf)):
            depth[str(nid)] = 0.0
    return depth


def _build_depth_weights(edge_pairs, depth_by_id, a, r) -> dict:
    scale = a if (isinstance(a, (int, float)) and math.isfinite(a) and a > 0) else 1.0
    ratio = r if (isinstance(r, (int, float)) and math.isfinite(r) and r > 1) else 1.35
    out: dict[str, float] = {}
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        du = depth_by_id.get(u, 0)
        dv = depth_by_id.get(v, 0)
        d = 1 + min(du, dv)
        if not math.isfinite(d) or d < 0:
            d = 0
        w = scale / (ratio ** d)
        if not (w > 0):
            w = 1.0
        out[gu.edge_key(u, v)] = w
    return out


def _has_vertical_spread_edge(edge_pairs, pos_by_id, epsilon: float = 1e-7) -> bool:
    tol = epsilon if (isinstance(epsilon, (int, float)) and math.isfinite(epsilon) and epsilon > 0) else 1e-7
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if pu is None or pv is None:
            continue
        if abs(pu[0] - pv[0]) <= tol:
            return True
    return False


def _rotate_for_spread(node_ids, edge_pairs, pos_by_id):
    center = geo.compute_face_centroid(pos_by_id, node_ids)
    angles = [
        0, 1e-6, -1e-6, 1e-5, -1e-5, 1e-4, -1e-4, 1e-3, -1e-3, 1e-2, -1e-2,
        math.pi / 180, -math.pi / 180,
    ]
    for ang in angles:
        rotated = geo.rotate_position_map(pos_by_id, center, ang)
        if not _has_vertical_spread_edge(edge_pairs, rotated, 1e-7):
            return rotated
    return geo.rotate_position_map(pos_by_id, center, 1e-2)


def _build_fixed_outer_positions(outer_face, pos_by_id):
    return geo.filter_position_map(pos_by_id, outer_face)


def _sorted_node_ids(node_ids, pos_by_id, axis: str) -> list[str]:
    axis_idx = 0 if axis == "x" else 1

    def key_for(nid):
        p = pos_by_id.get(nid)
        v = p[axis_idx] if (p is not None and math.isfinite(p[axis_idx])) else 0
        return v

    # JS behavior: sort by value with 1e-9 tolerance; ties broken by string compare.
    import functools

    def cmp(a, b):
        va = key_for(a)
        vb = key_for(b)
        if abs(va - vb) > 1e-9:
            return -1 if va < vb else 1
        sa, sb = str(a), str(b)
        if sa < sb:
            return -1
        if sa > sb:
            return 1
        return 0

    return sorted(node_ids, key=functools.cmp_to_key(cmp))


def _build_spread_orientation(node_ids, edge_pairs, pos_by_id) -> dict:
    sorted_ids = _sorted_node_ids(node_ids, pos_by_id, "x")
    order = {str(nid): i for i, nid in enumerate(sorted_ids)}
    out_adj: dict[str, list[str]] = {str(nid): [] for nid in sorted_ids}
    in_adj: dict[str, list[str]] = {str(nid): [] for nid in sorted_ids}
    out_degree: dict[str, int] = {str(nid): 0 for nid in sorted_ids}
    in_degree: dict[str, int] = {str(nid): 0 for nid in sorted_ids}
    edge_dir: dict[str, dict] = {}

    for (a_raw, b_raw) in edge_pairs:
        a, b = str(a_raw), str(b_raw)
        u = a if order[a] < order[b] else b
        v = b if u == a else a
        out_adj[u].append(v)
        in_adj[v].append(u)
        out_degree[u] += 1
        in_degree[v] += 1
        edge_dir[gu.edge_key(a, b)] = {"from": u, "to": v}

    return {
        "sorted": sorted_ids,
        "order": order,
        "source": str(sorted_ids[0]),
        "sink": str(sorted_ids[-1]),
        "outAdj": out_adj,
        "inAdj": in_adj,
        "outDegree": out_degree,
        "inDegree": in_degree,
        "edgeDir": edge_dir,
    }


def _build_forward_tree(sorted_ids, in_adj, source):
    dist = {str(nid): math.inf for nid in sorted_ids}
    parent: dict[str, str | None] = {str(nid): None for nid in sorted_ids}
    children: dict[str, list[str]] = {str(nid): [] for nid in sorted_ids}
    dist[source] = 0
    for nid in sorted_ids:
        i = str(nid)
        if i == source:
            continue
        preds = in_adj.get(i, [])
        best_parent: str | None = None
        best_dist = math.inf
        for pred_raw in preds:
            pred = str(pred_raw)
            if dist[pred] < best_dist:
                best_dist = dist[pred]
                best_parent = pred
        if best_parent is None or not math.isfinite(best_dist):
            return None
        parent[i] = best_parent
        dist[i] = best_dist + 1
        children[best_parent].append(i)
    return {"parent": parent, "children": children, "dist": dist}


def _build_backward_tree(sorted_ids, out_adj, sink):
    dist = {str(nid): math.inf for nid in sorted_ids}
    parent: dict[str, str | None] = {str(nid): None for nid in sorted_ids}
    children: dict[str, list[str]] = {str(nid): [] for nid in sorted_ids}
    dist[sink] = 0
    for nid in reversed(sorted_ids):
        i = str(nid)
        if i == sink:
            continue
        succs = out_adj.get(i, [])
        best_parent: str | None = None
        best_dist = math.inf
        for succ_raw in succs:
            succ = str(succ_raw)
            if dist[succ] < best_dist:
                best_dist = dist[succ]
                best_parent = succ
        if best_parent is None or not math.isfinite(best_dist):
            return None
        parent[i] = best_parent
        dist[i] = best_dist + 1
        children[best_parent].append(i)
    return {"parent": parent, "children": children, "dist": dist}


def _compute_forward_subtree_sums(sorted_ids, children, value_by_id):
    s = {str(nid): (value_by_id.get(str(nid)) if isinstance(value_by_id.get(str(nid)), (int, float)) and math.isfinite(value_by_id.get(str(nid))) else 0) for nid in sorted_ids}
    for nid in reversed(sorted_ids):
        i = str(nid)
        for kid_raw in children.get(i, []):
            kid = str(kid_raw)
            s[i] += s[kid]
    return s


def _compute_backward_subtree_sums(sorted_ids, parent, value_by_id):
    s = {str(nid): (value_by_id.get(str(nid)) if isinstance(value_by_id.get(str(nid)), (int, float)) and math.isfinite(value_by_id.get(str(nid))) else 0) for nid in sorted_ids}
    for nid in sorted_ids:
        i = str(nid)
        p = parent.get(i)
        if p is not None:
            s[p] += s[i]
    return s


def _build_rank_spaced_target_coordinates(sorted_ids, pos_by_id):
    target: dict[str, float] = {}
    min_x = math.inf
    max_x = -math.inf
    for nid in sorted_ids:
        p = pos_by_id.get(str(nid))
        if p is not None and math.isfinite(p[0]):
            min_x = min(min_x, p[0])
            max_x = max(max_x, p[0])
    if not (max_x > min_x):
        for i, nid in enumerate(sorted_ids):
            target[str(nid)] = i
        return target
    step = (max_x - min_x) / max(1, len(sorted_ids) - 1)
    for i, nid in enumerate(sorted_ids):
        target[str(nid)] = min_x + step * i
    return target


def _build_spread_path_weights(state: dict, working_positions: dict, failure_label: str) -> dict:
    orientation = _build_spread_orientation(state["augmentedIds"], state["augmentedPairs"], working_positions)
    forward = _build_forward_tree(orientation["sorted"], orientation["inAdj"], orientation["source"])
    backward = _build_backward_tree(orientation["sorted"], orientation["outAdj"], orientation["sink"])
    if forward is None or backward is None:
        return gu.build_layout_error({
            "message": f"{failure_label} could not build spread trees on the augmented graph",
            "graph": state["prepared"]["graph"],
            "outerFace": state["augmentedOuterFace"],
            "augmented": state["augmented"],
        })

    target_x = _build_rank_spaced_target_coordinates(orientation["sorted"], working_positions)
    forward_sum = _compute_forward_subtree_sums(orientation["sorted"], forward["children"], orientation["outDegree"])
    backward_sum = _compute_backward_subtree_sums(orientation["sorted"], backward["parent"], orientation["inDegree"])
    weights: dict[str, float] = {}

    for (a_raw, b_raw) in state["augmentedPairs"]:
        a, b = str(a_raw), str(b_raw)
        key = gu.edge_key(a, b)
        edge_dir = orientation["edgeDir"].get(key)
        if edge_dir is None:
            continue
        u = edge_dir["from"]
        v = edge_dir["to"]
        delta = target_x[v] - target_x[u]
        if not (delta > 1e-9):
            delta = 1e-9
        count = 1
        if forward["parent"].get(v) == u:
            count += forward_sum[v]
        if backward["parent"].get(u) == v:
            count += backward_sum[u]
        weight = count / delta
        if not math.isfinite(weight) or not (weight > 0):
            weight = 1.0
        weights[key] = weight

    return gu.build_layout_result({"weights": weights, "orientation": orientation, "targetX": target_x})


def _build_spread_state(state: dict, base_positions: dict, angle: float, failure_label: str) -> dict:
    rotated = geo.rotate_position_map(
        base_positions,
        geo.compute_face_centroid(base_positions, state["augmentedIds"]),
        angle if math.isfinite(angle) else 0,
    )
    working = _rotate_for_spread(state["augmentedIds"], state["augmentedPairs"], rotated)
    spread = _build_spread_path_weights(state, working, failure_label)
    if not spread.get("ok"):
        return spread
    return gu.build_layout_result({"weights": spread["weights"]})


def _combine_weights(edge_pairs, w_a, w_b, lambda_a):
    out: dict[str, float] = {}
    lam = max(0.0, min(1.0, lambda_a)) if math.isfinite(lambda_a) else 0.5
    lam_b = 1 - lam
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        key = gu.edge_key(u, v)
        a = w_a.get(key) if (isinstance(w_a.get(key), (int, float)) and math.isfinite(w_a.get(key))) else 1
        b = w_b.get(key) if (isinstance(w_b.get(key), (int, float)) and math.isfinite(w_b.get(key))) else 1
        w = lam * a + lam_b * b
        if not math.isfinite(w) or not (w > 0):
            w = 1.0
        out[key] = w
    return out


def _build_ceg_state_from_prepared(prepared: dict, failure_label: str) -> dict:
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": f"{failure_label} requires a planar graph"})
    base_graph = prepared["graph"]
    return gu.build_layout_result({
        "failureLabel": failure_label,
        "ids": base_graph.node_ids,
        "pairs": base_graph.edge_pairs,
        "prepared": prepared,
        "augmented": prepared["augmented"],
        "outerFace": prepared["outerFace"],
        "augmentedOuterFace": prepared["augmentedOuterFace"],
        "augmentedIds": prepared["augmented"]["graph"].node_ids,
        "augmentedPairs": prepared["augmented"]["graph"].edge_pairs,
        "adjacency": prepared["augmented"]["graph"].adjacency,
    })


def _solve_augmented_weighted_layout(state: dict, weights: dict, init_options: dict | None = None) -> dict:
    return tutte.compute_barycentric_positions(
        state["augmented"]["graph"],
        state["augmentedOuterFace"],
        {
            "adjacency": state["adjacency"],
            "weights": weights,
            "initOptions": tutte.default_outer_placement_options(init_options or {}),
        },
    )


def _project_ceg_positions(state: dict, pos_by_id: dict, failure_label: str) -> dict:
    projected = geo.filter_position_map(pos_by_id, state["ids"])
    if geo.has_position_crossings(projected, state["pairs"]):
        return gu.build_layout_error({"message": f"{failure_label} produced a non-plane drawing"})
    return gu.build_layout_result({"projected": projected})


def _build_ceg_success_result(state: dict, pos_by_id: dict, iters: int, message: str) -> dict:
    projected_result = _project_ceg_positions(state, pos_by_id, state["failureLabel"])
    if not projected_result.get("ok"):
        return projected_result
    return gu.build_layout_result({
        "nodeIds": state["ids"],
        "edgePairs": state["pairs"],
        "outerFace": state["outerFace"],
        "graph": state["prepared"]["graph"],
        "augmented": state["augmented"],
        "positions": projected_result["projected"],
        "posById": pos_by_id,
        "iters": iters,
        "message": message,
    })


def _prepare(graph, failure_label: str, options: dict | None) -> dict:
    opts = options or {}
    prepared = preprocessing.prepare_graph_and_layout_data(graph, {
        "failureLabel": failure_label,
        "augmentationMethod": opts.get("augmentationMethod"),
        "currentPositions": opts.get("currentPositions") or {},
    })
    return _build_ceg_state_from_prepared(prepared, failure_label)


def apply_bfs(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = dict(options or {})
    opts["currentPositions"] = initial_positions or {}
    state = _prepare(graph, "CEG-bfs", opts)
    if not state or not state.get("ok"):
        return state or gu.build_layout_error({"message": "CEG-bfs failed"})

    A = CEG_CONFIG["bfsBaseWeight"]
    R = CEG_CONFIG["bfsDepthRatio"]
    depth_by_id = _bfs_depth_from_outer(state["augmentedIds"], state["adjacency"], state["augmentedOuterFace"])
    weights = _build_depth_weights(state["augmentedPairs"], depth_by_id, A, R)
    out = _solve_augmented_weighted_layout(state, weights)
    if not out.get("ok"):
        return gu.build_layout_error({
            "message": out.get("message") or "CEG-bfs solver failed",
            "graph": state["prepared"]["graph"],
            "outerFace": state["augmentedOuterFace"],
            "augmented": state["augmented"],
        })
    dummy_count = state["augmented"].get("dummyCount") or 0
    msg = ("Applied CEG-bfs ("
           f"{len(state['augmentedOuterFace'])}-vertex outer face, multi-source outer BFS, "
           f"edgeDepth=1+min(endpointDepth), r={R}"
           f"{(', +' + str(dummy_count) + ' dummy vertices') if dummy_count > 0 else ''}"
           f", {out.get('iters')} total iters)")
    return _build_ceg_success_result(state, out["positions"], out.get("iters", 0), msg)


def apply_xy(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = dict(options or {})
    opts["currentPositions"] = initial_positions or {}
    state = _prepare(graph, "CEG-xy", opts)
    if not state or not state.get("ok"):
        return state or gu.build_layout_error({"message": "CEG-xy failed"})

    lambda_x = CEG_CONFIG["xyLambda"]
    uniform_weights = _build_uniform_weights(state["augmentedPairs"], 1.0)
    base = _solve_augmented_weighted_layout(state, uniform_weights)
    if not base.get("ok"):
        return gu.build_layout_error({
            "message": base.get("message") or "CEG-xy baseline solve failed",
            "graph": state["prepared"]["graph"],
            "outerFace": state["augmentedOuterFace"],
            "augmented": state["augmented"],
        })
    x_spread = _build_spread_state(state, base["positions"], 0, "CEG-xy x-spread")
    if not x_spread.get("ok"):
        return x_spread
    y_spread = _build_spread_state(state, base["positions"], math.pi / 2, "CEG-xy y-spread")
    if not y_spread.get("ok"):
        return y_spread
    wxy = _combine_weights(state["augmentedPairs"], x_spread["weights"], y_spread["weights"], lambda_x)
    fixed_outer_pos = _build_fixed_outer_positions(state["augmentedOuterFace"], base["positions"])
    xy_solve = _solve_augmented_weighted_layout(state, wxy, {"fixedOuterPos": fixed_outer_pos})
    if not xy_solve.get("ok"):
        return gu.build_layout_error({
            "message": xy_solve.get("message") or "CEG-xy solve failed",
            "graph": state["prepared"]["graph"],
            "outerFace": state["augmentedOuterFace"],
            "augmented": state["augmented"],
        })
    dummy_count = state["augmented"].get("dummyCount") or 0
    total_iters = (base.get("iters") or 0) + (xy_solve.get("iters") or 0)
    msg = ("Applied CEG-xy ("
           f"{len(state['augmentedOuterFace'])}-vertex outer face, lambdaX={max(0, min(1, lambda_x))}, x/y spread morph"
           f"{(', +' + str(dummy_count) + ' dummy vertices') if dummy_count > 0 else ''}"
           f", {total_iters} total iters)")
    return _build_ceg_success_result(state, xy_solve["positions"], total_iters, msg)
