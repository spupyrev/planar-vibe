"""AngleBalancer layout. Port of static/js/layout-anglebalancer.js.

L-BFGS minimization of per-vertex angular-resolution residuals with a smooth
min-ratio penalty and face-barrier term. Numpy-vectorized inner loops.
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

TWO_PI = 2 * math.pi
ANGLE_CONFIG = {
    "areaTol": 1e-15,
    "wedgeTol": 1e-8,
    "angleBarrierWeight": 0.5,
    "minRatioWeight": 0.25,
    "minRatioBeta": 10,
    "faceBarrierWeight": 0.02,
    "minFaceAreaFactor": 0.2,
    "gradTol": 1e-5,
    "stepTol": 1e-10,
    "lbfgsMemory": 10,
    "maxStepNorm": 2.0,
    "lineSearchC1": 1e-4,
    "lineSearchTau": 0.5,
    "maxIters": 200,
    "minItersBeforeStop": 40,
    "stableIterLimit": 8,
    "movementStopTol": 1e-6,
    "avgMovementStopTol": 2e-7,
    "maxPositionStepRatio": 0.01,
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
    objective_graph = input_["objectiveGraph"]
    base_embedding = input_["baseEmbedding"]
    aug_ids = [str(x) for x in augmented_embedding["idByIndex"]]
    aug_index_by_id = {aug_ids[i]: i for i in range(len(aug_ids))}

    nA = len(aug_ids)
    x0 = np.zeros(nA)
    y0 = np.zeros(nA)
    for i, nid in enumerate(aug_ids):
        p = outer_pos.get(nid)
        if p is not None:
            x0[i] = p[0]; y0[i] = p[1]

    edges = []
    outer_key = gu.face_key(outer_face)
    bounded_faces = []
    for (a_raw, b_raw) in augmented_edge_pairs:
        u = aug_index_by_id.get(str(a_raw)); v = aug_index_by_id.get(str(b_raw))
        if u is None or v is None or u == v: continue
        edges.append((u, v))
    for raw_face in augmented_embedding.get("faces") or []:
        mapped = [str(x) for x in (raw_face or [])]
        if gu.face_key(mapped) == outer_key: continue
        if not mapped or len(mapped) < 3:
            return gu.build_layout_error({"reason": "AngleBalancer requires a valid triangulated augmentation"})
        if len(mapped) != 3:
            return gu.build_layout_error({"reason": "AngleBalancer requires all non-outer augmented faces to be triangles"})
        bounded_faces.append([aug_index_by_id[x] for x in mapped])

    outer_mask = [False] * nA
    for f in outer_face:
        idx = aug_index_by_id.get(str(f))
        if idx is not None: outer_mask[idx] = True

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
    base_ids = [str(x) for x in (base_embedding.get("idByIndex") or [])]
    base_index_by_id = {base_ids[i]: i for i in range(len(base_ids))}
    interior_aug_np = np.asarray(interior_aug_indices, dtype=np.int64)
    interior_index_by_aug_np = np.asarray(interior_index_by_aug, dtype=np.int64)
    tri_a = np.asarray([f[0] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_b = np.asarray([f[1] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_c = np.asarray([f[2] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)

    return gu.build_layout_result({
        "augIds": aug_ids,
        "augIndexById": aug_index_by_id,
        "x0": x0, "y0": y0,
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
        "areaTol": input_["areaTol"],
        "angleTol": input_["angleTol"],
        "angleBarrierWeight": max(0, input_["angleBarrierWeight"]),
        "minRatioWeight": max(0, input_["minRatioWeight"]),
        "minRatioBeta": input_["minRatioBeta"],
        "faceBarrierWeight": max(0, input_["faceBarrierWeight"]),
        "edgeBarrierScale2": 1,
        "initialAvgFaceArea": 1,
        "initialMinFaceArea": 0,
        "minFaceArea": max(0, input_["minFaceArea"]),
        "objectiveGraph": objective_graph,
        "baseEmbedding": base_embedding,
        "baseIds": base_ids,
        "baseIndexById": base_index_by_id,
        "objectiveVertexIds": [],
        "wedgeStart": [],
        "wedgeCount": [],
        "wedges": [],
        # Vectorized wedge arrays (filled in _initialize_baseline)
        "wedgeCenter": np.zeros(0, dtype=np.int64),
        "wedgeLeft": np.zeros(0, dtype=np.int64),
        "wedgeRight": np.zeros(0, dtype=np.int64),
        "wedgeTarget": np.zeros(0),
        "wedgeVertexIdx": np.zeros(0, dtype=np.int64),
        "wedgeVertexIsStart": np.zeros(0, dtype=bool),
    })


def _build_initial_logit_seed(data, weights):
    q0 = np.zeros(data["qSize"])
    for i, aug_idx in enumerate(data["interiorAugIndices"]):
        vertex_id = data["augIds"][aug_idx]
        row_offset = data["rowStart"][i]
        neighbors = data["neighborAugIndices"][i]
        if not neighbors: continue
        row_weights = [0.0] * len(neighbors)
        row_weight_sum = 0.0
        for k, n_aug in enumerate(neighbors):
            neighbor_id = data["augIds"][n_aug]
            rw = weights.get(gu.edge_key(vertex_id, neighbor_id))
            if not isinstance(rw, (int, float)) or not math.isfinite(rw) or not (rw > 0):
                return gu.build_layout_error({
                    "reason": "AngleBalancer initialization requires positive Tutte weights",
                    "vertexId": vertex_id, "neighborId": neighbor_id,
                })
            row_weights[k] = rw
            row_weight_sum += rw
        if not (row_weight_sum > 0):
            return gu.build_layout_error({
                "reason": "AngleBalancer initialization requires positive Tutte row weight sum",
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
        return gu.build_layout_error({"reason": "AngleBalancer linear solve failed"})
    return gu.build_layout_result({"lambda": res["lambda"], "L": res["L"],
                                   "x": res["x"], "y": res["y"]})


def _initialize_baseline(data, q0):
    realized = _realize_state(q0, data)
    if not realized.get("ok"):
        return realized
    x = realized["x"]; y = realized["y"]

    # edge-scale computation (scalar; only once)
    edge_scale_sum = 0.0
    edge_scale_count = 0
    for (u, v) in data["edges"]:
        dx = x[u] - x[v]; dy = y[u] - y[v]
        len2 = dx * dx + dy * dy
        if len2 > 1e-12:
            edge_scale_sum += len2
            edge_scale_count += 1
    data["edgeBarrierScale2"] = (edge_scale_sum / edge_scale_count) if edge_scale_count > 0 else 1

    # orient triangles
    if data["tri_a"].size:
        tri_stack = np.column_stack([data["tri_a"], data["tri_b"], data["tri_c"]])
        s2 = _polygon_area2_np(tri_stack, x, y)
        flip = s2 < 0
        if flip.any():
            a = data["tri_a"].copy()
            data["tri_a"] = np.where(flip, data["tri_c"], data["tri_a"])
            data["tri_c"] = np.where(flip, a, data["tri_c"])
            for i, f in enumerate(flip):
                if f: data["boundedFaces"][i].reverse()
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

    # wedges
    objective_vertex_ids = []
    wedge_start = []
    wedge_count = []
    wedges = []
    wedge_vertex_is_start = []
    base_rot = data["baseEmbedding"].get("rotation") or []
    for center_raw in data["objectiveGraph"].node_ids:
        center_id = str(center_raw)
        center_base_idx = data["baseIndexById"].get(center_id)
        center_aug_idx = data["augIndexById"].get(center_id)
        if center_base_idx is None or center_aug_idx is None:
            continue
        objective_rotation = base_rot[center_base_idx] if center_base_idx < len(base_rot) else []
        if len(objective_rotation) < 2:
            continue
        objective_neighbors = []
        for n in objective_rotation:
            n_aug = data["augIndexById"].get(str(n))
            if n_aug is not None:
                objective_neighbors.append(n_aug)
        if len(objective_neighbors) < 2:
            continue
        target_angle = TWO_PI / len(objective_neighbors)
        wedge_start.append(len(wedges))
        wedge_count.append(len(objective_neighbors))
        objective_vertex_ids.append(center_id)
        for k in range(len(objective_neighbors)):
            left_aug = objective_neighbors[k]
            right_aug = objective_neighbors[(k + 1) % len(objective_neighbors)]
            wedges.append((center_aug_idx, left_aug, right_aug, target_angle, len(objective_vertex_ids) - 1))
            wedge_vertex_is_start.append(k == 0)

    data["objectiveVertexIds"] = objective_vertex_ids
    data["wedgeStart"] = wedge_start
    data["wedgeCount"] = wedge_count
    data["wedges"] = wedges
    if wedges:
        data["wedgeCenter"] = np.asarray([w[0] for w in wedges], dtype=np.int64)
        data["wedgeLeft"] = np.asarray([w[1] for w in wedges], dtype=np.int64)
        data["wedgeRight"] = np.asarray([w[2] for w in wedges], dtype=np.int64)
        data["wedgeTarget"] = np.asarray([w[3] for w in wedges])
        data["wedgeVertexIdx"] = np.asarray([w[4] for w in wedges], dtype=np.int64)
        data["wedgeVertexIsStart"] = np.asarray(wedge_vertex_is_start, dtype=bool)
        data["wedgeVertexCountNp"] = np.asarray(wedge_count, dtype=np.int64)

    pos = {data["augIds"][i]: (float(x[i]), float(y[i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({"positions": pos})


def _evaluate_angle_objective(data, x, y, zX, zY):
    wc = data["wedges"]
    wedge_count = len(wc)
    if not (wedge_count > 0):
        return gu.build_layout_error({"reason": "AngleBalancer requires at least one valid objective angle"})
    n_vertex = len(data["objectiveVertexIds"])
    vertex_weight_scale = (1 / n_vertex) if n_vertex else (1 / wedge_count)

    center = data["wedgeCenter"]; left = data["wedgeLeft"]; right = data["wedgeRight"]
    target = data["wedgeTarget"]; vertex_idx = data["wedgeVertexIdx"]

    ux = x[left] - x[center]
    uy = y[left] - y[center]
    vx = x[right] - x[center]
    vy = y[right] - y[center]
    len_u2 = ux * ux + uy * uy
    len_v2 = vx * vx + vy * vy
    len_tol2 = max(1e-24, data["angleTol"] * data["angleTol"])
    if not np.all(len_u2 > len_tol2) or not np.all(len_v2 > len_tol2):
        return gu.build_layout_error({"reason": "invalid-angle-step"})
    cross = ux * vy - uy * vx
    dot = ux * vx + uy * vy
    angle = np.arctan2(cross, dot)
    angle = np.where(angle > 0, angle, angle + TWO_PI)
    if not np.all(angle > data["angleTol"]):
        return gu.build_layout_error({"reason": "invalid-angle-step"})
    denom = len_u2 * len_v2
    if not np.all(denom > 1e-24) or not np.all(np.isfinite(denom)):
        return gu.build_layout_error({"reason": "invalid-angle-step"})

    grad_ux = (dot * vy - cross * vx) / denom
    grad_uy = (-dot * vx - cross * vy) / denom
    grad_vx = (-dot * uy - cross * ux) / denom
    grad_vy = (dot * ux - cross * uy) / denom
    grad_center_x = -grad_ux - grad_vx
    grad_center_y = -grad_uy - grad_vy

    ratio = angle / target
    if not np.all(ratio > 0) or not np.all(np.isfinite(ratio)):
        return gu.build_layout_error({"reason": "invalid-angle-step"})
    residual = ratio - 1
    abs_res = np.abs(residual)
    worst_idx = int(np.argmax(abs_res))
    max_angle_residual = float(abs_res[worst_idx])
    min_angle_ratio = float(ratio.min())
    worst_wedge = {
        "vertexId": data["objectiveVertexIds"][int(vertex_idx[worst_idx])],
        "angle": float(angle[worst_idx]),
        "targetAngle": float(target[worst_idx]),
        "ratio": float(ratio[worst_idx]),
        "residual": float(residual[worst_idx]),
    }

    min_ratio_weight = data["minRatioWeight"] if data["minRatioWeight"] > 0 else 0
    min_ratio_beta = data["minRatioBeta"] if data["minRatioBeta"] > 0 else 10

    # Per-vertex softmax over scaled_deficit = beta*(1-ratio). We use segmented
    # reduce via np.maximum.reduceat / np.add.reduceat, but the wedges are
    # already grouped by vertex_idx in construction order (contiguous).
    # wedgeStart (a python list) gives segment starts. We can use np.maximum.reduceat
    # directly on the flat wedge array.
    if min_ratio_weight > 0 and n_vertex > 0:
        scaled_deficit = min_ratio_beta * (1 - ratio)
        wedge_start_np = np.asarray(data["wedgeStart"], dtype=np.int64)
        vertex_max = np.maximum.reduceat(scaled_deficit, wedge_start_np)
        exp_term = np.exp(scaled_deficit - vertex_max[vertex_idx])
        vertex_sum = np.add.reduceat(exp_term, wedge_start_np)
    else:
        vertex_max = None
        exp_term = None
        vertex_sum = None

    # weight_scale per wedge = vertex_weight_scale / max(1, wedgeCount[vertex_idx])
    wedge_vertex_count = data["wedgeVertexCountNp"]
    weight_scale = vertex_weight_scale / np.maximum(1, wedge_vertex_count[vertex_idx])

    angle_obj = float((weight_scale * residual * residual).sum())
    coeff = weight_scale * (2 * residual / target)
    if data["angleBarrierWeight"] > 0:
        angle_obj -= float((weight_scale * data["angleBarrierWeight"] * np.log(ratio)).sum())
        coeff = coeff - weight_scale * data["angleBarrierWeight"] / angle
    if vertex_sum is not None:
        vertex_soft_min_weight = vertex_weight_scale * min_ratio_weight
        # contribute log(sum) + max term once per vertex — at the "start" wedge per vertex
        start_mask = data["wedgeVertexIsStart"]
        valid_vs = vertex_sum > 0
        # Build per-wedge log_sum + max for the start wedges only
        log_terms = np.zeros_like(angle)
        any_valid = valid_vs[vertex_idx]
        # For start wedges whose vertex has vertex_sum>0
        start_and_valid = start_mask & any_valid
        if start_and_valid.any():
            vi = vertex_idx[start_and_valid]
            log_terms[start_and_valid] = ((np.log(vertex_sum[vi]) + vertex_max[vi]) / min_ratio_beta)
        angle_obj += float((vertex_soft_min_weight * log_terms[start_mask]).sum())
        # The grad contribution for every wedge in a vertex with vertex_sum>0:
        vs_valid = vertex_sum[vertex_idx] > 0
        soft_min_share = np.where(vs_valid,
                                  np.exp(min_ratio_beta * (1 - ratio) - vertex_max[vertex_idx]) /
                                  np.where(vertex_sum[vertex_idx] > 0, vertex_sum[vertex_idx], 1.0),
                                  0.0)
        coeff = coeff - np.where(vs_valid, vertex_soft_min_weight * soft_min_share / target, 0.0)

    # scatter gradient: center, left, right contributions
    iibaN = data["interiorIndexByAugNp"]
    ic_center = iibaN[center]
    ic_left = iibaN[left]
    ic_right = iibaN[right]

    for idxs, gx, gy in [
        (ic_center, coeff * grad_center_x, coeff * grad_center_y),
        (ic_left,   coeff * grad_ux,       coeff * grad_uy),
        (ic_right,  coeff * grad_vx,       coeff * grad_vy),
    ]:
        mask = idxs >= 0
        if mask.any():
            np.add.at(zX, idxs[mask], gx[mask])
            np.add.at(zY, idxs[mask], gy[mask])

    return gu.build_layout_result({
        "angleObjectiveTerm": angle_obj,
        "maxAngleResidual": max_angle_residual,
        "minAngleRatio": min_angle_ratio,
        "worstWedge": worst_wedge,
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

    zX = np.zeros(nI); zY = np.zeros(nI)
    angle_eval = _evaluate_angle_objective(data, x, y, zX, zY)
    if not angle_eval.get("ok"):
        return angle_eval
    E = angle_eval["angleObjectiveTerm"]

    if data["faceBarrierWeight"] > 0 and tri_a.size:
        E -= data["faceBarrierWeight"] * float(np.log(face_areas / data["initialAvgFaceArea"]).sum())
        coeff = -data["faceBarrierWeight"] / face_areas
        bc.scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                                      data["interiorIndexByAugNp"])

    adjoint = bc.adjoint_solve_np(L, zX, zY)
    if adjoint is None:
        return gu.build_layout_error({"reason": "AngleBalancer adjoint solve failed"})
    ax1, ax2 = adjoint
    grad_vec = bc.assemble_grad_vec(lam, data["flat"], ax1, ax2, x, y)
    grad_norm = float(np.linalg.norm(grad_vec))

    return gu.build_layout_result({
        "E": E,
        "gradVec": grad_vec,
        "gradNorm": grad_norm,
        "x": x, "y": y,
        "maxAngleResidual": angle_eval.get("maxAngleResidual"),
        "minAngleRatio": angle_eval.get("minAngleRatio"),
        "worstWedge": angle_eval.get("worstWedge"),
    })


def _compute_interior_move_stats(data, prev_x, prev_y, next_x, next_y):
    def dist(idx, _i):
        return math.hypot(next_x[idx] - prev_x[idx], next_y[idx] - prev_y[idx])
    return gu.compute_move_stats(data["interiorAugIndices"], dist, {"moveTol": 1e-9})


def _run_optimization(q0, data, opts):
    max_iters = opts["maxIters"]
    q = q0.copy()
    current = _evaluate_objective(q, data)
    if not current.get("ok"):
        return current

    S: list = []; Y: list = []; Rho: list = []
    movement_tracker = opts.get("movementTracker")
    stop_reason = "max-iters"
    completed = 0

    for iter_ in range(1, max_iters + 1):
        if current["gradNorm"] <= ANGLE_CONFIG["gradTol"]:
            stop_reason = "grad-converged"
            break
        prev_x = current["x"]; prev_y = current["y"]
        d = bc.lbfgs_direction_np(current["gradVec"], S, Y, Rho)
        gtd = float(current["gradVec"] @ d)
        if not (gtd < 0):
            d = -current["gradVec"]
            gtd = float(current["gradVec"] @ d)
        dn = float(np.linalg.norm(d))
        if dn > ANGLE_CONFIG["maxStepNorm"]:
            d = d * (ANGLE_CONFIG["maxStepNorm"] / dn)
            gtd = float(current["gradVec"] @ d)

        accepted = None
        for ls_attempt in range(2):
            if accepted is not None: break
            search_dir = d
            search_gtd = gtd
            if ls_attempt == 1:
                search_dir = -current["gradVec"]
                dn2 = float(np.linalg.norm(search_dir))
                if dn2 > ANGLE_CONFIG["maxStepNorm"]:
                    search_dir = search_dir * (ANGLE_CONFIG["maxStepNorm"] / dn2)
                search_gtd = float(current["gradVec"] @ search_dir)
                if not (search_gtd < 0): break
                if S:
                    S = []; Y = []; Rho = []
            alpha = 1.0
            while alpha >= 1e-12:
                q_trial = q + alpha * search_dir
                trial = _evaluate_objective(q_trial, data)
                if trial.get("ok"):
                    tm = _compute_interior_move_stats(data, current["x"], current["y"], trial["x"], trial["y"])
                    if tm.max_move > opts["maxPositionStep"]:
                        alpha *= ANGLE_CONFIG["lineSearchTau"]
                        continue
                if trial.get("ok") and trial["E"] <= current["E"] + ANGLE_CONFIG["lineSearchC1"] * alpha * search_gtd:
                    accepted = (q_trial, trial)
                    break
                alpha *= ANGLE_CONFIG["lineSearchTau"]
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
            ms = movement_tracker.update(move_stats, iter_)
            if ms.converged:
                stop_reason = ms.reason or "movement-converged"
                break
        if step_norm < ANGLE_CONFIG["stepTol"]:
            stop_reason = "step-converged"
            break
        ys = float(yv @ s)
        if ys > 1e-14:
            if len(S) == ANGLE_CONFIG["lbfgsMemory"]:
                S.pop(0); Y.pop(0); Rho.pop(0)
            S.append(s); Y.append(yv); Rho.append(1 / ys)

    pos = {data["augIds"][i]: (float(current["x"][i]), float(current["y"][i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({
        "positions": pos,
        "E": current["E"],
        "maxAngleResidual": current.get("maxAngleResidual"),
        "minAngleRatio": current.get("minAngleRatio"),
        "worstWedge": current.get("worstWedge"),
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


def _compute_angle_stats(graph, pos_by_id):
    result = metric_mod.compute_angular_resolution_score(graph, pos_by_id)
    if result.get("ok"):
        return {"angleResolutionScore": result["score"], "angleCount": result.get("usedNodeCount")}
    return {"angleResolutionScore": None, "angleCount": None}


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    layout_input = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "AngleBalancer layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": dict(opts["augmentationOptions"]) if isinstance(opts.get("augmentationOptions"), dict) else None,
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "AngleBalancer setup failed"})

    g = layout_input["graph"]
    outer_face = layout_input["augmentedOuterFace"]
    augmented = layout_input["augmented"]
    base_embedding = layout_input["baseEmbedding"]
    outer_pos = _build_outer_positions(layout_input)
    data = _build_data({
        "augmentedEdgePairs": augmented["graph"].edge_pairs,
        "augmentedEmbedding": augmented["embedding"],
        "outerFace": outer_face,
        "outerPos": outer_pos,
        "objectiveGraph": g,
        "baseEmbedding": base_embedding,
        "areaTol": ANGLE_CONFIG["areaTol"],
        "angleTol": ANGLE_CONFIG["wedgeTol"],
        "angleBarrierWeight": ANGLE_CONFIG["angleBarrierWeight"],
        "minRatioWeight": ANGLE_CONFIG["minRatioWeight"],
        "minRatioBeta": ANGLE_CONFIG["minRatioBeta"],
        "faceBarrierWeight": ANGLE_CONFIG["faceBarrierWeight"],
        "minFaceArea": 0,
    })
    if not data.get("ok"):
        return gu.build_layout_error({
            "message": data.get("reason") or "AngleBalancer setup failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    tutte_weights = tutte_mod.build_tutte_weights(g, augmented["graph"])
    q0_result = _build_initial_logit_seed(data, tutte_weights)
    if not q0_result.get("ok"):
        return gu.build_layout_error({
            "message": q0_result.get("reason") or "AngleBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    q0 = q0_result["q0"]
    baseline = _initialize_baseline(data, q0)
    if not baseline.get("ok") or not baseline.get("positions"):
        return gu.build_layout_error({
            "message": baseline.get("reason") or "AngleBalancer initialization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    data["minFaceArea"] = max(0, ANGLE_CONFIG["minFaceAreaFactor"] * data["initialMinFaceArea"])
    if not (len(data["objectiveVertexIds"]) > 0) or not (len(data["wedges"]) > 0):
        static_positions = geo.filter_position_map(baseline["positions"], g.node_ids)
        static_stats = _compute_angle_stats(g, static_positions)
        return gu.build_layout_result({
            "nodeIds": g.node_ids,
            "edgePairs": g.edge_pairs,
            "outerFace": outer_face,
            "graph": g, "augmented": augmented,
            "positions": static_positions,
            "stopReason": "no-objective-angles", "iters": 0, "objective": 0,
            "angleResolutionScore": static_stats["angleResolutionScore"],
            "angleCount": static_stats["angleCount"],
        })

    movement_scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, baseline["positions"])
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": ANGLE_CONFIG["minItersBeforeStop"],
        "stableIterLimit": ANGLE_CONFIG["stableIterLimit"],
        "maxMoveTol": ANGLE_CONFIG["movementStopTol"] * movement_scale,
        "avgMoveTol": ANGLE_CONFIG["avgMovementStopTol"] * movement_scale,
    })
    result = _run_optimization(q0, data, {
        "maxIters": ANGLE_CONFIG["maxIters"],
        "maxPositionStep": ANGLE_CONFIG["maxPositionStepRatio"] * movement_scale,
        "movementTracker": movement_tracker,
    })
    if not result.get("ok"):
        return gu.build_layout_error({
            "message": result.get("reason") or "AngleBalancer optimization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    final_positions = geo.filter_position_map(result["positions"], g.node_ids)
    if geo.has_position_crossings(final_positions, g.edge_pairs):
        return gu.build_layout_error({
            "stopReason": result.get("stopReason"),
            "graph": g, "outerFace": outer_face, "augmented": augmented,
            "message": "AngleBalancer produced a non-plane drawing",
        })
    final_angle_stats = _compute_angle_stats(g, final_positions)
    res = gu.build_layout_result({
        "nodeIds": g.node_ids,
        "edgePairs": g.edge_pairs,
        "outerFace": outer_face,
        "graph": g, "augmented": augmented,
        "positions": final_positions,
        "stopReason": result.get("stopReason"),
        "iters": result.get("iters"),
        "objective": result.get("E"),
        "angleResolutionScore": final_angle_stats["angleResolutionScore"],
        "angleCount": final_angle_stats["angleCount"],
        "maxAngleResidual": result.get("maxAngleResidual"),
        "minAngleRatio": result.get("minAngleRatio"),
    })
    obj = result.get("E")
    ar_score = res.get("angleResolutionScore")
    extras = []
    if isinstance(ar_score, (int, float)) and math.isfinite(ar_score):
        extras.append(f"angle score {ar_score:.3f}")
    if isinstance(obj, (int, float)) and math.isfinite(obj):
        extras.append(f"obj {obj:.3f}")
    res["message"] = gu.build_layout_status_message("AngleBalancer", {
        "dummyCount": augmented.get("dummyCount"),
        "iters": res.get("iters"),
        "stopReason": res.get("stopReason"),
        "extraParts": extras or None,
    })
    return res
