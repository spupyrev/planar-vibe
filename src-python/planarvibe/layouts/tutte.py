"""Tutte barycentric layout. Literal port of static/js/layout-tutte.js.

Entry point: `apply_layout(graph, initial_positions=None, options=None)`.
Mirrors the JS PlanarVibeTutte.applyLayout but without the Cytoscape runtime;
preprocessing chain is driven directly via `preprocessing.prepare_graph_data`.
"""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import linear_algebra as la
from .. import preprocessing


def build_tutte_weights(graph, augmented_graph) -> dict[str, float]:
    original_pairs = graph.edge_pairs
    augmented_pairs = augmented_graph.edge_pairs
    adjacency = augmented_graph.adjacency
    degree_by_id: dict[str, int] = {}
    original_edge_set: dict[str, bool] = {}
    outer_dummy_ids = getattr(augmented_graph, "_outer_dummy_ids", None) or []
    outer_dummy_set = {str(x) for x in outer_dummy_ids}
    weights: dict[str, float] = {}

    for (u, v) in original_pairs:
        original_edge_set[gu.edge_key(u, v)] = True

    use_adjacency = adjacency is not None and len(adjacency) > 0
    if not use_adjacency:
        for (u, v) in augmented_pairs:
            degree_by_id[u] = degree_by_id.get(u, 0) + 1
            degree_by_id[v] = degree_by_id.get(v, 0) + 1

    for (u, v) in augmented_pairs:
        key = gu.edge_key(u, v)
        touches_outer_dummy = str(u) in outer_dummy_set or str(v) in outer_dummy_set
        base_weight = 10.0 if (key not in original_edge_set and touches_outer_dummy) else 1.0
        if use_adjacency:
            du = max(1, len(adjacency.get(u, [])))
            dv = max(1, len(adjacency.get(v, [])))
        else:
            du = max(1, degree_by_id.get(u, 0))
            dv = max(1, degree_by_id.get(v, 0))
        base_weight /= math.sqrt(du * dv)
        weights[key] = base_weight
    return weights


def default_outer_placement_options(overrides: dict | None = None) -> dict:
    base = {
        "defaultCenterX": 450,
        "defaultCenterY": 310,
        "defaultRadius": 300,
        "outerRotation": None,
    }
    if overrides:
        base.update(overrides)
    return base


def place_outer_face_vertices(node_ids: Sequence[str], outer_face: Sequence[str], options: dict | None = None) -> dict:
    ids = [str(x) for x in (node_ids or [])]
    face = gu.normalize_outer_face(outer_face)
    opts = default_outer_placement_options(options)
    pos: dict[str, tuple[float, float]] = {nid: (0.0, 0.0) for nid in ids}

    cx = opts["defaultCenterX"]
    cy = opts["defaultCenterY"]
    R = opts["defaultRadius"]

    if not face:
        return pos

    gamma = 2 * math.pi / len(face)
    if opts.get("outerRotation") is not None and math.isfinite(float(opts["outerRotation"])):
        start_angle = float(opts["outerRotation"])
    else:
        start_angle = math.pi / 2 - gamma / 2

    for i, v in enumerate(face):
        v = str(v)
        angle = start_angle + gamma * i
        pos[v] = (cx + R * math.cos(angle), cy + R * math.sin(angle))

    fixed = opts.get("fixedOuterPos")
    if isinstance(fixed, dict):
        for v in face:
            fp = fixed.get(str(v))
            if fp is not None and geo._is_finite(fp[0]) and geo._is_finite(fp[1]):
                pos[str(v)] = (fp[0], fp[1])

    return pos


def _barycentric_error(message: str, graph, face) -> dict:
    return gu.build_layout_error({
        "message": message,
        "graph": graph,
        "outerFace": face,
    })


def compute_barycentric_positions(graph, outer_face: Sequence[str], options: dict) -> dict:
    ids = graph.node_ids
    face = gu.normalize_outer_face(outer_face)
    adjacency = options.get("adjacency") or graph.adjacency
    weights = options.get("weights")
    init_options = options.get("initOptions") or default_outer_placement_options()
    pos = place_outer_face_vertices(ids, face, init_options)
    outer_set = set(face)
    interior_ids: list[str] = []
    interior_index_by_id: dict[str, int] = {}

    if len(ids) < 1:
        return _barycentric_error("No vertices", graph, face)
    if len(face) < 3:
        return _barycentric_error("Outer face is invalid", graph, face)
    if not isinstance(weights, dict):
        return _barycentric_error("Barycentric weights are required", graph, face)

    for nid in ids:
        if nid not in outer_set:
            interior_index_by_id[nid] = len(interior_ids)
            interior_ids.append(nid)
    if not interior_ids:
        return gu.build_layout_result({
            "graph": graph,
            "outerFace": face,
            "positions": pos,
            "iters": 1,
        })

    n = len(interior_ids)
    L = [[0.0] * n for _ in range(n)]
    bx = [0.0] * n
    by = [0.0] * n
    for i, v in enumerate(interior_ids):
        L[i][i] = 1.0
        neighbors = adjacency.get(v, [])
        raw_weights: list[float] = [0.0] * len(neighbors)
        weight_sum = 0.0
        for j, u_raw in enumerate(neighbors):
            u = str(u_raw)
            w = weights.get(gu.edge_key(v, u))
            if not isinstance(w, (int, float)) or not math.isfinite(w) or w <= 0:
                w = 1.0
            raw_weights[j] = w
            weight_sum += w
        if not (weight_sum > 0):
            continue
        for j, u_raw in enumerate(neighbors):
            u = str(u_raw)
            w = raw_weights[j] / weight_sum
            interior_idx = interior_index_by_id.get(u)
            if interior_idx is None:
                bx[i] += w * pos[u][0]
                by[i] += w * pos[u][1]
            else:
                L[i][interior_idx] -= w

    factor = la.lu_factorize(L)
    solved = la.solve_lu_with_two_rhs(factor, bx, by) if factor else None
    if solved is None:
        return _barycentric_error("Exact barycentric solve failed", graph, face)
    x1, x2 = solved
    for i, nid in enumerate(interior_ids):
        pos[nid] = (x1[i], x2[i])

    return gu.build_layout_result({
        "graph": graph,
        "outerFace": face,
        "positions": pos,
        "iters": 1,
    })


def _compute_tutte_layout_with_prepared(prepared: dict) -> dict:
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": "Tutte failed"})

    graph = prepared["graph"]
    ids = graph.node_ids
    pairs = graph.edge_pairs

    augmented_graph = prepared["augmented"]["graph"]
    augmented_outer = prepared["augmentedOuterFace"]
    barycentric = compute_barycentric_positions(
        augmented_graph,
        augmented_outer,
        {
            "initOptions": default_outer_placement_options(),
            "weights": build_tutte_weights(prepared["graph"], augmented_graph),
        },
    )
    if not barycentric or not barycentric.get("ok") or not barycentric.get("positions"):
        return gu.build_layout_error(barycentric or {"message": "Tutte failed"})

    projected = geo.filter_position_map(barycentric["positions"], ids)
    has_crossings = geo.has_position_crossings(projected, pairs)
    if has_crossings:
        return gu.build_layout_error({
            "message": "Tutte produced a non-plane drawing",
            "graph": prepared["graph"],
            "outerFace": prepared["outerFace"],
            "augmented": prepared["augmented"],
        })

    return gu.build_layout_result({
        "nodeIds": ids,
        "edgePairs": pairs,
        "outerFace": prepared["outerFace"],
        "embedding": prepared["baseEmbedding"],
        "augmented": prepared["augmented"],
        "graph": prepared["graph"],
        "debugPositions": barycentric["positions"],
        "positions": projected,
        "iters": barycentric.get("iters"),
    })


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    prepared = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "Tutte layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": opts.get("augmentationOptions"),
        "currentPositions": initial_positions or {},
    })
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": "Tutte failed"})
    result = _compute_tutte_layout_with_prepared(prepared)
    if result.get("ok"):
        outer = result.get("outerFace") or []
        result["message"] = gu.build_layout_status_message("Tutte", {
            "outerFaceVertexCount": len(outer),
            "iters": result.get("iters"),
        })
    return result
