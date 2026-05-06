"""EdgeBalancer layout. Port of static/js/layout-edgebalancer.js.

L-BFGS minimization of edge-length variance with soft-range, log-abs, and
face-barrier regularizers, over softmax-weighted barycentric positions.

Numpy-vectorized inner loops.
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

EDGE_CONFIG = {
    "areaTol": 1e-15,
    "augmentedEdgeWeight": 0.25,
    "faceBarrierWeight": 0.02,
    "rangeWeight": 0.05,
    "rangeBeta": 6,
    "logAbsWeight": 0.5,
    "logAbsEpsilon": 0.25,
    "minFaceAreaFactor": 0.2,
    "maxIters": 80,
    "gradTol": 1e-5,
    "stepTol": 1e-10,
    "lbfgsMemory": 10,
    "maxStepNorm": 2.0,
    "maxPositionStepRatio": 0.1,
    "lineSearchC1": 1e-4,
    "lineSearchTau": 0.5,
    "minItersBeforeStop": 40,
    "stableIterLimit": 8,
    "movementStopTol": 1e-6,
    "avgMovementStopTol": 2e-7,
}


def _polygon_area2_np(face_idx_array, x, y):
    n = face_idx_array.shape[1]
    total = np.zeros(face_idx_array.shape[0])
    for i in range(n):
        a = face_idx_array[:, i]
        b = face_idx_array[:, (i + 1) % n]
        total += x[a] * y[b] - x[b] * y[a]
    return total


def _build_data(input_):
    augmented_edge_pairs = input_["augmentedEdgePairs"]
    augmented_embedding = input_["augmentedEmbedding"]
    outer_face = input_["outerFace"]
    outer_pos = input_.get("outerPos") or {}
    objective_edge_pairs = input_["objectiveEdgePairs"]
    augmented_edge_weight = input_["augmentedEdgeWeight"]
    aug_ids = [str(x) for x in augmented_embedding["idByIndex"]]
    aug_index_by_id = {aug_ids[i]: i for i in range(len(aug_ids))}

    original_edge_set = {}
    for (a, b) in objective_edge_pairs:
        original_edge_set[gu.edge_key(a, b)] = True

    nA = len(aug_ids)
    x0 = np.zeros(nA)
    y0 = np.zeros(nA)
    for i, nid in enumerate(aug_ids):
        p = outer_pos.get(nid)
        if p is not None:
            x0[i] = p[0]
            y0[i] = p[1]

    edges = []
    for (a_raw, b_raw) in augmented_edge_pairs:
        sa = str(a_raw); sb = str(b_raw)
        u = aug_index_by_id.get(sa); v = aug_index_by_id.get(sb)
        if u is None or v is None or u == v:
            continue
        barrier = 1 if original_edge_set.get(gu.edge_key(sa, sb)) else augmented_edge_weight
        edges.append((u, v, barrier))

    objective_edges = []
    for (a_raw, b_raw) in objective_edge_pairs:
        u = aug_index_by_id.get(str(a_raw))
        v = aug_index_by_id.get(str(b_raw))
        if u is None or v is None or u == v:
            continue
        objective_edges.append((u, v))

    outer_key = gu.face_key(outer_face)
    bounded_faces = []
    for raw_face in augmented_embedding.get("faces") or []:
        mapped = [str(x) for x in (raw_face or [])]
        if gu.face_key(mapped) == outer_key:
            continue
        if not mapped or len(mapped) < 3:
            return gu.build_layout_error({"reason": "EdgeBalancer requires a valid triangulated augmentation"})
        if len(mapped) != 3:
            return gu.build_layout_error({"reason": "EdgeBalancer requires all non-outer augmented faces to be triangles"})
        bounded_faces.append([aug_index_by_id[x] for x in mapped])

    outer_mask = [False] * nA
    for f in outer_face:
        idx = aug_index_by_id.get(str(f))
        if idx is not None:
            outer_mask[idx] = True

    interior_aug_indices = []
    interior_index_by_aug = [-1] * nA
    for i in range(nA):
        if not outer_mask[i]:
            interior_index_by_aug[i] = len(interior_aug_indices)
            interior_aug_indices.append(i)

    row_start = [0] * len(interior_aug_indices)
    row_length = [0] * len(interior_aug_indices)
    neighbor_aug_indices = [[] for _ in range(len(interior_aug_indices))]
    neighbor_interior_indices = [[] for _ in range(len(interior_aug_indices))]
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
    tri_a = np.asarray([f[0] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_b = np.asarray([f[1] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_c = np.asarray([f[2] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)

    all_edges_u = np.asarray([e[0] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)
    all_edges_v = np.asarray([e[1] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)
    all_edges_w = np.asarray([e[2] for e in edges], dtype=np.float64) if edges else np.zeros(0)
    obj_u = np.asarray([e[0] for e in objective_edges], dtype=np.int64) if objective_edges else np.zeros(0, dtype=np.int64)
    obj_v = np.asarray([e[1] for e in objective_edges], dtype=np.int64) if objective_edges else np.zeros(0, dtype=np.int64)

    return gu.build_layout_result({
        "augIds": aug_ids,
        "x0": x0,
        "y0": y0,
        "interiorAugIndices": interior_aug_indices,
        "interiorAugNp": interior_aug_np,
        "interiorIndexByAug": interior_index_by_aug,
        "interiorIndexByAugNp": interior_index_by_aug_np,
        "rowStart": row_start,
        "rowLength": row_length,
        "neighborAugIndices": neighbor_aug_indices,
        "neighborInteriorIndices": neighbor_interior_indices,
        "flat": flat,
        "qSize": q_size,
        "boundedFaces": bounded_faces,
        "tri_a": tri_a, "tri_b": tri_b, "tri_c": tri_c,
        "edges": edges,
        "allEdgesU": all_edges_u, "allEdgesV": all_edges_v, "allEdgesW": all_edges_w,
        "objectiveEdges": objective_edges,
        "objEdgeU": obj_u, "objEdgeV": obj_v,
        "areaTol": max(0, input_["areaTol"]),
        "faceBarrierWeight": max(0, input_["faceBarrierWeight"]),
        "rangeWeight": max(0, input_["rangeWeight"]),
        "rangeBeta": input_["rangeBeta"],
        "logAbsWeight": max(0, input_["logAbsWeight"]),
        "logAbsEpsilon": max(0, input_["logAbsEpsilon"]),
        "edgeBarrierScale2": 1,
        "initialAvgFaceArea": 1,
        "initialMinFaceArea": 0,
        "minFaceArea": max(0, input_["minFaceArea"]),
    })


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
                    "reason": "EdgeBalancer initialization requires positive Tutte weights",
                    "vertexId": vertex_id, "neighborId": neighbor_id,
                })
            row_weights[k] = rw
            row_weight_sum += rw
        if not (row_weight_sum > 0):
            return gu.build_layout_error({
                "reason": "EdgeBalancer initialization requires positive Tutte row weight sum",
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
        return gu.build_layout_error({"reason": "EdgeBalancer linear solve failed"})
    return gu.build_layout_result({"lambda": res["lambda"], "L": res["L"],
                                   "x": res["x"], "y": res["y"]})


def _initialize_baseline(data, q0):
    realized = _realize_state(q0, data)
    if not realized.get("ok"):
        return realized
    x = realized["x"]; y = realized["y"]

    if data["allEdgesU"].size:
        dx = x[data["allEdgesU"]] - x[data["allEdgesV"]]
        dy = y[data["allEdgesU"]] - y[data["allEdgesV"]]
        len2 = dx * dx + dy * dy
        mask = len2 > 1e-12
        w = data["allEdgesW"]
        if mask.any():
            denom = float(w[mask].sum())
            if denom > 0:
                data["edgeBarrierScale2"] = float((w[mask] * len2[mask]).sum() / denom)
            else:
                data["edgeBarrierScale2"] = 1
        else:
            data["edgeBarrierScale2"] = 1
    else:
        data["edgeBarrierScale2"] = 1

    # Enforce CCW orientation
    if data["tri_a"].size:
        tri_stack = np.column_stack([data["tri_a"], data["tri_b"], data["tri_c"]])
        s2 = _polygon_area2_np(tri_stack, x, y)
        flip = s2 < 0
        if flip.any():
            a = data["tri_a"].copy()
            data["tri_a"] = np.where(flip, data["tri_c"], data["tri_a"])
            data["tri_c"] = np.where(flip, a, data["tri_c"])
            for i, f in enumerate(flip):
                if f:
                    data["boundedFaces"][i].reverse()
        tri_stack = np.column_stack([data["tri_a"], data["tri_b"], data["tri_c"]])
        s2 = _polygon_area2_np(tri_stack, x, y)
        areas = np.abs(s2) / 2
        valid = areas > 1e-12
        if valid.any():
            data["initialAvgFaceArea"] = float(areas[valid].mean())
            data["initialMinFaceArea"] = float(areas[valid].min())
        else:
            data["initialAvgFaceArea"] = 1
            data["initialMinFaceArea"] = 0
    else:
        data["initialAvgFaceArea"] = 1
        data["initialMinFaceArea"] = 0

    pos = {data["augIds"][i]: (float(x[i]), float(y[i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({"positions": pos})


def _summarize_objective_edges(data, x, y, edge_tol2, log_len2, log_mean):
    obj_u = data["objEdgeU"]; obj_v = data["objEdgeV"]
    dx = x[obj_u] - x[obj_v]
    dy = y[obj_u] - y[obj_v]
    len2 = dx * dx + dy * dy
    valid = len2 > edge_tol2
    length_all = np.sqrt(np.where(valid, len2, 1.0))
    if not valid.any():
        return {"minLength": None, "maxLength": None, "meanLength": None,
                "ratio": None, "maxLogDeviation": 0.0, "worstEdge": None}
    lengths = length_all[valid]
    min_length = float(lengths.min())
    max_length = float(lengths.max())
    mean_length = float(lengths.mean())
    centered = log_len2 - log_mean
    dev = np.abs(centered)
    worst_idx = int(np.argmax(dev))
    worst_edge = {
        "u": data["augIds"][int(obj_u[worst_idx])],
        "v": data["augIds"][int(obj_v[worst_idx])],
        "length": float(length_all[worst_idx]),
        "logDeviation": float(centered[worst_idx]),
    }
    return {
        "minLength": min_length,
        "maxLength": max_length if max_length > 0 else None,
        "meanLength": mean_length,
        "ratio": (min_length / max_length) if max_length > 0 else None,
        "maxLogDeviation": float(dev.max()),
        "worstEdge": worst_edge,
    }


def _evaluate_objective_edge_terms(data, x, y, edge_tol2, zX, zY):
    obj_u = data["objEdgeU"]; obj_v = data["objEdgeV"]
    m = obj_u.size
    dx = x[obj_u] - x[obj_v]
    dy = y[obj_u] - y[obj_v]
    len2 = dx * dx + dy * dy
    if not np.all(len2 > edge_tol2):
        return gu.build_layout_error({"reason": "invalid-edge-step"})
    log_len2 = np.log(len2)
    log_mean = float(log_len2.mean())
    centered = log_len2 - log_mean
    edge_variance_term = float((centered * centered).sum()) / m

    log_abs_epsilon = data["logAbsEpsilon"] if data["logAbsEpsilon"] > 0 else 0.25
    smooth = np.sqrt(centered * centered + log_abs_epsilon * log_abs_epsilon)
    edge_smooth_log_abs_term = float(((smooth - log_abs_epsilon) / m).sum())
    log_abs_grad = centered / smooth
    log_abs_grad_mean = float(log_abs_grad.mean())

    range_beta = data["rangeBeta"] if data["rangeBeta"] > 0 else 6
    scaled = range_beta * log_len2
    neg_scaled = -scaled
    max_scaled = float(scaled.max())
    max_neg_scaled = float(neg_scaled.max())
    pw = np.exp(scaled - max_scaled)
    nw = np.exp(neg_scaled - max_neg_scaled)
    pos_sum = float(pw.sum())
    neg_sum = float(nw.sum())
    edge_soft_range_term = (math.log(pos_sum) + max_scaled) / range_beta - (math.log(neg_sum) + max_neg_scaled) / range_beta
    pw = pw / pos_sum
    nw = nw / neg_sum

    stats = _summarize_objective_edges(data, x, y, edge_tol2, log_len2, log_mean)

    edge_objective_term = (edge_variance_term
                           + data["rangeWeight"] * edge_soft_range_term
                           + data["logAbsWeight"] * edge_smooth_log_abs_term)

    variance_coeff = (4.0 / m) * centered / len2
    extra_range = data["rangeWeight"] * (2.0 / len2) * (pw - nw)
    extra_log_abs = data["logAbsWeight"] * (2.0 / (m * len2)) * (log_abs_grad - log_abs_grad_mean)
    total_coeff = variance_coeff + extra_range + extra_log_abs
    bc.scatter_edge_gradients(obj_u, obj_v, total_coeff, dx, dy, zX, zY,
                              data["interiorIndexByAugNp"])

    return gu.build_layout_result({
        "edgeObjectiveTerm": edge_objective_term,
        "edgeStats": stats,
        "maxLogDeviation": stats["maxLogDeviation"],
    })


def _evaluate_objective(q, data):
    triangle_slack = max(data["areaTol"], 1e-12)
    nI = len(data["interiorAugIndices"])
    realized = _realize_state(q, data)
    if not realized.get("ok"):
        return realized
    lam = realized["lambda"]; L = realized["L"]
    x = realized["x"]; y = realized["y"]
    tri_a = data["tri_a"]; tri_b = data["tri_b"]; tri_c = data["tri_c"]

    raw_area = 0.5 * ((x[tri_b] - x[tri_a]) * (y[tri_c] - y[tri_a])
                      - (x[tri_c] - x[tri_a]) * (y[tri_b] - y[tri_a]))
    if tri_a.size and not np.all(raw_area > -triangle_slack):
        return gu.build_layout_error({"reason": "invalid-triangulation-step"})
    face_areas = np.where(raw_area > triangle_slack, raw_area, triangle_slack)
    if tri_a.size:
        if not np.all(face_areas > data["minFaceArea"]):
            return gu.build_layout_error({"reason": "invalid-face-step"})
        tri_stack = np.column_stack([tri_a, tri_b, tri_c])
        s2 = _polygon_area2_np(tri_stack, x, y)
        if not np.all(s2 > 2 * data["areaTol"]):
            return gu.build_layout_error({"reason": "invalid-face-step"})

    if not (data["objEdgeU"].size > 0):
        return gu.build_layout_error({"reason": "EdgeBalancer requires at least one valid objective edge"})

    zX = np.zeros(nI); zY = np.zeros(nI)
    edge_tol2 = max(1e-24, data["areaTol"])
    objective_eval = _evaluate_objective_edge_terms(data, x, y, edge_tol2, zX, zY)
    if not objective_eval.get("ok"):
        return objective_eval
    edge_stats = objective_eval["edgeStats"]
    max_log_deviation = objective_eval["maxLogDeviation"]
    E = objective_eval["edgeObjectiveTerm"]

    if data["faceBarrierWeight"] > 0 and tri_a.size:
        E -= data["faceBarrierWeight"] * float(np.log(face_areas / data["initialAvgFaceArea"]).sum())
        coeff = -data["faceBarrierWeight"] / face_areas
        bc.scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                                      data["interiorIndexByAugNp"])

    adjoint = bc.adjoint_solve_np(L, zX, zY)
    if adjoint is None:
        return gu.build_layout_error({"reason": "EdgeBalancer adjoint solve failed"})
    ax1, ax2 = adjoint
    grad_vec = bc.assemble_grad_vec(lam, data["flat"], ax1, ax2, x, y)
    grad_norm = float(np.linalg.norm(grad_vec))

    return gu.build_layout_result({
        "E": E,
        "gradVec": grad_vec,
        "gradNorm": grad_norm,
        "x": x,
        "y": y,
        "maxLogDeviation": max_log_deviation,
        "edgeStats": edge_stats,
    })


def _compute_interior_move_stats(data, prev_x, prev_y, next_x, next_y):
    def dist(idx, _i):
        return math.hypot(next_x[idx] - prev_x[idx], next_y[idx] - prev_y[idx])
    return gu.compute_move_stats(data["interiorAugIndices"], dist, {"moveTol": 1e-9})


def _run_optimization(q0, data, opts):
    max_iters = opts["maxIters"]
    grad_tol = opts["gradTol"]
    step_tol = opts["stepTol"]
    memory = opts["lbfgsMemory"]
    max_step_norm = opts["maxStepNorm"]
    max_position_step = opts["maxPositionStep"]
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
        prev_x = current["x"]; prev_y = current["y"]
        d = bc.lbfgs_direction_np(current["gradVec"], S, Y, Rho)
        gtd = float(current["gradVec"] @ d)
        if not (gtd < 0):
            d = -current["gradVec"]
            gtd = float(current["gradVec"] @ d)
        dn = float(np.linalg.norm(d))
        if dn > max_step_norm:
            d = d * (max_step_norm / dn)
            gtd = float(current["gradVec"] @ d)

        accepted = None
        for ls_attempt in range(2):
            if accepted is not None:
                break
            search_dir = d
            search_gtd = gtd
            if ls_attempt == 1:
                search_dir = -current["gradVec"]
                dn2 = float(np.linalg.norm(search_dir))
                if dn2 > max_step_norm:
                    search_dir = search_dir * (max_step_norm / dn2)
                search_gtd = float(current["gradVec"] @ search_dir)
                if not (search_gtd < 0):
                    break
                if S:
                    S = []; Y = []; Rho = []
            alpha = 1.0
            while alpha >= 1e-12:
                q_trial = q + alpha * search_dir
                trial = _evaluate_objective(q_trial, data)
                if trial.get("ok"):
                    trial_move = _compute_interior_move_stats(data, current["x"], current["y"], trial["x"], trial["y"])
                    if trial_move.max_move > max_position_step:
                        alpha *= tau
                        continue
                if trial.get("ok") and trial["E"] <= current["E"] + c1 * alpha * search_gtd:
                    accepted = (q_trial, trial)
                    break
                alpha *= tau
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
            move_stats = _compute_interior_move_stats(data, prev_x, prev_y, current["x"], current["y"])
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

    pos = {data["augIds"][i]: (float(current["x"][i]), float(current["y"][i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({
        "positions": pos,
        "E": current["E"],
        "maxLogDeviation": current.get("maxLogDeviation"),
        "edgeStats": current.get("edgeStats"),
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
        "failureLabel": "EdgeBalancer layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": dict(opts["augmentationOptions"]) if isinstance(opts.get("augmentationOptions"), dict) else None,
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "EdgeBalancer setup failed"})

    g = layout_input["graph"]
    outer_face = layout_input["augmentedOuterFace"]
    augmented = layout_input["augmented"]
    outer_pos = _build_outer_positions(layout_input)
    data = _build_data({
        "augmentedEdgePairs": augmented["graph"].edge_pairs,
        "augmentedEmbedding": augmented["embedding"],
        "objectiveEdgePairs": g.edge_pairs,
        "outerFace": outer_face,
        "outerPos": outer_pos,
        "areaTol": EDGE_CONFIG["areaTol"],
        "augmentedEdgeWeight": EDGE_CONFIG["augmentedEdgeWeight"],
        "faceBarrierWeight": EDGE_CONFIG["faceBarrierWeight"],
        "rangeWeight": EDGE_CONFIG["rangeWeight"],
        "rangeBeta": EDGE_CONFIG["rangeBeta"],
        "logAbsWeight": EDGE_CONFIG["logAbsWeight"],
        "logAbsEpsilon": EDGE_CONFIG["logAbsEpsilon"],
        "minFaceArea": 0,
    })
    if not data.get("ok"):
        return gu.build_layout_error({
            "message": data.get("reason") or "EdgeBalancer setup failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    tutte_weights = tutte_mod.build_tutte_weights(g, augmented["graph"])
    q0_result = _build_initial_logit_seed(data, tutte_weights)
    if not q0_result.get("ok"):
        return gu.build_layout_error({
            "message": q0_result.get("reason") or "EdgeBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    q0 = q0_result["q0"]
    baseline = _initialize_baseline(data, q0)
    if not baseline.get("ok") or not baseline.get("positions"):
        return gu.build_layout_error({
            "message": baseline.get("reason") or "EdgeBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    data["minFaceArea"] = max(0, EDGE_CONFIG["minFaceAreaFactor"] * data["initialMinFaceArea"])
    movement_scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, baseline["positions"])
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": EDGE_CONFIG["minItersBeforeStop"],
        "stableIterLimit": EDGE_CONFIG["stableIterLimit"],
        "maxMoveTol": EDGE_CONFIG["movementStopTol"] * movement_scale,
        "avgMoveTol": EDGE_CONFIG["avgMovementStopTol"] * movement_scale,
    })
    result = _run_optimization(q0, data, {
        "maxIters": EDGE_CONFIG["maxIters"],
        "gradTol": EDGE_CONFIG["gradTol"],
        "stepTol": EDGE_CONFIG["stepTol"],
        "lbfgsMemory": EDGE_CONFIG["lbfgsMemory"],
        "maxStepNorm": EDGE_CONFIG["maxStepNorm"],
        "maxPositionStep": EDGE_CONFIG["maxPositionStepRatio"] * movement_scale,
        "lineSearchC1": EDGE_CONFIG["lineSearchC1"],
        "lineSearchTau": EDGE_CONFIG["lineSearchTau"],
        "movementTracker": movement_tracker,
    })
    if not result.get("ok"):
        return gu.build_layout_error({
            "message": result.get("reason") or "EdgeBalancer optimization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    final_positions = geo.filter_position_map(result["positions"], g.node_ids)
    if geo.has_position_crossings(final_positions, g.edge_pairs):
        return gu.build_layout_error({
            "stopReason": result.get("stopReason"),
            "graph": g, "outerFace": outer_face, "augmented": augmented,
            "message": "EdgeBalancer produced a non-plane drawing",
        })
    edge_deviation = metric_mod.compute_edge_length_deviation_score(g.edge_pairs, final_positions)
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
        "maxLogDeviation": result.get("maxLogDeviation"),
        "edgeLengthDeviation": edge_deviation.get("score") if edge_deviation.get("ok") else None,
    })
    obj = result.get("E")
    dev = res.get("edgeLengthDeviation")
    extra_parts = []
    if isinstance(dev, (int, float)) and math.isfinite(dev):
        extra_parts.append(f"edge deviation {dev:.3f}")
    if isinstance(obj, (int, float)) and math.isfinite(obj):
        extra_parts.append(f"obj {obj:.3f}")
    res["message"] = gu.build_layout_status_message("EdgeBalancer", {
        "dummyCount": augmented.get("dummyCount"),
        "iters": res.get("iters"),
        "stopReason": res.get("stopReason"),
        "extraParts": extra_parts or None,
    })
    return res
