"""FaceBalancer layout. Port of static/js/layout-facebalancer.js.

L-BFGS minimization over softmax-weighted barycentric positions, balancing
triangulated face areas with barrier and uniformity terms.

Numpy-vectorized inner loops (see _balancer_common).
"""

from __future__ import annotations

import math

import numpy as np

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import preprocessing
from . import tutte as tutte_mod
from . import _balancer_common as bc

FACE_CONFIG = {
    "areaTol": 1e-15,
    "faceBarrierWeight": 0.2,
    "edgeBarrierWeight": 0.05,
    "edgeUniformWeight": 0.02,
    "minFaceAreaFactor": 0.25,
    "minEdgeLength2": 0,
    "maxIters": 80,
    "gradTol": 1e-5,
    "stepTol": 1e-6,
    "lbfgsMemory": 10,
    "lineSearchC1": 1e-4,
    "lineSearchTau": 0.5,
    "minItersBeforeStop": 40,
    "stableIterLimit": 8,
    "movementStopTol": 1e-6,
    "avgMovementStopTol": 2e-7,
}


def _polygon_area2_np(face_idx_array, x, y):
    """Signed 2A over face indices; face_idx_array is (F, k) with equal k."""
    n = face_idx_array.shape[1]
    total = np.zeros(face_idx_array.shape[0])
    for i in range(n):
        a = face_idx_array[:, i]
        b = face_idx_array[:, (i + 1) % n]
        total += x[a] * y[b] - x[b] * y[a]
    return total


def _build_face_balancer_data(input_):
    augmented_edge_pairs = input_["augmentedEdgePairs"]
    augmented_embedding = input_["augmentedEmbedding"]
    outer_face = input_["outerFace"]
    outer_pos = input_.get("outerPos") or {}
    aug_ids = [str(x) for x in augmented_embedding["idByIndex"]]
    aug_index_by_id = {aug_ids[i]: i for i in range(len(aug_ids))}

    nA = len(aug_ids)
    x0 = np.zeros(nA)
    y0 = np.zeros(nA)
    for i, nid in enumerate(aug_ids):
        p = outer_pos.get(nid)
        if p is not None:
            x0[i] = p[0]
            y0[i] = p[1]

    edges: list[tuple[int, int]] = []
    for (a_raw, b_raw) in augmented_edge_pairs:
        u = aug_index_by_id.get(str(a_raw))
        v = aug_index_by_id.get(str(b_raw))
        if u is None or v is None or u == v:
            continue
        edges.append((u, v))

    outer_key = gu.face_key(outer_face)
    bounded_faces: list[list[int]] = []
    for raw_face in augmented_embedding.get("faces") or []:
        mapped = [str(x) for x in (raw_face or [])]
        if gu.face_key(mapped) == outer_key:
            continue
        if not mapped or len(mapped) < 3:
            return gu.build_layout_error({"reason": "FaceBalancer requires a valid triangulated augmentation"})
        if len(mapped) != 3:
            return gu.build_layout_error({"reason": "FaceBalancer requires all non-outer augmented faces to be triangles"})
        bounded_faces.append([aug_index_by_id[x] for x in mapped])

    outer_mask = [False] * nA
    for f in outer_face:
        idx = aug_index_by_id.get(str(f))
        if idx is not None:
            outer_mask[idx] = True

    interior_aug_indices: list[int] = []
    interior_index_by_aug = [-1] * nA
    for i in range(nA):
        if not outer_mask[i]:
            interior_index_by_aug[i] = len(interior_aug_indices)
            interior_aug_indices.append(i)

    row_start = [0] * len(interior_aug_indices)
    row_length = [0] * len(interior_aug_indices)
    neighbor_aug_indices: list[list[int]] = [[] for _ in range(len(interior_aug_indices))]
    neighbor_interior_indices: list[list[int]] = [[] for _ in range(len(interior_aug_indices))]
    q_size = 0
    for i, aug_idx in enumerate(interior_aug_indices):
        rotation_row = augmented_embedding["rotation"][aug_idx] if aug_idx < len(augmented_embedding["rotation"]) else []
        neighbors = [aug_index_by_id[str(n)] for n in rotation_row]
        row_start[i] = q_size
        row_length[i] = len(neighbors)
        q_size += len(neighbors)
        neighbor_aug_indices[i] = neighbors
        neighbor_interior_indices[i] = [interior_index_by_aug[n] for n in neighbors]

    flat = bc.precompute_flat_indices(row_start, row_length, neighbor_aug_indices,
                                      neighbor_interior_indices, q_size)
    interior_aug_np = np.asarray(interior_aug_indices, dtype=np.int64)
    interior_index_by_aug_np = np.asarray(interior_index_by_aug, dtype=np.int64)
    tri_np = (np.asarray([f[0] for f in bounded_faces], dtype=np.int64),
              np.asarray([f[1] for f in bounded_faces], dtype=np.int64),
              np.asarray([f[2] for f in bounded_faces], dtype=np.int64)) if bounded_faces else (
                  np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64))
    edge_u_np = np.asarray([e[0] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)
    edge_v_np = np.asarray([e[1] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)

    return gu.build_layout_result({
        "augIds": aug_ids,
        "x0": x0,
        "y0": y0,
        "interiorAugIndices": interior_aug_indices,
        "interiorAugNp": interior_aug_np,
        "interiorVertexIds": [aug_ids[idx] for idx in interior_aug_indices],
        "interiorIndexByAug": interior_index_by_aug,
        "interiorIndexByAugNp": interior_index_by_aug_np,
        "rowStart": row_start,
        "rowLength": row_length,
        "neighborAugIndices": neighbor_aug_indices,
        "neighborInteriorIndices": neighbor_interior_indices,
        "flat": flat,
        "qSize": q_size,
        "boundedFaces": bounded_faces,
        "tri_a": tri_np[0],
        "tri_b": tri_np[1],
        "tri_c": tri_np[2],
        "edges": edges,
        "edgeU": edge_u_np,
        "edgeV": edge_v_np,
        "areaTol": max(0, input_.get("areaTol", 0)),
        "faceBarrierWeight": max(0, input_.get("faceBarrierWeight", 0)),
        "edgeBarrierWeight": max(0, input_.get("edgeBarrierWeight", 0)),
        "edgeUniformWeight": max(0, input_.get("edgeUniformWeight", 0)),
        "edgeBarrierScale2": 1,
        "initialMinFaceArea": 0,
        "minFaceArea": max(0, input_.get("minFaceArea", 0)),
        "minEdgeLength2": max(0, input_.get("minEdgeLength2", 0)),
    })


def _build_position_map(data, x, y):
    return {data["augIds"][i]: (float(x[i]), float(y[i])) for i in range(len(data["augIds"]))}


def _build_initial_logit_seed(data, weights):
    q0 = np.zeros(data["qSize"])
    for i, aug_idx in enumerate(data["interiorAugIndices"]):
        vertex_id = data["augIds"][aug_idx]
        row_offset = data["rowStart"][i]
        neighbors = data["neighborAugIndices"][i]
        if not neighbors:
            continue
        row_weights = [0.0] * len(neighbors)
        row_weight_sum = 0.0
        for k, n_aug in enumerate(neighbors):
            neighbor_id = data["augIds"][n_aug]
            rw = weights.get(gu.edge_key(vertex_id, neighbor_id))
            if not isinstance(rw, (int, float)) or not math.isfinite(rw) or not (rw > 0):
                return gu.build_layout_error({
                    "reason": "FaceBalancer initialization requires positive Tutte weights",
                    "vertexId": vertex_id,
                    "neighborId": neighbor_id,
                })
            row_weights[k] = rw
            row_weight_sum += rw
        if not (row_weight_sum > 0):
            return gu.build_layout_error({
                "reason": "FaceBalancer initialization requires positive Tutte row weight sum",
                "vertexId": vertex_id,
            })
        for k in range(len(neighbors)):
            q0[row_offset + k] = math.log(row_weights[k] / row_weight_sum)
    return gu.build_layout_result({"q0": q0})


def _realize_state(q, data):
    nI = len(data["interiorAugIndices"])
    ok, res = bc.realize_state_np(q, data["flat"], data["x0"], data["y0"],
                                  data["interiorAugNp"], nI)
    if not ok:
        return gu.build_layout_error({"reason": "FaceBalancer linear solve failed"})
    return gu.build_layout_result({"lambda": res["lambda"], "L": res["L"],
                                   "x": res["x"], "y": res["y"]})


def _initialize_baseline(data, q0):
    realized = _realize_state(q0, data)
    if not realized or not realized.get("ok"):
        return realized or gu.build_layout_error({"reason": "FaceBalancer initialization failed"})
    x = realized["x"]
    y = realized["y"]
    edge_scale2 = 1.0
    if data["edgeU"].size:
        dx = x[data["edgeU"]] - x[data["edgeV"]]
        dy = y[data["edgeU"]] - y[data["edgeV"]]
        len2 = dx * dx + dy * dy
        mask = len2 > 1e-12
        if mask.any():
            edge_scale2 = float(len2[mask].mean())
    data["edgeBarrierScale2"] = edge_scale2

    # Enforce CCW orientation on triangles (bug-for-bug: reverse in-place)
    if data["tri_a"].size:
        tri_stack = np.column_stack([data["tri_a"], data["tri_b"], data["tri_c"]])
        s2 = _polygon_area2_np(tri_stack, x, y)
        flip = s2 < 0
        if flip.any():
            # Reverse [a,b,c] -> [c,b,a], i.e. swap a and c
            a = data["tri_a"].copy()
            data["tri_a"] = np.where(flip, data["tri_c"], data["tri_a"])
            data["tri_c"] = np.where(flip, a, data["tri_c"])
            # Also reflect in bounded_faces for face-iteration helpers elsewhere
            for i, f in enumerate(flip):
                if f:
                    data["boundedFaces"][i].reverse()

        tri_stack = np.column_stack([data["tri_a"], data["tri_b"], data["tri_c"]])
        s2 = _polygon_area2_np(tri_stack, x, y)
        areas = np.abs(s2) / 2
        valid = areas > 1e-12
        if valid.any():
            data["initialMinFaceArea"] = float(areas[valid].min())
        else:
            data["initialMinFaceArea"] = 0
    else:
        data["initialMinFaceArea"] = 0
    return gu.build_layout_result({"q0": q0, "positions": _build_position_map(data, x, y)})


def _evaluate_objective(q, data):
    triangle_slack = max(data["areaTol"], 1e-12)
    nI = len(data["interiorAugIndices"])
    realized = _realize_state(q, data)
    if not realized or not realized.get("ok"):
        return realized or gu.build_layout_error({"reason": "FaceBalancer linear solve failed"})
    lam = realized["lambda"]
    L = realized["L"]
    x = realized["x"]
    y = realized["y"]

    tri_a = data["tri_a"]; tri_b = data["tri_b"]; tri_c = data["tri_c"]
    # Signed triangle areas
    raw_area = 0.5 * ((x[tri_b] - x[tri_a]) * (y[tri_c] - y[tri_a])
                      - (x[tri_c] - x[tri_a]) * (y[tri_b] - y[tri_a]))
    if tri_a.size and not np.all(raw_area > -triangle_slack):
        return gu.build_layout_error({"reason": "invalid-triangulation-step"})
    face_areas = np.where(raw_area > triangle_slack, raw_area, triangle_slack)
    if tri_a.size:
        if not np.all(face_areas > data["minFaceArea"]):
            return gu.build_layout_error({"reason": "invalid-face-step"})
        # "polygon_area2 > 2 * areaTol" — i.e. 2A > 2*tol. For triangles 2A = raw_area*2.
        tri_stack = np.column_stack([tri_a, tri_b, tri_c])
        s2 = _polygon_area2_np(tri_stack, x, y)
        if not np.all(s2 > 2 * data["areaTol"]):
            return gu.build_layout_error({"reason": "invalid-face-step"})
    total_area = float(face_areas.sum())
    if not (face_areas.size > 0) or not (total_area > 1e-12):
        return gu.build_layout_error({"reason": "FaceBalancer total bounded area is not positive"})

    target_area = total_area / face_areas.size
    residual = face_areas / target_area - 1
    bw = data["faceBarrierWeight"]
    ebw = data["edgeBarrierWeight"]
    euw = data["edgeUniformWeight"]
    E = float((residual * residual).sum())
    if bw > 0:
        E -= bw * float(np.log(face_areas / target_area).sum())
    max_rel = float(np.abs(residual).max()) if residual.size else 0.0

    zX = np.zeros(nI)
    zY = np.zeros(nI)
    coeff = 2 * residual / target_area
    if bw > 0:
        coeff = coeff - bw / face_areas
    bc.scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                                  data["interiorIndexByAugNp"])

    if ebw > 0 and data["edgeU"].size:
        edge_scale2 = data["edgeBarrierScale2"] if data["edgeBarrierScale2"] > 1e-12 else 1
        edge_tol2 = max(1e-24, data["areaTol"])
        dx = x[data["edgeU"]] - x[data["edgeV"]]
        dy = y[data["edgeU"]] - y[data["edgeV"]]
        len2 = dx * dx + dy * dy
        safe_len2 = np.where(len2 > edge_tol2, len2, edge_tol2)
        active = safe_len2 < edge_scale2
        if active.any():
            E -= ebw * float(np.log(safe_len2[active] / edge_scale2).sum())
            edge_coeff = np.where(active, -2 * ebw / safe_len2, 0.0)
            bc.scatter_edge_gradients(data["edgeU"], data["edgeV"], edge_coeff, dx, dy,
                                      zX, zY, data["interiorIndexByAugNp"])

    if euw > 0 and data["edgeU"].size > 1:
        uniform_tol2 = max(1e-24, data["areaTol"])
        dx = x[data["edgeU"]] - x[data["edgeV"]]
        dy = y[data["edgeU"]] - y[data["edgeV"]]
        len2 = dx * dx + dy * dy
        safe_len2 = np.where(len2 > uniform_tol2, len2, uniform_tol2)
        log_len2 = np.log(safe_len2)
        m_edges = data["edgeU"].size
        log_mean = float(log_len2.mean())
        centered = log_len2 - log_mean
        E += euw * float((centered * centered).sum()) / m_edges
        uniform_scale = 2 * euw / m_edges
        uniform_coeff = uniform_scale * centered / safe_len2
        bc.scatter_edge_gradients(data["edgeU"], data["edgeV"], uniform_coeff, dx, dy,
                                  zX, zY, data["interiorIndexByAugNp"])

    if data["minEdgeLength2"] > 0 and data["edgeU"].size:
        dx = x[data["edgeU"]] - x[data["edgeV"]]
        dy = y[data["edgeU"]] - y[data["edgeV"]]
        if not np.all(dx * dx + dy * dy > data["minEdgeLength2"]):
            return gu.build_layout_error({"reason": "invalid-edge-step"})

    adjoint = bc.adjoint_solve_np(L, zX, zY)
    if adjoint is None:
        return gu.build_layout_error({"reason": "FaceBalancer adjoint solve failed"})
    ax1, ax2 = adjoint
    grad_vec = bc.assemble_grad_vec(lam, data["flat"], ax1, ax2, x, y)
    grad_norm = float(np.linalg.norm(grad_vec))

    return gu.build_layout_result({
        "E": E,
        "gradVec": grad_vec,
        "gradNorm": grad_norm,
        "x": x,
        "y": y,
        "faceAreas": face_areas,
        "maxRelError": max_rel,
    })


def _run_optimization(q0, data, opts):
    max_iters = opts["maxIters"]
    grad_tol = opts["gradTol"]
    step_tol = opts["stepTol"]
    memory = opts["lbfgsMemory"]
    c1 = opts["lineSearchC1"]
    tau = opts["lineSearchTau"]
    q = q0.copy()
    current = _evaluate_objective(q, data)
    if not current.get("ok"):
        return current

    S: list = []
    Y: list = []
    Rho: list = []
    movement_tracker = opts.get("movementTracker")
    stop_reason = "max-iters"
    completed = 0

    for iter_ in range(1, max_iters + 1):
        if current["gradNorm"] <= grad_tol:
            stop_reason = "grad-converged"
            break
        prev_x = current["x"]
        prev_y = current["y"]
        d = bc.lbfgs_direction_np(current["gradVec"], S, Y, Rho)
        gtd = float(current["gradVec"] @ d)
        if not (gtd < 0):
            d = -current["gradVec"]
            gtd = float(current["gradVec"] @ d)
        alpha_step = 1.0
        accepted = None
        while alpha_step >= 1e-12:
            q_trial = q + alpha_step * d
            trial = _evaluate_objective(q_trial, data)
            if trial.get("ok") and trial["E"] <= current["E"] + c1 * alpha_step * gtd:
                accepted = (q_trial, trial)
                break
            alpha_step *= tau
        if accepted is None:
            stop_reason = "line-search-failed"
            break
        q_new, new_curr = accepted
        s = q_new - q
        yv = new_curr["gradVec"] - current["gradVec"]
        step_norm = float(np.linalg.norm(s))
        q = q_new
        current = new_curr
        completed = iter_

        if movement_tracker is not None:
            new_x = current["x"]; new_y = current["y"]
            def distance(aug_idx, _i):
                return math.hypot(new_x[aug_idx] - prev_x[aug_idx],
                                  new_y[aug_idx] - prev_y[aug_idx])
            move_stats = gu.compute_move_stats(data["interiorAugIndices"], distance, {"moveTol": 1e-9})
            movement_status = movement_tracker.update(move_stats, iter_)
            if movement_status.converged:
                stop_reason = movement_status.reason or "movement-converged"
                break
        if step_norm < step_tol:
            stop_reason = "step-converged"
            break

        ys = float(yv @ s)
        if ys > 1e-14:
            if len(S) == memory:
                S.pop(0); Y.pop(0); Rho.pop(0)
            S.append(s); Y.append(yv); Rho.append(1 / ys)

    return gu.build_layout_result({
        "q": q,
        "positions": _build_position_map(data, current["x"], current["y"]),
        "E": current["E"],
        "gradNorm": current["gradNorm"],
        "maxRelError": current["maxRelError"],
        "stopReason": stop_reason,
        "iters": completed,
    })


def _build_outer_positions(layout_input):
    full_pos = tutte_mod.place_outer_face_vertices(
        layout_input["augmented"]["graph"].node_ids,
        layout_input["augmentedOuterFace"],
        tutte_mod.default_outer_placement_options(),
    )
    out = {}
    for f in layout_input["augmentedOuterFace"]:
        fid = str(f)
        p = full_pos.get(fid)
        if p is not None and math.isfinite(p[0]) and math.isfinite(p[1]):
            out[fid] = (p[0], p[1])
    return out


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    layout_input = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "FaceBalancer layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": dict(opts["augmentationOptions"]) if isinstance(opts.get("augmentationOptions"), dict) else None,
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "FaceBalancer setup failed"})

    g = layout_input["graph"]
    outer_face = layout_input["augmentedOuterFace"]
    augmented = layout_input["augmented"]
    outer_pos = _build_outer_positions(layout_input)
    data = _build_face_balancer_data({
        "augmentedEdgePairs": augmented["graph"].edge_pairs,
        "augmentedEmbedding": augmented["embedding"],
        "outerFace": outer_face,
        "outerPos": outer_pos,
        "areaTol": FACE_CONFIG["areaTol"],
        "faceBarrierWeight": FACE_CONFIG["faceBarrierWeight"],
        "edgeBarrierWeight": FACE_CONFIG["edgeBarrierWeight"],
        "edgeUniformWeight": FACE_CONFIG["edgeUniformWeight"],
        "minFaceArea": 0,
        "minEdgeLength2": FACE_CONFIG["minEdgeLength2"],
    })
    if not data.get("ok"):
        return gu.build_layout_error({
            "message": data.get("reason") or "FaceBalancer setup failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })

    tutte_weights = tutte_mod.build_tutte_weights(g, augmented["graph"])
    q0_result = _build_initial_logit_seed(data, tutte_weights)
    if not q0_result.get("ok"):
        return gu.build_layout_error({
            "message": q0_result.get("reason") or "FaceBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    q0 = q0_result["q0"]
    baseline = _initialize_baseline(data, q0)
    if not baseline or not baseline.get("ok") or not baseline.get("positions"):
        return gu.build_layout_error({
            "message": (baseline or {}).get("reason") or "FaceBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    if not data["boundedFaces"]:
        static_positions = geo.filter_position_map(baseline["positions"], g.node_ids)
        return gu.build_layout_result({
            "nodeIds": g.node_ids,
            "edgePairs": g.edge_pairs,
            "outerFace": outer_face,
            "graph": g,
            "augmented": augmented,
            "positions": static_positions,
            "stopReason": "no-bounded-faces",
            "iters": 0,
            "objective": 0,
            "faceAreaScore": None,
            "boundedFaceCount": 0,
        })
    data["minFaceArea"] = max(0, FACE_CONFIG["minFaceAreaFactor"] * data["initialMinFaceArea"])
    movement_scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, baseline["positions"])
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": FACE_CONFIG["minItersBeforeStop"],
        "stableIterLimit": FACE_CONFIG["stableIterLimit"],
        "maxMoveTol": FACE_CONFIG["movementStopTol"] * movement_scale,
        "avgMoveTol": FACE_CONFIG["avgMovementStopTol"] * movement_scale,
    })
    result = _run_optimization(q0, data, {
        "maxIters": FACE_CONFIG["maxIters"],
        "gradTol": FACE_CONFIG["gradTol"],
        "stepTol": FACE_CONFIG["stepTol"],
        "lbfgsMemory": FACE_CONFIG["lbfgsMemory"],
        "lineSearchC1": FACE_CONFIG["lineSearchC1"],
        "lineSearchTau": FACE_CONFIG["lineSearchTau"],
        "movementTracker": movement_tracker,
    })
    if not result.get("ok"):
        return gu.build_layout_error({
            "message": result.get("reason") or "FaceBalancer optimization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    final_positions = geo.filter_position_map(result["positions"], g.node_ids)
    if geo.has_position_crossings(final_positions, g.edge_pairs):
        return gu.build_layout_error({
            "stopReason": result.get("stopReason"),
            "graph": g, "outerFace": outer_face, "augmented": augmented,
            "message": "FaceBalancer produced a non-plane drawing",
        })
    face_score = metric_mod.compute_uniform_face_area_score(g.node_ids, g.edge_pairs, final_positions, layout_input["baseEmbedding"])
    res = gu.build_layout_result({
        "nodeIds": g.node_ids,
        "edgePairs": g.edge_pairs,
        "outerFace": outer_face,
        "graph": g,
        "augmented": augmented,
        "positions": final_positions,
        "stopReason": result.get("stopReason"),
        "iters": result.get("iters"),
        "objective": result.get("E"),
        "faceAreaScore": face_score.get("quality") if face_score.get("ok") else None,
        "boundedFaceCount": len(data["boundedFaces"]),
    })
    obj = result.get("E")
    extra = [f"obj {obj:.3f}"] if isinstance(obj, (int, float)) and math.isfinite(obj) else None
    res["message"] = gu.build_layout_status_message("FaceBalancer", {
        "boundedFaceCount": res["boundedFaceCount"],
        "dummyCount": augmented.get("dummyCount"),
        "iters": res.get("iters"),
        "stopReason": res.get("stopReason"),
        "extraParts": extra,
    })
    return res
