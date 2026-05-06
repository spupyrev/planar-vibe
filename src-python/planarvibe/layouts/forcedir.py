"""ForceDir (planarity-preserving force-directed). Port of static/js/layout-forcedir.js."""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import preprocessing

FORCE_DIR_CONFIG = {
    "evalEvery": 10,
    "alpha": 1.2,
    "initialStepFactor": 0.02,
    "minStepFactor": 1e-5,
    "minItersBeforeStop": 30,
    "stableIterLimit": 8,
    "movementStopTolFactor": 1e-4,
    "avgMovementStopTolFactor": 2e-5,
    "epsilon": 1e-9,
    "repulsionEps": 1e-6,
    "repulsionPower": 2,
    "maxIters": 400,
    "beta": 0.45,
    "alphaGrowEvery": 120,
    "alphaGrowFactor": 1.15,
    "alphaCap": 4.0,
    "stepDecay": 0.5,
    "maxForce": 9.0,
    "eta": 1.2,
    "zeta": 3.2,
    "collisionBoost": 6.0,
    "kNearest": 4,
}


def _would_introduce_crossing(vertex_id, new_pos, positions, edge_pairs, adjacency, eps) -> bool:
    v = str(vertex_id)
    changed = adjacency.get(v, [])
    for other_raw in changed:
        other = str(other_raw)
        p1 = new_pos
        q1 = positions.get(other)
        if q1 is None:
            continue
        for (a_raw, b_raw) in edge_pairs:
            a, b = str(a_raw), str(b_raw)
            if a == v or b == v or a == other or b == other:
                continue
            p2 = positions.get(a)
            q2 = positions.get(b)
            if p2 is None or q2 is None:
                continue
            if geo.segments_intersect_or_touch(p1, q1, p2, q2, eps):
                return True
    return False


def _median(values: list[float]) -> float:
    if not values:
        return 1.0
    arr = sorted(values)
    mid = len(arr) // 2
    return arr[mid] if len(arr) % 2 == 1 else 0.5 * (arr[mid - 1] + arr[mid])


def _compute_nearest_neighbor_data(node_ids, pos, k_nearest):
    nn_by_id: dict[str, dict] = {}
    knearest_by_id: dict[str, list[dict]] = {}
    ssum = 0.0
    cnt = 0
    sum_k = 0.0
    cnt_k = 0
    k = max(1, int(k_nearest)) if math.isfinite(k_nearest) else 3
    for i, nid in enumerate(node_ids):
        v = str(nid)
        pv = pos.get(v)
        if pv is None:
            continue
        candidates: list[dict] = []
        for j, other in enumerate(node_ids):
            if i == j:
                continue
            u = str(other)
            pu = pos.get(u)
            if pu is None:
                continue
            dx = pv[0] - pu[0]
            dy = pv[1] - pu[1]
            candidates.append({"id": u, "dist": math.sqrt(dx * dx + dy * dy)})
        candidates.sort(key=lambda c: c["dist"])
        if candidates:
            nn_by_id[v] = candidates[0]
            if candidates[0]["dist"] > 1e-12:
                ssum += candidates[0]["dist"]
                cnt += 1
        local_k = []
        kk = min(k, len(candidates))
        for c in range(kk):
            local_k.append(candidates[c])
            if candidates[c]["dist"] > 1e-12:
                sum_k += candidates[c]["dist"]
                cnt_k += 1
        knearest_by_id[v] = local_k
    return {
        "nnById": nn_by_id,
        "meanDist": (ssum / cnt) if cnt > 0 else 0.0,
        "knearestById": knearest_by_id,
        "meanKDist": (sum_k / cnt_k) if cnt_k > 0 else 0.0,
    }


def _evaluate_spacing_quality(node_ids, edge_pairs, pos):
    if geo.has_position_crossings(pos, edge_pairs):
        return None
    score = metric_mod.compute_spacing_uniformity_score(node_ids, pos)
    if not score or not score.get("ok") or not math.isfinite(score["score"]):
        return None
    return score["score"]


def _run_iteration(state: dict, iter_: int) -> dict:
    state["performedIters"] = iter_
    accepted = 0
    rejected = 0
    uniformity_boost = 1 + 2.0 * (iter_ / max(1, state["maxIters"]))
    nn_data = _compute_nearest_neighbor_data(state["nodeIds"], state["pos"], state["kNearest"])
    nn_by_id = nn_data["nnById"]
    mean_nn_dist = nn_data["meanDist"]
    knearest_by_id = nn_data["knearestById"]
    mean_k_dist = nn_data["meanKDist"]
    scale_len = max(state["targetLength"], 1e-6)

    for v_id in state["movable"]:
        pv0 = state["pos"].get(v_id)
        if pv0 is None:
            continue
        fx = 0.0
        fy = 0.0
        ngh = state["adjOrig"].get(v_id, [])
        for u_raw in ngh:
            u_id = str(u_raw)
            pu0 = state["pos"].get(u_id)
            if pu0 is None:
                continue
            rdx = pv0[0] - pu0[0]
            rdy = pv0[1] - pu0[1]
            rlen = math.sqrt(rdx * rdx + rdy * rdy)
            if rlen < 1e-12:
                continue
            coeff_s = 2 * (rlen - state["targetLength"]) / (rlen + state["repEps"])
            fx += -state["beta"] * (coeff_s * rdx)
            fy += -state["beta"] * (coeff_s * rdy)

        for o_raw in state["nodeIds"]:
            o_id = str(o_raw)
            if o_id == v_id:
                continue
            po = state["pos"].get(o_id)
            if po is None:
                continue
            dx = pv0[0] - po[0]
            dy = pv0[1] - po[1]
            dxn = dx / scale_len
            dyn = dy / scale_len
            d2 = dxn * dxn + dyn * dyn
            if d2 < 1e-18:
                continue
            denom = (d2 + state["repEps"]) ** (state["repPower"] / 2 + 1)
            coeff_r = state["repPower"] / denom
            fx += state["alpha"] * coeff_r * dxn
            fy += state["alpha"] * coeff_r * dyn

        if state["eta"] > 0 and mean_nn_dist > 1e-9 and v_id in nn_by_id:
            nn = nn_by_id[v_id]
            pn = state["pos"].get(nn["id"])
            if pn is not None and nn["dist"] > 1e-12:
                vx = pv0[0] - pn[0]
                vy = pv0[1] - pn[1]
                inv = 1 / nn["dist"]
                ux = vx * inv
                uy = vy * inv
                delta = mean_nn_dist - nn["dist"]
                delta_cap = 0.8 * mean_nn_dist
                delta = max(-delta_cap, min(delta_cap, delta))
                fx += (state["eta"] * uniformity_boost) * delta * ux
                fy += (state["eta"] * uniformity_boost) * delta * uy

        if state["zeta"] > 0 and mean_k_dist > 1e-9 and v_id in knearest_by_id and knearest_by_id[v_id]:
            knn = knearest_by_id[v_id]
            for kn in knn:
                pk = state["pos"].get(kn["id"])
                if pk is None or not (kn["dist"] > 1e-12):
                    continue
                kvx = pv0[0] - pk[0]
                kvy = pv0[1] - pk[1]
                kinv = 1 / kn["dist"]
                kux = kvx * kinv
                kuy = kvy * kinv
                kdelta = mean_k_dist - kn["dist"]
                kcap = 0.7 * mean_k_dist
                kdelta = max(-kcap, min(kcap, kdelta))
                fx += (state["zeta"] * uniformity_boost) * kdelta * kux
                fy += (state["zeta"] * uniformity_boost) * kdelta * kuy

        if state["collisionBoost"] > 0 and mean_nn_dist > 1e-9 and v_id in knearest_by_id:
            threshold = 0.75 * mean_nn_dist
            knn2 = knearest_by_id[v_id]
            for nbr in knn2:
                if not (nbr["dist"] > 1e-12) or nbr["dist"] >= threshold:
                    continue
                pnb = state["pos"].get(nbr["id"])
                if pnb is None:
                    continue
                bdx = pv0[0] - pnb[0]
                bdy = pv0[1] - pnb[1]
                binv = 1 / nbr["dist"]
                bux = bdx * binv
                buy = bdy * binv
                strength = (state["collisionBoost"] * uniformity_boost) * ((threshold - nbr["dist"]) / max(threshold, 1e-9))
                fx += strength * bux
                fy += strength * buy

        f_norm = math.sqrt(fx * fx + fy * fy)
        if f_norm > state["maxForce"]:
            s = state["maxForce"] / f_norm
            fx *= s
            fy *= s

        candidate = (pv0[0] + state["h"] * fx, pv0[1] + state["h"] * fy)

        if _would_introduce_crossing(v_id, candidate, state["pos"], state["edgePairs"], state["adjOrig"], state["EPS"]):
            rejected += 1
            continue
        state["pos"][v_id] = candidate
        accepted += 1

    state["acceptedTotal"] += accepted
    state["rejectedTotal"] += rejected
    return {"accepted": accepted, "rejected": rejected}


def _build_result(state: dict, layout_input: dict) -> dict:
    # Filter positions to the original (non-augmented) node set; JS mock-cy
    # silently drops writes to dummy ids, so we do the same here.
    pos_full = state["bestPos"] or state["pos"]
    pos = geo.filter_position_map(pos_full, state["origNodeIds"])
    return gu.build_layout_result({
        "nodeIds": state["origNodeIds"],
        "edgePairs": state["origEdgePairs"],
        "outerFace": state["outerFace"],
        "graph": state["origGraph"],
        "augmented": layout_input["augmented"],
        "positions": pos,
        "stopReason": state["stopReason"],
        "iters": state["performedIters"],
        "accepted": state["acceptedTotal"],
        "rejected": state["rejectedTotal"],
        "spacingScore": state["bestScore"] if math.isfinite(state["bestScore"]) else None,
    })


def _update_best(state: dict, eval_every: int) -> None:
    it = state["performedIters"]
    if not (it % eval_every == 0 or it == 1 or it == state["maxIters"]):
        return
    q = _evaluate_spacing_quality(state["nodeIds"], state["edgePairs"], state["pos"])
    if q is not None and math.isfinite(q) and q > state["bestScore"]:
        state["bestScore"] = q
        state["bestPos"] = geo.copy_position_map(state["pos"])


def _run_iterations(state: dict, layout_input: dict, movement_tracker) -> dict:
    eval_every = FORCE_DIR_CONFIG["evalEvery"]
    movable = state["movable"]
    for it in range(1, state["maxIters"] + 1):
        if state["h"] < state["hMin"]:
            state["stopReason"] = "step-too-small"
            break
        prev = geo.copy_position_map(state["pos"])
        step = _run_iteration(state, it)
        rejected = step["rejected"]
        move_stats = gu.compute_position_move_stats(movable, prev, state["pos"], {"moveTol": 1e-9})
        movement_status = movement_tracker.update(
            {"maxMove": move_stats.max_move, "avgMove": move_stats.avg_move}, it
        )
        if len(movable) > 0 and rejected > len(movable) * 0.5:
            state["h"] *= state["gamma"]
        if movement_status.converged:
            state["stopReason"] = movement_status.reason or "movement-converged"
            break
        if it % state["alphaGrowEvery"] == 0 and state["alpha"] < state["alphaCap"]:
            state["alpha"] = min(state["alphaCap"], state["alpha"] * state["alphaGrowFactor"])
        _update_best(state, eval_every)
    return _build_result(state, layout_input)


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    layout_input = preprocessing.prepare_graph_and_layout_data(graph, {
        "failureLabel": "ForceDir",
        "augmentationMethod": opts.get("augmentationMethod"),
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "ForceDir failed"})

    orig_graph = layout_input["graph"]
    # ForceDir runs on the augmented graph (JS uses layoutInput.graph which is
    # the prepared+augmented one in cy-runtime). But the 'graph' field of
    # prepare_graph_and_layout_data is the ORIGINAL graph. Checking JS: the
    # runtime's computeOptions.graph is graphFromCy(cy) which is the pre-augment
    # graph minus dummy nodes. So ForceDir iterates over the original nodes and
    # edges only, with the augmented positions as initial seed.
    base_graph = orig_graph
    ids = list(base_graph.node_ids)
    pairs = list(base_graph.edge_pairs)
    if len(pairs) < 3:
        return gu.build_layout_error({"message": "ForceDir requires at least 3 edges", "graph": base_graph})
    outer_face = layout_input["outerFace"]
    # posById from preprocessing includes augmented dummies; restrict to orig nodes.
    pos = geo.filter_position_map(layout_input["posById"], ids)
    movable = gu.collect_movable_vertices(ids, outer_face)

    lengths: list[float] = []
    for (u_raw, v_raw) in pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos.get(u)
        pv = pos.get(v)
        if pu is None or pv is None:
            continue
        dx0 = pu[0] - pv[0]
        dy0 = pu[1] - pv[1]
        l0 = math.sqrt(dx0 * dx0 + dy0 * dy0)
        if l0 > 1e-9:
            lengths.append(l0)
    target_length = _median(lengths)
    diameter = geo.compute_drawing_diameter(ids, pos)
    h = max(1e-8, FORCE_DIR_CONFIG["initialStepFactor"] * diameter)
    h_min = max(1e-10, FORCE_DIR_CONFIG["minStepFactor"] * diameter)
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": FORCE_DIR_CONFIG["minItersBeforeStop"],
        "stableIterLimit": FORCE_DIR_CONFIG["stableIterLimit"],
        "maxMoveTol": FORCE_DIR_CONFIG["movementStopTolFactor"] * diameter,
        "avgMoveTol": FORCE_DIR_CONFIG["avgMovementStopTolFactor"] * diameter,
    })

    state = {
        "origGraph": orig_graph,
        "origNodeIds": ids,
        "origEdgePairs": pairs,
        "EPS": FORCE_DIR_CONFIG["epsilon"],
        "repEps": FORCE_DIR_CONFIG["repulsionEps"],
        "repPower": FORCE_DIR_CONFIG["repulsionPower"],
        "maxIters": FORCE_DIR_CONFIG["maxIters"],
        "beta": FORCE_DIR_CONFIG["beta"],
        "alpha": FORCE_DIR_CONFIG["alpha"],
        "alphaGrowEvery": FORCE_DIR_CONFIG["alphaGrowEvery"],
        "alphaGrowFactor": FORCE_DIR_CONFIG["alphaGrowFactor"],
        "alphaCap": FORCE_DIR_CONFIG["alphaCap"],
        "gamma": FORCE_DIR_CONFIG["stepDecay"],
        "maxForce": FORCE_DIR_CONFIG["maxForce"],
        "eta": FORCE_DIR_CONFIG["eta"],
        "zeta": FORCE_DIR_CONFIG["zeta"],
        "collisionBoost": FORCE_DIR_CONFIG["collisionBoost"],
        "kNearest": FORCE_DIR_CONFIG["kNearest"],
        "graph": base_graph,
        "nodeIds": ids,
        "edgePairs": pairs,
        "outerFace": outer_face,
        "pos": pos,
        "adjOrig": base_graph.adjacency,
        "movable": movable,
        "targetLength": target_length,
        "h": h,
        "hMin": h_min,
        "acceptedTotal": 0,
        "rejectedTotal": 0,
        "performedIters": 0,
        "bestScore": -math.inf,
        "bestPos": None,
        "stopReason": "max-iters",
    }
    result = _run_iterations(state, layout_input, movement_tracker)
    if result.get("ok"):
        result["message"] = gu.build_layout_status_message("ForceDir", {
            "iters": result.get("iters"),
            "accepted": result.get("accepted"),
            "rejected": result.get("rejected"),
            "stopReason": result.get("stopReason"),
        })
    return result
