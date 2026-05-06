"""FABalancer layout (staged: face-warm -> angle -> align). Port of static/js/layout-fabalancer.js.

Numpy-vectorized inner loops.
"""

from __future__ import annotations

import math

import numpy as np

from .. import alignment
from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import preprocessing
from . import tutte as tutte_mod
from . import _balancer_common as bc

TWO_PI = 2 * math.pi
FABALANCER_CONFIG = {
    "areaTol": 1e-15,
    "angleTol": 1e-8,
    "gradTol": 1e-5,
    "stepTol": 1e-10,
    "maxStepNorm": 2.0,
    "lbfgsMemory": 10,
    "lineSearchC1": 1e-4,
    "lineSearchTau": 0.5,
    "movementStopTol": 1e-6,
    "avgMovementStopTol": 2e-7,
    "alignMaxPasses": 3,
    "faceWarmStage": {
        "maxIters": 20,
        "minItersBeforeStop": 20,
        "stableIterLimit": 6,
        "maxPositionStepRatio": 0.02,
        "minFaceAreaFactor": 0.25,
        "faceBarrierWeight": 0.2,
        "edgeBarrierWeight": 0.05,
        "edgeUniformWeight": 0.02,
        "faceWeight": 1.0,
        "angleWeight": 0,
        "angleBarrierWeight": 0,
        "horizontalityWeight": 0,
    },
    "angleStage": {
        "maxIters": 180,
        "minItersBeforeStop": 40,
        "stableIterLimit": 8,
        "maxPositionStepRatio": 0.01,
        "minFaceAreaFactor": 0.2,
        "angleBarrierWeight": 0.5,
        "minRatioWeight": 0.25,
        "minRatioBeta": 10,
        "faceBarrierWeight": 0.02,
        "faceWeight": 0,
        "angleWeight": 1.0,
        "horizontalityWeight": 0.5,
        "edgeBarrierWeight": 0.005,
        "edgeUniformWeight": 0.002,
    },
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
            return gu.build_layout_error({"reason": "FABalancer requires a valid triangulated augmentation"})
        if len(mapped) != 3:
            return gu.build_layout_error({"reason": "FABalancer requires all non-outer augmented faces to be triangles"})
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

    base_ids = [str(x) for x in (base_embedding.get("idByIndex") or [])]
    base_index_by_id = {base_ids[i]: i for i in range(len(base_ids))}

    objective_vertex_ids = []
    wedge_start_list = []
    wedge_count_list = []
    wedges = []
    wedge_vertex_is_start = []
    objective_edges = []
    base_rot = base_embedding.get("rotation") or []
    for center_raw in objective_graph.node_ids:
        center_id = str(center_raw)
        center_base_idx = base_index_by_id.get(center_id)
        center_aug_idx = aug_index_by_id.get(center_id)
        if center_base_idx is None or center_aug_idx is None:
            continue
        objective_rotation = base_rot[center_base_idx] if center_base_idx < len(base_rot) else []
        if len(objective_rotation) < 2:
            continue
        objective_neighbors = []
        for n in objective_rotation:
            n_aug = aug_index_by_id.get(str(n))
            if n_aug is not None:
                objective_neighbors.append(n_aug)
        if len(objective_neighbors) < 2:
            continue
        target_angle = TWO_PI / len(objective_neighbors)
        wedge_start_list.append(len(wedges))
        wedge_count_list.append(len(objective_neighbors))
        objective_vertex_ids.append(center_id)
        for k in range(len(objective_neighbors)):
            left_aug = objective_neighbors[k]
            right_aug = objective_neighbors[(k + 1) % len(objective_neighbors)]
            wedges.append((center_aug_idx, left_aug, right_aug, target_angle, len(objective_vertex_ids) - 1))
            wedge_vertex_is_start.append(k == 0)

    for (a_raw, b_raw) in objective_graph.edge_pairs:
        eu = aug_index_by_id.get(str(a_raw)); ev = aug_index_by_id.get(str(b_raw))
        if eu is None or ev is None or eu == ev: continue
        objective_edges.append((eu, ev))

    flat = bc.precompute_flat_indices(row_start, row_length, neighbor_aug_indices,
                                      neighbor_interior_indices, q_size)
    interior_aug_np = np.asarray(interior_aug_indices, dtype=np.int64)
    interior_index_by_aug_np = np.asarray(interior_index_by_aug, dtype=np.int64)
    tri_a = np.asarray([f[0] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_b = np.asarray([f[1] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    tri_c = np.asarray([f[2] for f in bounded_faces], dtype=np.int64) if bounded_faces else np.zeros(0, dtype=np.int64)
    all_u = np.asarray([e[0] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)
    all_v = np.asarray([e[1] for e in edges], dtype=np.int64) if edges else np.zeros(0, dtype=np.int64)
    obj_u = np.asarray([e[0] for e in objective_edges], dtype=np.int64) if objective_edges else np.zeros(0, dtype=np.int64)
    obj_v = np.asarray([e[1] for e in objective_edges], dtype=np.int64) if objective_edges else np.zeros(0, dtype=np.int64)

    wedge_center = np.asarray([w[0] for w in wedges], dtype=np.int64) if wedges else np.zeros(0, dtype=np.int64)
    wedge_left = np.asarray([w[1] for w in wedges], dtype=np.int64) if wedges else np.zeros(0, dtype=np.int64)
    wedge_right = np.asarray([w[2] for w in wedges], dtype=np.int64) if wedges else np.zeros(0, dtype=np.int64)
    wedge_target = np.asarray([w[3] for w in wedges]) if wedges else np.zeros(0)
    wedge_vertex_idx = np.asarray([w[4] for w in wedges], dtype=np.int64) if wedges else np.zeros(0, dtype=np.int64)
    wedge_is_start_np = np.asarray(wedge_vertex_is_start, dtype=bool) if wedges else np.zeros(0, dtype=bool)
    wedge_count_np = np.asarray(wedge_count_list, dtype=np.int64) if wedge_count_list else np.zeros(0, dtype=np.int64)
    wedge_start_np = np.asarray(wedge_start_list, dtype=np.int64) if wedge_start_list else np.zeros(0, dtype=np.int64)

    return gu.build_layout_result({
        "augIds": aug_ids,
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
        "allEdgesU": all_u, "allEdgesV": all_v,
        "objectiveVertexIds": objective_vertex_ids,
        "wedgeStart": wedge_start_list,
        "wedgeStartNp": wedge_start_np,
        "wedgeCount": wedge_count_list,
        "wedgeCountNp": wedge_count_np,
        "wedges": wedges,
        "wedgeCenter": wedge_center,
        "wedgeLeft": wedge_left,
        "wedgeRight": wedge_right,
        "wedgeTarget": wedge_target,
        "wedgeVertexIdx": wedge_vertex_idx,
        "wedgeVertexIsStart": wedge_is_start_np,
        "objectiveEdges": objective_edges,
        "objEdgeU": obj_u, "objEdgeV": obj_v,
        "areaTol": input_["areaTol"],
        "angleTol": input_["angleTol"],
        "angleBarrierWeight": input_.get("angleBarrierWeight", 0),
        "minRatioWeight": max(0, input_.get("minRatioWeight") or 0),
        "minRatioBeta": input_.get("minRatioBeta"),
        "faceBarrierWeight": input_.get("faceBarrierWeight", 0),
        "horizontalityWeight": input_.get("horizontalityWeight", 0),
        "edgeBarrierWeight": input_.get("edgeBarrierWeight", 0),
        "edgeUniformWeight": input_.get("edgeUniformWeight", 0),
        "minFaceArea": 0,
        "faceWeight": input_.get("faceWeight", 0),
        "angleWeight": input_.get("angleWeight", 0),
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
                    "reason": "FABalancer initialization requires positive Tutte weights",
                    "vertexId": vertex_id, "neighborId": neighbor_id,
                })
            row_weights[k] = rw
            row_weight_sum += rw
        if not (row_weight_sum > 0):
            return gu.build_layout_error({
                "reason": "FABalancer initialization requires positive Tutte row weight sum",
                "vertexId": vertex_id,
            })
        for k in range(len(neighbors)):
            q0[row_offset + k] = math.log(row_weights[k] / row_weight_sum)
    return gu.build_layout_result({"q0": q0})


def _build_initial_logit_seed_from_positions(data, pos_by_id):
    q0 = np.zeros(data["qSize"])
    nA = len(data["augIds"])
    x = np.zeros(nA)
    y = np.zeros(nA)
    for i, nid in enumerate(data["augIds"]):
        p = pos_by_id.get(nid) if pos_by_id else None
        x[i] = p[0] if p is not None else data["x0"][i]
        y[i] = p[1] if p is not None else data["y0"][i]

    for i, aug_idx in enumerate(data["interiorAugIndices"]):
        row_offset = data["rowStart"][i]
        neighbors = data["neighborAugIndices"][i]
        if not neighbors: continue
        vectors = []
        angles = []
        for n_aug in neighbors:
            vx = x[n_aug] - x[aug_idx]; vy = y[n_aug] - y[aug_idx]
            length = math.hypot(vx, vy)
            if not (length > 1e-12):
                return gu.build_layout_error({"reason": "FABalancer warm start requires positive edge lengths"})
            vectors.append((vx, vy, length))
        for k in range(len(neighbors)):
            nxt = (k + 1) % len(neighbors)
            cross = vectors[k][0] * vectors[nxt][1] - vectors[k][1] * vectors[nxt][0]
            dot = vectors[k][0] * vectors[nxt][0] + vectors[k][1] * vectors[nxt][1]
            theta = math.atan2(cross, dot)
            if not (theta > 0): theta += TWO_PI
            if not (theta > 1e-8):
                return gu.build_layout_error({"reason": "FABalancer warm start requires strictly positive neighbor wedges"})
            angles.append(theta)

        weight_by_neighbor = {}
        row_weight_sum = 0.0
        for k in range(len(neighbors)):
            prev = (k + len(neighbors) - 1) % len(neighbors)
            weight = (math.tan(angles[prev] / 2) + math.tan(angles[k] / 2)) / vectors[k][2]
            if not (weight > 0) or not math.isfinite(weight):
                return gu.build_layout_error({"reason": "FABalancer warm start requires positive mean-value weights"})
            weight_by_neighbor[neighbors[k]] = weight
            row_weight_sum += weight
        if not (row_weight_sum > 0):
            return gu.build_layout_error({"reason": "FABalancer warm start requires positive row weight sum"})
        for k, n_aug in enumerate(neighbors):
            nw = weight_by_neighbor.get(n_aug)
            if not (nw and nw > 0):
                return gu.build_layout_error({"reason": "FABalancer warm start could not map neighbor weights"})
            q0[row_offset + k] = math.log(nw / row_weight_sum)
    return gu.build_layout_result({"q0": q0})


def _realize_state(q, data, failure_reason=None):
    nI = len(data["interiorAugIndices"])
    ok, res = bc.realize_state_np(q, data["flat"], data["x0"], data["y0"],
                                  data["interiorAugNp"], nI)
    if not ok:
        return gu.build_layout_error({"reason": failure_reason or "FABalancer linear solve failed"})
    return gu.build_layout_result({"lambda": res["lambda"], "L": res["L"],
                                   "x": res["x"], "y": res["y"]})


def _initialize_baseline(data, q0):
    realized = _realize_state(q0, data, "FABalancer initialization failed")
    if not realized.get("ok"):
        return realized
    x = realized["x"]; y = realized["y"]

    if data["allEdgesU"].size:
        dx = x[data["allEdgesU"]] - x[data["allEdgesV"]]
        dy = y[data["allEdgesU"]] - y[data["allEdgesV"]]
        len2 = dx * dx + dy * dy
        mask = len2 > 1e-12
        if mask.any():
            data["edgeBarrierScale2"] = float(len2[mask].mean())
        else:
            data["edgeBarrierScale2"] = 1
    else:
        data["edgeBarrierScale2"] = 1

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
    pos = {data["augIds"][i]: (float(x[i]), float(y[i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({"positions": pos})


def _evaluate_angle_terms(data, x, y, zX, zY):
    wedge_count = len(data["wedges"])
    if not (wedge_count > 0):
        return gu.build_layout_error({"reason": "FABalancer requires at least one valid objective angle"})
    n_vertex = len(data["objectiveVertexIds"])
    vertex_weight_scale = (1 / n_vertex) if n_vertex else (1 / wedge_count)

    center = data["wedgeCenter"]; left = data["wedgeLeft"]; right = data["wedgeRight"]
    target = data["wedgeTarget"]; vertex_idx = data["wedgeVertexIdx"]

    ux = x[left] - x[center]; uy = y[left] - y[center]
    vx = x[right] - x[center]; vy = y[right] - y[center]
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
    gcx = -grad_ux - grad_vx
    gcy = -grad_uy - grad_vy

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
    min_ratio_beta = data["minRatioBeta"] if data["minRatioBeta"] and data["minRatioBeta"] > 0 else 10
    vertex_max = vertex_sum = None
    if min_ratio_weight > 0 and n_vertex > 0:
        scaled_deficit = min_ratio_beta * (1 - ratio)
        vertex_max = np.maximum.reduceat(scaled_deficit, data["wedgeStartNp"])
        exp_term = np.exp(scaled_deficit - vertex_max[vertex_idx])
        vertex_sum = np.add.reduceat(exp_term, data["wedgeStartNp"])

    weight_scale = vertex_weight_scale / np.maximum(1, data["wedgeCountNp"][vertex_idx])
    angle_obj = float((weight_scale * residual * residual).sum())
    coeff = weight_scale * (2 * residual / target)
    if data["angleBarrierWeight"] > 0:
        angle_obj -= float((weight_scale * data["angleBarrierWeight"] * np.log(ratio)).sum())
        coeff = coeff - weight_scale * data["angleBarrierWeight"] / angle

    if vertex_sum is not None:
        vswm = vertex_weight_scale * min_ratio_weight
        start_mask = data["wedgeVertexIsStart"]
        valid_vs = vertex_sum > 0
        any_valid = valid_vs[vertex_idx]
        log_terms_start = np.zeros_like(angle)
        start_and_valid = start_mask & any_valid
        if start_and_valid.any():
            vi = vertex_idx[start_and_valid]
            log_terms_start[start_and_valid] = (np.log(vertex_sum[vi]) + vertex_max[vi]) / min_ratio_beta
        angle_obj += float((vswm * log_terms_start[start_mask]).sum())
        safe_sum = np.where(vertex_sum > 0, vertex_sum, 1.0)
        soft_min_share = np.where(any_valid,
                                  np.exp(min_ratio_beta * (1 - ratio) - vertex_max[vertex_idx]) / safe_sum[vertex_idx],
                                  0.0)
        coeff = coeff - np.where(any_valid, vswm * soft_min_share / target, 0.0)

    iibaN = data["interiorIndexByAugNp"]
    ic_center = iibaN[center]
    ic_left = iibaN[left]
    ic_right = iibaN[right]
    for idxs, gx, gy in [
        (ic_center, coeff * gcx, coeff * gcy),
        (ic_left, coeff * grad_ux, coeff * grad_uy),
        (ic_right, coeff * grad_vx, coeff * grad_vy),
    ]:
        m = idxs >= 0
        if m.any():
            np.add.at(zX, idxs[m], gx[m])
            np.add.at(zY, idxs[m], gy[m])

    return gu.build_layout_result({
        "angleObjectiveTerm": angle_obj,
        "maxAngleResidual": max_angle_residual,
        "minAngleRatio": min_angle_ratio,
        "worstWedge": worst_wedge,
    })


def _evaluate_horizontality_terms(data, x, y, zX, zY):
    if not (data["objEdgeU"].size > 0):
        return gu.build_layout_result({"horizontalityObjectiveTerm": 0})
    eps2 = max(1e-24, data["areaTol"])
    u = data["objEdgeU"]; v = data["objEdgeV"]
    dx = x[v] - x[u]; dy = y[v] - y[u]
    abs_dy = np.sqrt(dy * dy + eps2)
    len2 = dx * dx + dy * dy + eps2
    ln = np.sqrt(len2)
    penalty = abs_dy / ln
    weight = 1 / u.size
    horiz_obj = float(weight * penalty.sum())
    grad_dx = -abs_dy * dx / (len2 * ln)
    grad_dy = (dy / (abs_dy * ln)) - (abs_dy * dy / (len2 * ln))
    iibaN = data["interiorIndexByAugNp"]
    iu = iibaN[u]; iv = iibaN[v]
    mu = iu >= 0
    mv = iv >= 0
    if mu.any():
        np.add.at(zX, iu[mu], (-weight * grad_dx)[mu])
        np.add.at(zY, iu[mu], (-weight * grad_dy)[mu])
    if mv.any():
        np.add.at(zX, iv[mv], (weight * grad_dx)[mv])
        np.add.at(zY, iv[mv], (weight * grad_dy)[mv])
    return gu.build_layout_result({"horizontalityObjectiveTerm": horiz_obj})


def _evaluate_angle_stage(q, data):
    triangle_slack = max(data["areaTol"], 1e-12)
    nI = len(data["interiorAugIndices"])
    realized = _realize_state(q, data, "FABalancer angle stage linear solve failed")
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
    angle_eval = _evaluate_angle_terms(data, x, y, zX, zY)
    if not angle_eval.get("ok"):
        return angle_eval
    E = angle_eval["angleObjectiveTerm"]

    if data["horizontalityWeight"] > 0:
        hz_zX = np.zeros(nI); hz_zY = np.zeros(nI)
        hz = _evaluate_horizontality_terms(data, x, y, hz_zX, hz_zY)
        if not hz.get("ok"):
            return hz
        E += data["horizontalityWeight"] * hz["horizontalityObjectiveTerm"]
        zX += data["horizontalityWeight"] * hz_zX
        zY += data["horizontalityWeight"] * hz_zY

    if data["faceBarrierWeight"] > 0 and tri_a.size:
        E -= data["faceBarrierWeight"] * float(np.log(face_areas / data["initialAvgFaceArea"]).sum())
        coeff = -data["faceBarrierWeight"] / face_areas
        bc.scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                                      data["interiorIndexByAugNp"])

    adjoint = bc.adjoint_solve_np(L, zX, zY)
    if adjoint is None:
        return gu.build_layout_error({"reason": "FABalancer angle stage adjoint solve failed"})
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


def _evaluate_face_stage(q, data):
    triangle_slack = max(data["areaTol"], 1e-12)
    nI = len(data["interiorAugIndices"])
    realized = _realize_state(q, data, "FABalancer linear solve failed")
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
    total_area = float(face_areas.sum()) if tri_a.size else 0
    if not (face_areas.size > 0) or not (total_area > 1e-12):
        return gu.build_layout_error({"reason": "FABalancer total bounded area is not positive"})

    zX = np.zeros(nI); zY = np.zeros(nI)
    E = 0.0

    if data["angleWeight"] > 0:
        a_zX = np.zeros(nI); a_zY = np.zeros(nI)
        angle_eval = _evaluate_angle_terms(data, x, y, a_zX, a_zY)
        if not angle_eval.get("ok"):
            return angle_eval
        E += data["angleWeight"] * angle_eval["angleObjectiveTerm"]
        zX += data["angleWeight"] * a_zX
        zY += data["angleWeight"] * a_zY
    else:
        angle_eval = {"maxAngleResidual": None, "minAngleRatio": None, "worstWedge": None,
                      "angleObjectiveTerm": 0}

    if data["horizontalityWeight"] > 0:
        hz_zX = np.zeros(nI); hz_zY = np.zeros(nI)
        hz = _evaluate_horizontality_terms(data, x, y, hz_zX, hz_zY)
        if not hz.get("ok"):
            return hz
        E += data["horizontalityWeight"] * hz["horizontalityObjectiveTerm"]
        zX += data["horizontalityWeight"] * hz_zX
        zY += data["horizontalityWeight"] * hz_zY

    target_area = total_area / face_areas.size
    residual = face_areas / target_area - 1
    max_rel_error = float(np.abs(residual).max()) if residual.size else 0
    face_scale = 1 / face_areas.size
    face_weight = data["faceWeight"]
    if face_weight > 0 or data["faceBarrierWeight"] > 0:
        if face_weight > 0:
            E += face_weight * face_scale * float((residual * residual).sum())
        if data["faceBarrierWeight"] > 0:
            E -= face_weight * face_scale * data["faceBarrierWeight"] * float(np.log(face_areas / target_area).sum())
        coeff = np.zeros_like(face_areas)
        if face_weight > 0:
            coeff += face_weight * face_scale * (2 * residual / target_area)
        if data["faceBarrierWeight"] > 0:
            coeff -= face_weight * face_scale * data["faceBarrierWeight"] / face_areas
        bc.scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                                      data["interiorIndexByAugNp"])

    if data["edgeBarrierWeight"] > 0 and data["allEdgesU"].size:
        edge_scale2 = data.get("edgeBarrierScale2") if data.get("edgeBarrierScale2") and data["edgeBarrierScale2"] > 1e-12 else 1
        edge_tol2 = max(1e-24, data["areaTol"])
        edge_barrier_scale = 1 / max(1, data["allEdgesU"].size)
        dx = x[data["allEdgesU"]] - x[data["allEdgesV"]]
        dy = y[data["allEdgesU"]] - y[data["allEdgesV"]]
        len2 = dx * dx + dy * dy
        safe_len2 = np.where(len2 > edge_tol2, len2, edge_tol2)
        active = safe_len2 < edge_scale2
        if active.any():
            E -= data["edgeBarrierWeight"] * edge_barrier_scale * float(np.log(safe_len2[active] / edge_scale2).sum())
            edge_coeff = np.where(active, -2 * data["edgeBarrierWeight"] * edge_barrier_scale / safe_len2, 0.0)
            bc.scatter_edge_gradients(data["allEdgesU"], data["allEdgesV"], edge_coeff, dx, dy,
                                      zX, zY, data["interiorIndexByAugNp"])

    if data["edgeUniformWeight"] > 0 and data["allEdgesU"].size > 1:
        uniform_tol2 = max(1e-24, data["areaTol"])
        dx = x[data["allEdgesU"]] - x[data["allEdgesV"]]
        dy = y[data["allEdgesU"]] - y[data["allEdgesV"]]
        len2 = dx * dx + dy * dy
        safe_len2 = np.where(len2 > uniform_tol2, len2, uniform_tol2)
        log_len2 = np.log(safe_len2)
        mE = data["allEdgesU"].size
        log_mean = float(log_len2.mean())
        centered = log_len2 - log_mean
        E += data["edgeUniformWeight"] * float((centered * centered).sum()) / mE
        uniform_scale = 2 * data["edgeUniformWeight"] / mE
        uc = uniform_scale * centered / safe_len2
        bc.scatter_edge_gradients(data["allEdgesU"], data["allEdgesV"], uc, dx, dy,
                                  zX, zY, data["interiorIndexByAugNp"])

    adjoint = bc.adjoint_solve_np(L, zX, zY)
    if adjoint is None:
        return gu.build_layout_error({"reason": "FABalancer adjoint solve failed"})
    ax1, ax2 = adjoint
    grad_vec = bc.assemble_grad_vec(lam, data["flat"], ax1, ax2, x, y)
    grad_norm = float(np.linalg.norm(grad_vec))
    return gu.build_layout_result({
        "E": E,
        "gradVec": grad_vec,
        "gradNorm": grad_norm,
        "x": x, "y": y,
        "maxRelError": max_rel_error,
        "maxAngleResidual": angle_eval.get("maxAngleResidual"),
        "minAngleRatio": angle_eval.get("minAngleRatio"),
        "worstWedge": angle_eval.get("worstWedge"),
    })


def _compute_interior_move_stats(data, prev_x, prev_y, next_x, next_y):
    def dist(idx, _i):
        return math.hypot(next_x[idx] - prev_x[idx], next_y[idx] - prev_y[idx])
    return gu.compute_move_stats(data["interiorAugIndices"], dist, {"moveTol": 1e-9})


def _run_optimization(q0, data, opts, evaluate):
    max_iters = opts["maxIters"]
    max_position_step = opts["maxPositionStep"]
    q = q0.copy() if isinstance(q0, np.ndarray) else np.asarray(q0, dtype=np.float64).copy()
    current = evaluate(q, data)
    if not current.get("ok"):
        return current
    best = current
    best_q = q.copy()
    S: list = []; Y: list = []; Rho: list = []
    movement_tracker = opts.get("movementTracker")
    stop_reason = "max-iters"
    completed = 0

    for iter_ in range(1, max_iters + 1):
        if current["gradNorm"] <= FABALANCER_CONFIG["gradTol"]:
            stop_reason = "grad-converged"
            break
        prev_x = current["x"]; prev_y = current["y"]
        d = bc.lbfgs_direction_np(current["gradVec"], S, Y, Rho)
        gtd = float(current["gradVec"] @ d)
        if not (gtd < 0):
            d = -current["gradVec"]
            gtd = float(current["gradVec"] @ d)
        dn = float(np.linalg.norm(d))
        if dn > FABALANCER_CONFIG["maxStepNorm"]:
            d = d * (FABALANCER_CONFIG["maxStepNorm"] / dn)
            gtd = float(current["gradVec"] @ d)

        accepted = None
        for ls_attempt in range(2):
            if accepted is not None: break
            search_dir = d
            search_gtd = gtd
            if ls_attempt == 1:
                search_dir = -current["gradVec"]
                dn2 = float(np.linalg.norm(search_dir))
                if dn2 > FABALANCER_CONFIG["maxStepNorm"]:
                    search_dir = search_dir * (FABALANCER_CONFIG["maxStepNorm"] / dn2)
                search_gtd = float(current["gradVec"] @ search_dir)
                if not (search_gtd < 0): break
                if S:
                    S = []; Y = []; Rho = []
            alpha = 1.0
            while alpha >= 1e-12:
                q_trial = q + alpha * search_dir
                trial = evaluate(q_trial, data)
                if trial.get("ok"):
                    tm = _compute_interior_move_stats(data, current["x"], current["y"], trial["x"], trial["y"])
                    if tm.max_move > max_position_step:
                        alpha *= FABALANCER_CONFIG["lineSearchTau"]
                        continue
                if trial.get("ok") and trial["E"] <= current["E"] + FABALANCER_CONFIG["lineSearchC1"] * alpha * search_gtd:
                    accepted = (q_trial, trial)
                    break
                alpha *= FABALANCER_CONFIG["lineSearchTau"]
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
        if current["E"] < best["E"]:
            best = current
            best_q = q.copy()
        if movement_tracker is not None:
            ms = _compute_interior_move_stats(data, prev_x, prev_y, current["x"], current["y"])
            mstat = movement_tracker.update(ms, iter_)
            if mstat.converged:
                stop_reason = mstat.reason or "movement-converged"
                break
        if step_norm < FABALANCER_CONFIG["stepTol"]:
            stop_reason = "step-converged"
            break
        ys = float(yv @ s)
        if ys > 1e-14:
            if len(S) == FABALANCER_CONFIG["lbfgsMemory"]:
                S.pop(0); Y.pop(0); Rho.pop(0)
            S.append(s); Y.append(yv); Rho.append(1 / ys)

    pos = {data["augIds"][i]: (float(best["x"][i]), float(best["y"][i])) for i in range(len(data["augIds"]))}
    return gu.build_layout_result({
        "q": best_q,
        "positions": pos,
        "E": best["E"],
        "maxRelError": best.get("maxRelError"),
        "maxAngleResidual": best.get("maxAngleResidual"),
        "minAngleRatio": best.get("minAngleRatio"),
        "worstWedge": best.get("worstWedge"),
        "stopReason": stop_reason,
        "iters": completed,
    })


def _relax_min_face_area(data, q0, evaluate_fn):
    if not (data and data.get("minFaceArea", 0) > 0) or not callable(evaluate_fn):
        return
    probe = evaluate_fn(q0, data)
    while not probe.get("ok") and probe.get("reason") == "invalid-face-step" and data["minFaceArea"] > 1e-18:
        data["minFaceArea"] *= 0.25
        probe = evaluate_fn(q0, data)


def _build_stage_data(augmented, outer_face, outer_pos, objective_graph, base_embedding, overrides):
    base = {
        "augmentedEdgePairs": augmented["graph"].edge_pairs,
        "augmentedEmbedding": augmented["embedding"],
        "outerFace": outer_face,
        "outerPos": outer_pos,
        "objectiveGraph": objective_graph,
        "baseEmbedding": base_embedding,
        "areaTol": FABALANCER_CONFIG["areaTol"],
        "angleTol": FABALANCER_CONFIG["angleTol"],
    }
    if overrides:
        base.update(overrides)
    return _build_data(base)


def _apply_axis_alignment(graph, pos_by_id, max_passes):
    limit = max(1, int(max_passes)) if isinstance(max_passes, (int, float)) and math.isfinite(max_passes) else 1
    working = geo.copy_position_map(pos_by_id)
    results = []
    changed_any = False
    for _ in range(limit):
        result = alignment.align_to_axis_greedy(graph.node_ids, graph.edge_pairs, working)
        if not result or not result.get("ok"):
            return gu.build_layout_error({"reason": (result or {}).get("reason") or "FABalancer axis-align failed"})
        results.append(result)
        if not result["changed"] or not result.get("positions"):
            break
        working = result["positions"]
        changed_any = True
    return gu.build_layout_result({
        "changed": changed_any,
        "passes": len(results),
        "positions": working,
        "results": results,
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
        "failureLabel": "FABalancer layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": dict(opts["augmentationOptions"]) if isinstance(opts.get("augmentationOptions"), dict) else None,
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "FABalancer setup failed"})

    g = layout_input["graph"]
    outer_face = layout_input["augmentedOuterFace"]
    augmented = layout_input["augmented"]
    base_embedding = layout_input["baseEmbedding"]
    outer_pos = _build_outer_positions(layout_input)
    tutte_weights = tutte_mod.build_tutte_weights(g, augmented["graph"])

    # --- Stage 1: face-warm ---
    fw = FABALANCER_CONFIG["faceWarmStage"]
    fw_data = _build_stage_data(augmented, outer_face, outer_pos, g, base_embedding, {
        "angleBarrierWeight": fw["angleBarrierWeight"],
        "faceBarrierWeight": fw["faceBarrierWeight"],
        "edgeBarrierWeight": fw["edgeBarrierWeight"],
        "edgeUniformWeight": fw["edgeUniformWeight"],
        "faceWeight": fw["faceWeight"],
        "angleWeight": fw["angleWeight"],
        "horizontalityWeight": fw["horizontalityWeight"],
    })
    if not fw_data.get("ok"):
        return gu.build_layout_error({"message": fw_data.get("reason") or "FABalancer setup failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    initial_q = _build_initial_logit_seed(fw_data, tutte_weights)
    if not initial_q.get("ok"):
        return gu.build_layout_error({"message": initial_q.get("reason") or "FABalancer initialization failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    baseline = _initialize_baseline(fw_data, initial_q["q0"])
    if not baseline.get("ok") or not baseline.get("positions"):
        return gu.build_layout_error({"message": baseline.get("reason") or "FABalancer initialization failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    fw_data["minFaceArea"] = max(0, fw["minFaceAreaFactor"] * fw_data["initialMinFaceArea"])
    seed_fw = _build_initial_logit_seed_from_positions(fw_data, baseline["positions"])
    if not seed_fw.get("ok"):
        seed_fw = _build_initial_logit_seed(fw_data, tutte_weights)
        if not seed_fw.get("ok"):
            return gu.build_layout_error({"message": seed_fw.get("reason") or "FABalancer initialization failed",
                                          "graph": g, "outerFace": outer_face, "augmented": augmented})
    q0_fw = seed_fw["q0"]
    _relax_min_face_area(fw_data, q0_fw, _evaluate_face_stage)
    scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, baseline["positions"])
    tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": fw["minItersBeforeStop"],
        "stableIterLimit": fw["stableIterLimit"],
        "maxMoveTol": FABALANCER_CONFIG["movementStopTol"] * scale,
        "avgMoveTol": FABALANCER_CONFIG["avgMovementStopTol"] * scale,
    })
    fw_result = _run_optimization(q0_fw, fw_data, {
        "maxIters": fw["maxIters"],
        "maxPositionStep": fw["maxPositionStepRatio"] * scale,
        "movementTracker": tracker,
    }, _evaluate_face_stage)
    if not fw_result.get("ok") or not isinstance(fw_result.get("q"), np.ndarray):
        return gu.build_layout_error({
            "message": fw_result.get("reason") or "FABalancer face-warm stage did not return a valid result",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    face_warm_q = fw_result["q"]

    # --- Stage 2: angle ---
    ang = FABALANCER_CONFIG["angleStage"]
    ang_data = _build_stage_data(augmented, outer_face, outer_pos, g, base_embedding, {
        "angleBarrierWeight": ang["angleBarrierWeight"],
        "faceBarrierWeight": ang["faceBarrierWeight"],
        "edgeBarrierWeight": ang["edgeBarrierWeight"],
        "edgeUniformWeight": ang["edgeUniformWeight"],
        "faceWeight": ang["faceWeight"],
        "angleWeight": ang["angleWeight"],
        "horizontalityWeight": ang["horizontalityWeight"],
    })
    if not ang_data.get("ok"):
        return gu.build_layout_error({"message": ang_data.get("reason") or "FABalancer setup failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    ang_initial_q = gu.build_layout_result({"q0": face_warm_q.copy()}) if isinstance(face_warm_q, np.ndarray) else _build_initial_logit_seed(ang_data, tutte_weights)
    if not ang_initial_q.get("ok"):
        return gu.build_layout_error({"message": ang_initial_q.get("reason") or "FABalancer initialization failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    ang_baseline = _initialize_baseline(ang_data, ang_initial_q["q0"])
    if not ang_baseline.get("ok") or not ang_baseline.get("positions"):
        return gu.build_layout_error({"message": ang_baseline.get("reason") or "FABalancer initialization failed",
                                      "graph": g, "outerFace": outer_face, "augmented": augmented})
    ang_data["minFaceArea"] = max(0, ang["minFaceAreaFactor"] * ang_data["initialMinFaceArea"])
    if not len(ang_data["objectiveVertexIds"]) > 0 or not len(ang_data["wedges"]) > 0:
        ang_data["angleWeight"] = 0
    q0_ang = ang_initial_q["q0"].copy()
    _relax_min_face_area(ang_data, q0_ang, _evaluate_angle_stage)
    ang_scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, ang_baseline["positions"])
    ang_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": ang["minItersBeforeStop"],
        "stableIterLimit": ang["stableIterLimit"],
        "maxMoveTol": FABALANCER_CONFIG["movementStopTol"] * ang_scale,
        "avgMoveTol": FABALANCER_CONFIG["avgMovementStopTol"] * ang_scale,
    })
    angle_result = _run_optimization(q0_ang, ang_data, {
        "maxIters": ang["maxIters"],
        "maxPositionStep": ang["maxPositionStepRatio"] * ang_scale,
        "movementTracker": ang_tracker,
    }, _evaluate_angle_stage)
    if not angle_result.get("ok"):
        return gu.build_layout_error({
            "message": angle_result.get("reason") or "FABalancer optimization failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })

    final_positions = geo.filter_position_map(angle_result.get("positions") or {}, g.node_ids)
    if geo.has_position_crossings(final_positions, g.edge_pairs):
        return gu.build_layout_error({
            "stopReason": angle_result.get("stopReason"),
            "graph": g, "outerFace": outer_face, "augmented": augmented,
            "message": "FABalancer produced a non-plane drawing",
        })

    align_stage = _apply_axis_alignment(g, final_positions, FABALANCER_CONFIG["alignMaxPasses"])
    if not align_stage.get("ok"):
        return gu.build_layout_error({
            "message": align_stage.get("reason") or "FABalancer axis-align failed",
            "graph": g, "outerFace": outer_face, "augmented": augmented,
        })
    final_positions = geo.filter_position_map(align_stage.get("positions") or final_positions, g.node_ids)

    angle_stats_ = metric_mod.compute_angular_resolution_score(g, final_positions)
    face_stats_ = metric_mod.compute_uniform_face_area_score(g.node_ids, g.edge_pairs, final_positions, base_embedding)
    ang_score = angle_stats_["score"] if angle_stats_.get("ok") else None
    face_score = face_stats_.get("quality") if face_stats_.get("ok") else None
    tradeoff = (math.sqrt(face_score * ang_score)
                if (isinstance(face_score, (int, float)) and face_score >= 0
                    and isinstance(ang_score, (int, float)) and ang_score >= 0)
                else None)
    res = gu.build_layout_result({
        "nodeIds": g.node_ids,
        "edgePairs": g.edge_pairs,
        "outerFace": outer_face,
        "graph": g, "augmented": augmented,
        "positions": final_positions,
        "stopReason": angle_result.get("stopReason"),
        "iters": angle_result.get("iters"),
        "objective": None,
        "angleResolutionScore": ang_score,
        "faceAreaScore": face_score,
        "maxAngleResidual": angle_result.get("maxAngleResidual"),
        "minAngleRatio": angle_result.get("minAngleRatio"),
        "tradeoffScore": tradeoff,
    })
    extras = []
    if isinstance(face_score, (int, float)) and math.isfinite(face_score):
        extras.append(f"face score {face_score:.3f}")
    if isinstance(ang_score, (int, float)) and math.isfinite(ang_score):
        extras.append(f"angle score {ang_score:.3f}")
    if isinstance(tradeoff, (int, float)) and math.isfinite(tradeoff):
        extras.append(f"tradeoff {tradeoff:.3f}")
    res["message"] = gu.build_layout_status_message("FABalancer", {
        "dummyCount": augmented.get("dummyCount"),
        "iters": res.get("iters"),
        "stopReason": res.get("stopReason"),
        "extraParts": extras or None,
    })
    return res
