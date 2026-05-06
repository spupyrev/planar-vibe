"""Reweight layout (iterative barycentric reweighting for equal face areas).

Literal port of static/js/layout-reweight.js.
"""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import planar_graph as pg
from .. import preprocessing
from . import tutte

REWEIGHT_CONFIG = {
    "maxOuterIters": 8,
    "pressureStep": 0.16,
    "pressureClamp": 1.20,
    "pressureBeta": 0.18,
    "pressureDeltaClamp": 0.75,
    "scaleMin": 0.25,
    "scaleMax": 10.0,
    "pressureScaleMin": 1.0,
    "pressureScaleMax": 1.25,
    "minItersBeforeStop": 8,
    "stableIterLimit": 4,
}


def _solve_weighted(state: dict, weights: dict) -> dict:
    return tutte.compute_barycentric_positions(
        state["augmented"]["graph"],
        state["outerFace"],
        {
            "adjacency": state["adj"],
            "weights": weights,
            "initOptions": tutte.default_outer_placement_options({
                "fixedOuterPos": state["fixedOuterPos"],
            }),
        },
    )


def _build_edge_to_face_map(faces: list[list[str]]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for i, face in enumerate(faces):
        n = len(face)
        for j in range(n):
            u = str(face[j])
            v = str(face[(j + 1) % n])
            k = gu.edge_key(u, v)
            out.setdefault(k, []).append(i)
    return out


def _update_face_pressures(state: dict, face_areas: list[float], face_pressure: list[float]) -> list[float]:
    opts = state["opts"]
    bounded_face_idx = state["boundedFaceIdx"]
    nxt = list(face_pressure)
    ssum = 0.0
    cnt = 0
    for fi in bounded_face_idx:
        area = face_areas[fi]
        if not math.isfinite(area) or not (area > 1e-12):
            continue
        delta = math.log(max(state["desired"], 1e-12) / max(area, 1e-12))
        delta = max(-opts["pressureDeltaClamp"], min(opts["pressureDeltaClamp"], delta))
        p = nxt[fi] + opts["pressureStep"] * delta
        p = max(-opts["pressureClamp"], min(opts["pressureClamp"], p))
        nxt[fi] = p
        ssum += p
        cnt += 1
    mean = (ssum / cnt) if cnt > 0 else 0.0
    if cnt > 0 and abs(mean) > 1e-12:
        for fi in bounded_face_idx:
            nxt[fi] -= mean
    return nxt


def _adjust_weights(state: dict, face_areas: list[float], old_weights: dict, face_pressure: list[float]) -> dict:
    edge_pairs = state["augmented"]["graph"].edge_pairs
    outer_set = {str(x) for x in state["outerFace"]}
    opts = state["opts"]
    new_weights: dict[str, float] = {}
    sum_w = 0.0
    cnt = 0

    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        k = gu.edge_key(u, v)
        w_old = old_weights.get(k)
        if not isinstance(w_old, (int, float)) or not math.isfinite(w_old) or w_old <= 0:
            w_old = 1.0

        if u in outer_set and v in outer_set:
            new_weights[k] = w_old
            continue

        faces_idx = state["e2f"].get(k, [])
        area_sum = 0.0
        area_cnt = 0
        for fi in faces_idx:
            a = face_areas[fi]
            if math.isfinite(a) and a > 0:
                area_sum += a
                area_cnt += 1
        if area_cnt == 0:
            new_weights[k] = w_old
            sum_w += new_weights[k]
            cnt += 1
            continue

        penalty = (area_sum / area_cnt) / max(state["desired"], 1e-12)
        scale = math.sqrt(penalty) if penalty > 1 else penalty
        scale = max(opts["scaleMin"], min(opts["scaleMax"], scale))

        p_sum = 0.0
        p_cnt = 0
        for fi in faces_idx:
            if fi not in state["boundedSet"]:
                continue
            p = face_pressure[fi]
            if math.isfinite(p):
                p_sum += p
                p_cnt += 1
        if p_cnt > 0 and opts["pressureBeta"] > 0:
            pressure_scale = math.exp(-opts["pressureBeta"] * (p_sum / p_cnt))
            pressure_scale = max(opts["pressureScaleMin"], min(opts["pressureScaleMax"], pressure_scale))
            scale *= pressure_scale

        w_new = w_old * scale
        w_new = max(1e-4, min(1e4, w_new))
        new_weights[k] = w_new
        sum_w += w_new
        cnt += 1

    avg = (sum_w / cnt) if cnt > 0 else 1.0
    if not (avg > 0):
        avg = 1.0
    for (u_raw, v_raw) in edge_pairs:
        ek = gu.edge_key(u_raw, v_raw)
        new_weights[ek] = (new_weights.get(ek, 1.0)) / avg

    return new_weights


def _compute_face_area_iteration_stats(face_areas: list[float], bounded_face_idx: list[int]) -> dict | None:
    values: list[float] = []
    for fi in bounded_face_idx:
        area = face_areas[fi]
        if math.isfinite(area) and area > 1e-12:
            values.append(area)
    if not values:
        return None
    total = sum(values)
    if not (total > 0):
        return None
    values = [v / total for v in values]
    values.sort()
    ideal = 1 / len(values)
    score = metric_mod.compute_distribution_quality(values)
    return {
        "score": score if (score is not None and math.isfinite(score)) else None,
        "minRatio": values[0] / ideal,
        "maxRatio": values[-1] / ideal,
        "faceCount": len(values),
    }


def _build_reweight_settings(options: dict | None) -> dict:
    raw = options or {}
    return {
        "augmentationMethod": raw.get("augmentationMethod"),
        "currentPositions": raw.get("currentPositions"),
        "onIteration": raw.get("onIteration") if callable(raw.get("onIteration")) else None,
        **REWEIGHT_CONFIG,
    }


def _build_reweight_state_from_prepared(context: dict, options: dict) -> dict:
    settings = _build_reweight_settings(options)
    if not context or not context.get("ok"):
        return gu.build_layout_error(context or {"message": "Reweight setup failed"})

    g = context["graph"]
    outer = context["augmentedOuterFace"]
    augmented = context["augmented"]
    emb_aug = augmented["embedding"]
    faces = emb_aug.get("faces") or []
    outer_face_idx = pg.find_outer_face_index(faces, outer)
    if outer_face_idx < 0 or not outer or len(outer) < 3:
        return gu.build_layout_error({
            "message": "Shared initialization produced an invalid augmented outer face",
            "graph": g,
            "augmented": augmented,
        })
    bounded_face_idx = [i for i in range(len(faces)) if i != outer_face_idx]
    if not bounded_face_idx:
        return gu.build_layout_error({
            "message": "No bounded faces", "graph": g, "outerFace": outer, "augmented": augmented,
        })

    e2f = _build_edge_to_face_map(faces)
    weights: dict[str, float] = {}
    for (u, v) in augmented["graph"].edge_pairs:
        weights[gu.edge_key(u, v)] = 1.0
    face_pressure = [0.0] * len(faces)
    bounded_set = set(bounded_face_idx)
    desired = 1 / len(bounded_face_idx)
    fixed_outer_pos = geo.filter_position_map(context["posById"], outer)
    current_pos = context["posById"]
    movable_vertices = gu.collect_movable_vertices(augmented["graph"].node_ids, outer)
    movement_scale = geo.compute_drawing_diameter(augmented["graph"].node_ids, current_pos)
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": settings["minItersBeforeStop"],
        "stableIterLimit": settings["stableIterLimit"],
        "maxMoveTol": 1e-4 * movement_scale,
        "avgMoveTol": 2e-5 * movement_scale,
    })

    return {
        "ok": True,
        "opts": settings,
        "graph": g,
        "outerFace": outer,
        "augmented": augmented,
        "faces": faces,
        "boundedFaceIdx": bounded_face_idx,
        "adj": augmented["graph"].adjacency,
        "e2f": e2f,
        "weights": weights,
        "facePressure": face_pressure,
        "boundedSet": bounded_set,
        "desired": desired,
        "fixedOuterPos": fixed_outer_pos,
        "currentPos": current_pos,
        "initIters": context.get("initResult", {}).get("iters", 0) or 0,
        "movableVertices": movable_vertices,
        "movementTracker": movement_tracker,
    }


def _run_reweight_iterations(state: dict, options: dict) -> dict:
    outer = state["outerFace"]
    augmented = state["augmented"]
    faces = state["faces"]
    bounded_face_idx = state["boundedFaceIdx"]
    weights = state["weights"]
    face_pressure = state["facePressure"]
    current_pos = state["currentPos"]
    total_inner_iters = state.get("initIters") or 0
    stop_reason = "max-iters"
    performed_outer_iters = 0
    final_iteration_stats = None

    for it in range(options["maxOuterIters"]):
        prev_pos = current_pos
        inner = _solve_weighted(state, weights)
        total_inner_iters += (inner.get("iters") or 0)
        performed_outer_iters = it + 1

        pos = inner["positions"]
        current_pos = pos
        move_stats = gu.compute_position_move_stats(state["movableVertices"], prev_pos, pos, {"moveTol": 1e-9})
        movement_status = state["movementTracker"].update(
            {"maxMove": move_stats.max_move, "avgMove": move_stats.avg_move},
            it + 1,
        )

        outer_area = geo.polygon_area_abs(outer, pos)
        if not (outer_area > 1e-12):
            outer_area = 1.0
        face_areas: list[float] = [geo.polygon_area_abs(f, pos) / outer_area for f in faces]
        iter_stats = _compute_face_area_iteration_stats(face_areas, bounded_face_idx)
        final_iteration_stats = iter_stats

        face_pressure = _update_face_pressures(state, face_areas, face_pressure)
        weights = _adjust_weights(state, face_areas, weights, face_pressure)

        if movement_status.converged:
            stop_reason = movement_status.reason or "movement-converged"
            break

    final_layout = _solve_weighted(state, weights)
    total_inner_iters += (final_layout.get("iters") or 0)
    final_positions = geo.filter_position_map(final_layout["positions"], state["graph"].node_ids)

    return gu.build_layout_result({
        "graph": state["graph"],
        "outerFace": outer,
        "augmented": augmented,
        "positions": final_positions,
        "debugPositions": final_layout["positions"],
        "iters": total_inner_iters,
        "stopReason": stop_reason,
        "outerSteps": performed_outer_iters,
        "faceAreaScore": final_iteration_stats["score"] if final_iteration_stats else None,
        "boundedFaceCount": final_iteration_stats["faceCount"] if final_iteration_stats else len(bounded_face_idx),
        "faceAreaMinRatio": final_iteration_stats["minRatio"] if final_iteration_stats else None,
        "faceAreaMaxRatio": final_iteration_stats["maxRatio"] if final_iteration_stats else None,
    })


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    settings = _build_reweight_settings(options)
    prepared = preprocessing.prepare_graph_and_layout_data(graph, {
        "failureLabel": "Reweight",
        "augmentationMethod": settings["augmentationMethod"],
        "currentPositions": initial_positions or {},
    })
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": "Reweight failed"})
    state = _build_reweight_state_from_prepared(prepared, options)
    if not state.get("ok"):
        return state
    result = _run_reweight_iterations(state, state["opts"])
    if result.get("ok"):
        result["message"] = gu.build_layout_status_message("Reweight", {
            "outerFaceVertexCount": len(result["outerFace"]),
            "dummyCount": result["augmented"].get("dummyCount"),
            "iters": result.get("iters"),
            "outerSteps": result.get("outerSteps"),
            "stopReason": result.get("stopReason"),
        })
    return result
