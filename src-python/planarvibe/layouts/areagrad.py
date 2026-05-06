"""AreaGrad layout (gradient-based equal-area). Port of static/js/layout-areagrad.js."""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import planar_graph as pg
from .. import preprocessing

AREAGRAD_INTERNAL = {
    "tolGrad": 1e-8,
    "acceptanceTol": 1e-12,
    "minTriangleAreaRel": 1e-10,
    "maxIters": 200,
    "maxVertexMoveRel": 0.08,
    "localDamping": 1e-3,
    "stepShrink": 0.5,
    "minStepScale": 2 ** -20,
    "tolAreaPositive": 1e-12,
    "tolAreaGlobal": 1e-3,
}


def _build_area_grad_data(augmented_embedding, outer_face, pos_by_id) -> dict:
    incident_by_vertex: dict[str, list[dict]] = {str(x): [] for x in augmented_embedding["idByIndex"]}
    triangles: list[dict] = []
    outer_index = pg.find_outer_face_index(augmented_embedding.get("faces") or [], outer_face)
    for i, face in enumerate(augmented_embedding["faces"]):
        if not face or len(face) < 3:
            return gu.build_layout_error({"reason": "AreaGrad requires a valid triangulated augmentation"})
        if i == outer_index:
            continue
        oriented = geo.orient_face_ccw(face, pos_by_id)
        if len(oriented) != 3:
            return gu.build_layout_error({"reason": "AreaGrad requires all bounded faces of H to be triangles"})
        tri_index = len(triangles)
        triangles.append({"vertices": oriented})
        for j in range(3):
            vid = str(oriented[j])
            if vid not in incident_by_vertex:
                incident_by_vertex[vid] = []
            incident_by_vertex[vid].append({"triangleIndex": tri_index, "slot": j})

    if not triangles:
        return gu.build_layout_result({
            "outerFace": [str(x) for x in outer_face],
            "incidentTrianglesByVertex": incident_by_vertex,
            "triangles": triangles,
            "targetTriangleArea": 0,
        })

    outer_area = abs(geo.polygon_area2(outer_face, pos_by_id)) / 2
    if not (outer_area > 1e-12):
        return gu.build_layout_error({"reason": "AreaGrad initialization failed: outer face has zero area"})
    return gu.build_layout_result({
        "outerFace": [str(x) for x in outer_face],
        "incidentTrianglesByVertex": incident_by_vertex,
        "triangles": triangles,
        "targetTriangleArea": outer_area / len(triangles),
    })


def _add_triangle_gradient_for_slot(grad: list[float], slot: int, a, b, c, coeff: float) -> None:
    if coeff == 0:
        return
    if slot == 0:
        grad[0] += coeff * 0.5 * (b[1] - c[1])
        grad[1] += coeff * 0.5 * (c[0] - b[0])
    elif slot == 1:
        grad[0] += coeff * 0.5 * (c[1] - a[1])
        grad[1] += coeff * 0.5 * (a[0] - c[0])
    elif slot == 2:
        grad[0] += coeff * 0.5 * (a[1] - b[1])
        grad[1] += coeff * 0.5 * (b[0] - a[0])


def _incident_triangles_stay_positive(vertex_id, area_grad_data, pos_by_id, tol_area_positive) -> bool:
    entries = area_grad_data["incidentTrianglesByVertex"].get(vertex_id, [])
    for entry in entries:
        tri = area_grad_data["triangles"][entry["triangleIndex"]]
        a = pos_by_id.get(tri["vertices"][0])
        b = pos_by_id.get(tri["vertices"][1])
        c = pos_by_id.get(tri["vertices"][2])
        if a is None or b is None or c is None:
            return False
        if not (geo.triangle_area2(a, b, c) / 2 > tol_area_positive):
            return False
    return True


def _effective_min_triangle_area(area_grad_data, opts) -> float:
    target = area_grad_data.get("targetTriangleArea") if area_grad_data else 0
    if not isinstance(target, (int, float)) or not math.isfinite(target):
        target = 0
    base = opts.get("tolAreaPositive", 0) if opts else 0
    if not isinstance(base, (int, float)) or not math.isfinite(base):
        base = 0
    return max(base, AREAGRAD_INTERNAL["minTriangleAreaRel"] * max(target, 0))


def _compute_triangle_residuals(area_grad_data, pos_by_id, tol_area_positive) -> dict:
    triangles = area_grad_data.get("triangles") or []
    residuals = [0.0] * len(triangles)
    areas = [0.0] * len(triangles)
    energy = 0.0
    max_rel = 0.0
    target = area_grad_data["targetTriangleArea"]
    for i, tri in enumerate(triangles):
        a = pos_by_id.get(tri["vertices"][0])
        b = pos_by_id.get(tri["vertices"][1])
        c = pos_by_id.get(tri["vertices"][2])
        if a is None or b is None or c is None:
            return gu.build_layout_error({"reason": "missing_triangle_vertex"})
        area = geo.triangle_area2(a, b, c) / 2
        if not (area > tol_area_positive):
            return gu.build_layout_error({"reason": "triangle_nonpositive"})
        rel = area / target - 1
        residuals[i] = rel
        areas[i] = area
        energy += rel * rel
        if abs(rel) > max_rel:
            max_rel = abs(rel)
    return gu.build_layout_result({
        "residuals": residuals,
        "areas": areas,
        "areaEnergy": energy,
        "maxRelError": max_rel,
    })


def _compute_area_grad_state(area_grad_data, pos_by_id, opts) -> dict:
    r = _compute_triangle_residuals(area_grad_data, pos_by_id, _effective_min_triangle_area(area_grad_data, opts))
    if not r.get("ok"):
        return r
    return gu.build_layout_result({
        "objective": r["areaEnergy"],
        "areaEnergy": r["areaEnergy"],
        "residuals": r["residuals"],
        "maxRelError": r["maxRelError"],
        "rmsRelError": math.sqrt(r["areaEnergy"] / len(area_grad_data["triangles"])) if area_grad_data["triangles"] else 0,
    })


def _compute_local_delta(vertex_id, area_grad_data, pos_by_id, residuals, opts) -> dict:
    entries = area_grad_data["incidentTrianglesByVertex"].get(vertex_id, [])
    if not entries:
        return {"x": 0, "y": 0, "norm": 0}
    h00 = opts["localDamping"]
    h01 = 0.0
    h11 = opts["localDamping"]
    b0 = 0.0
    b1 = 0.0
    inv_target = 1 / max(area_grad_data["targetTriangleArea"], 1e-18)

    for entry in entries:
        tri = area_grad_data["triangles"][entry["triangleIndex"]]
        a = pos_by_id.get(tri["vertices"][0])
        b = pos_by_id.get(tri["vertices"][1])
        c = pos_by_id.get(tri["vertices"][2])
        if a is None or b is None or c is None:
            continue
        local_grad = [0.0, 0.0]
        _add_triangle_gradient_for_slot(local_grad, entry["slot"], a, b, c, inv_target)
        gx = local_grad[0]
        gy = local_grad[1]
        r = residuals[entry["triangleIndex"]] if residuals and entry["triangleIndex"] < len(residuals) else 0
        h00 += gx * gx
        h01 += gx * gy
        h11 += gy * gy
        b0 += -r * gx
        b1 += -r * gy

    det = h00 * h11 - h01 * h01
    if not (det > 1e-18):
        return {"x": 0, "y": 0, "norm": 0}
    dx = (h11 * b0 - h01 * b1) / det
    dy = (h00 * b1 - h01 * b0) / det
    norm = math.hypot(dx, dy)
    if norm > opts["maxVertexMove"] and opts["maxVertexMove"] > 0:
        scale = opts["maxVertexMove"] / norm
        dx *= scale
        dy *= scale
        norm = opts["maxVertexMove"]
    return {"x": dx, "y": dy, "norm": norm}


def _max_incident_residual(vertex_id, area_grad_data, residuals):
    entries = area_grad_data["incidentTrianglesByVertex"].get(vertex_id, [])
    worst = 0.0
    for entry in entries:
        r = residuals[entry["triangleIndex"]] if entry["triangleIndex"] < len(residuals) else 0
        if abs(r) > worst:
            worst = abs(r)
    return worst


def _build_settings(options):
    raw = options or {}
    return {
        "augmentationMethod": raw.get("augmentationMethod"),
        "augmentationOptions": (dict(raw["augmentationOptions"])
                                if isinstance(raw.get("augmentationOptions"), dict) else None),
        "currentPositions": raw.get("currentPositions"),
        "maxIters": AREAGRAD_INTERNAL["maxIters"],
        "maxVertexMoveRel": AREAGRAD_INTERNAL["maxVertexMoveRel"],
        "localDamping": AREAGRAD_INTERNAL["localDamping"],
        "stepShrink": AREAGRAD_INTERNAL["stepShrink"],
        "minStepScale": AREAGRAD_INTERNAL["minStepScale"],
        "tolAreaPositive": AREAGRAD_INTERNAL["tolAreaPositive"],
        "tolAreaGlobal": AREAGRAD_INTERNAL["tolAreaGlobal"],
    }


def _build_state_from_prepared(context, options):
    settings = _build_settings(options)
    if not context or not context.get("ok"):
        return gu.build_layout_error(context or {"message": "AreaGrad setup failed"})
    area_grad = _build_area_grad_data(context["augmented"]["embedding"], context["augmentedOuterFace"], context["posById"])
    if not area_grad.get("ok"):
        return gu.build_layout_error({"message": area_grad.get("reason") or "AreaGrad setup failed"})
    if not area_grad["triangles"]:
        return gu.build_layout_result({
            "opts": settings,
            "graph": context["graph"],
            "baseEmbedding": context["baseEmbedding"],
            "outerFace": context["augmentedOuterFace"],
            "augmented": context["augmented"],
            "posById": context["posById"],
            "areaGradData": area_grad,
            "movableVertices": [],
        })
    min_area = _effective_min_triangle_area(area_grad, settings)
    for tri in area_grad["triangles"]:
        a = context["posById"].get(tri["vertices"][0])
        b = context["posById"].get(tri["vertices"][1])
        c = context["posById"].get(tri["vertices"][2])
        area = geo.triangle_area2(a, b, c) / 2 if (a and b and c) else 0
        if not (area > min_area):
            return gu.build_layout_error({"message": "AreaGrad initialization failed: degenerate augmented triangle"})
    return gu.build_layout_result({
        "opts": settings,
        "graph": context["graph"],
        "baseEmbedding": context["baseEmbedding"],
        "outerFace": context["augmentedOuterFace"],
        "augmented": context["augmented"],
        "posById": context["posById"],
        "areaGradData": area_grad,
        "movableVertices": context["movableVertices"],
    })


def _run_iterations(layout_input, options):
    g = layout_input["graph"]
    pos_by_id = layout_input["posById"]
    area_grad = layout_input["areaGradData"]
    movable = layout_input["movableVertices"] or []
    outer_diameter = geo.outer_face_diameter(pos_by_id, layout_input["outerFace"])
    options["maxVertexMove"] = options["maxVertexMoveRel"] * outer_diameter
    options["minTriangleArea"] = _effective_min_triangle_area(area_grad, options)
    status = "max_iters"
    state = _compute_area_grad_state(area_grad, pos_by_id, options)
    if not state.get("ok"):
        return gu.build_layout_error({
            "ok": False, "status": "invalid",
            "reason": state.get("reason") or "AreaGrad initialization failed",
        })
    if state["maxRelError"] <= options["tolAreaGlobal"]:
        status = "realized"
    iter_ = 0
    for iter_ in range(1, options["maxIters"] + 1):
        if status != "max_iters":
            break
        prev = geo.copy_position_map(pos_by_id)
        accepted = 0
        residuals = state.get("residuals") or []
        sweep_vertices = sorted(
            movable,
            key=lambda v: -_max_incident_residual(v, area_grad, residuals),
        )
        for vid in sweep_vertices:
            delta = _compute_local_delta(vid, area_grad, pos_by_id, state.get("residuals") or [], options)
            if not (delta["norm"] > AREAGRAD_INTERNAL["tolGrad"]):
                continue
            base_pos = pos_by_id.get(vid)
            if base_pos is None:
                continue
            step_scale = 1.0
            while step_scale >= options["minStepScale"]:
                dx = step_scale * delta["x"]
                dy = step_scale * delta["y"]
                pos_by_id[vid] = (base_pos[0] + dx, base_pos[1] + dy)
                if not _incident_triangles_stay_positive(vid, area_grad, pos_by_id, options["minTriangleArea"]):
                    pos_by_id[vid] = base_pos
                    step_scale *= options["stepShrink"]
                    continue
                trial = _compute_area_grad_state(area_grad, pos_by_id, options)
                if trial.get("ok") and trial["objective"] <= state["objective"] - AREAGRAD_INTERNAL["acceptanceTol"] * max(1, state["objective"]):
                    state = trial
                    accepted += 1
                    break
                pos_by_id[vid] = base_pos
                step_scale *= options["stepShrink"]
        if state["maxRelError"] <= options["tolAreaGlobal"]:
            status = "realized"
            break
        if accepted == 0:
            status = "stalled"
            break
    has_crossings = geo.has_position_crossings(pos_by_id, g.edge_pairs)
    return {
        "ok": not has_crossings,
        "status": status,
        "positions": pos_by_id,
        "stats": state,
        "iters": min(options["maxIters"], max(0, iter_ - (1 if status == "max_iters" else 0))),
        "boundedFaceCount": len(area_grad["triangles"]),
        "dummyCount": layout_input["augmented"].get("dummyCount") if layout_input.get("augmented") else 0,
        "hasCrossings": has_crossings,
    }


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    settings = _build_settings(options)
    layout_input = preprocessing.prepare_graph_and_layout_data(graph, {
        "failureLabel": "AreaGrad layout",
        "augmentationMethod": settings["augmentationMethod"],
        "augmentationOptions": settings["augmentationOptions"],
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "AreaGrad failed"})

    state = _build_state_from_prepared(layout_input, options)
    if not state.get("ok"):
        return state

    if not state["areaGradData"]["triangles"]:
        final_pos = geo.filter_position_map(state["posById"], state["graph"].node_ids)
        return gu.build_layout_result({
            "status": "realized",
            "positions": final_pos,
            "graph": state["graph"],
            "outerFace": state["outerFace"],
            "augmented": state["augmented"],
            "boundedFaceCount": 0,
            "dummyCount": state["augmented"].get("dummyCount"),
            "iters": 0,
            "maxRelError": 0,
            "faceAreaScore": None,
        })

    result = _run_iterations(state, state["opts"])
    if not result["ok"] and result.get("reason"):
        return gu.build_layout_error({
            "status": result["status"],
            "graph": state["graph"],
            "outerFace": state["outerFace"],
            "augmented": state["augmented"],
            "message": result["reason"],
        })
    if result["hasCrossings"]:
        return gu.build_layout_error({
            "status": result["status"],
            "graph": state["graph"],
            "outerFace": state["outerFace"],
            "augmented": state["augmented"],
            "message": "AreaGrad produced a non-plane drawing",
        })

    face_score = metric_mod.compute_uniform_face_area_score(
        state["graph"].node_ids, state["graph"].edge_pairs, state["posById"], state["baseEmbedding"]
    )
    last_stats = result["stats"] or {}
    final_pos = geo.filter_position_map(state["posById"], state["graph"].node_ids)
    max_rel = last_stats.get("maxRelError") if isinstance(last_stats.get("maxRelError"), (int, float)) and math.isfinite(last_stats.get("maxRelError")) else None

    res = gu.build_layout_result({
        "status": result["status"],
        "positions": final_pos,
        "graph": state["graph"],
        "outerFace": state["outerFace"],
        "augmented": state["augmented"],
        "iters": result["iters"],
        "faceAreaScore": face_score.get("quality") if face_score.get("ok") else None,
        "maxRelError": max_rel,
        "boundedFaceCount": len(state["areaGradData"]["triangles"]),
        "dummyCount": state["augmented"].get("dummyCount"),
    })
    res["message"] = gu.build_layout_status_message("AreaGrad", {
        "boundedFaceCount": res["boundedFaceCount"],
        "dummyCount": res["dummyCount"],
        "status": res["status"],
        "maxRelError": res["maxRelError"],
        "faceAreaScore": res["faceAreaScore"],
    })
    return res
