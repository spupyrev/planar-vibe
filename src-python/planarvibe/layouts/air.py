"""Air pressure layout (equal bounded face areas). Port of static/js/layout-air.js."""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import metrics as metric_mod
from .. import preprocessing

AIR_INTERNAL = {
    "maxSweeps": 200,
    "maxNewtonIter": 10,
    "tolForceGlobal": 1e-8,
    "tolForceVertex": 1e-6,
    "tolAreaGlobal": 1e-3,
    "tolAreaPositive": 1e-15,
    "armijo": 1e-4,
    "outerRingFaceWeight": 0.25,
    "minStep": 2 ** -40,
    "moveTolRel": 1e-5,
    "moveTolAbs": 1e-12,
    "errTolRel": 1e-4,
    "patience": 2,
    "deadlockPatience": 2,
    "plateauWindow": 12,
    "plateauPatience": 1,
    "plateauErrTolAbs": None,
    "plateauErrTolRel": None,
    "plateauErrGuardFactor": 20,
}


def _build_air_data(augmented_embedding, outer_face, pos_by_id, original_node_ids) -> dict:
    outer_key = gu.face_key(outer_face)
    outer_edge_set: dict[str, bool] = {}
    outer_vertex_set = {str(x) for x in outer_face}
    original_vertex_set = {str(x) for x in original_node_ids}

    for i in range(len(outer_face)):
        outer_edge_set[gu.edge_key(outer_face[i], outer_face[(i + 1) % len(outer_face)])] = True

    triangles: list[dict] = []
    incident: dict[str, list[dict]] = {str(x): [] for x in augmented_embedding["idByIndex"]}
    outer_ring_triangle_count = 0

    for face in augmented_embedding["faces"]:
        if not face or len(face) < 3:
            return gu.build_layout_error({"reason": "Air requires a valid triangulated augmentation"})

        oriented = geo.orient_face_ccw(face, pos_by_id)
        if gu.face_key(oriented) == outer_key:
            continue
        if len(face) != 3:
            return gu.build_layout_error({"reason": "Air requires all non-outer augmented faces to be triangles"})

        is_outer_ring = False
        for ei in range(len(oriented)):
            if str(oriented[ei]) in outer_vertex_set:
                is_outer_ring = True
                break
            if outer_edge_set.get(gu.edge_key(oriented[ei], oriented[(ei + 1) % len(oriented)])):
                is_outer_ring = True
                break
        if is_outer_ring:
            outer_ring_triangle_count += 1
        is_real_face = all(str(v) in original_vertex_set for v in oriented)

        triangle_index = len(triangles)
        triangles.append({
            "vertices": oriented,
            "targetArea": 0.0,
            "weight": AIR_INTERNAL["outerRingFaceWeight"] if is_outer_ring else 1.0,
            "isOuterRing": is_outer_ring,
            "isRealFace": is_real_face,
        })
        for j in range(3):
            v = str(oriented[j])
            incident[v].append({
                "faceIndex": triangle_index,
                "left": str(oriented[(j + 2) % 3]),
                "right": str(oriented[(j + 1) % 3]),
            })

    if not triangles:
        return gu.build_layout_result({
            "triangles": triangles,
            "incident": incident,
            "targetTriangleArea": 0,
        })

    outer_area = abs(geo.polygon_area2(outer_face, pos_by_id)) / 2
    if not (outer_area > 1e-12):
        return gu.build_layout_error({"reason": "Air initialization failed: outer face has zero area"})
    target_tri_area = outer_area / len(triangles)
    for t in triangles:
        t["targetArea"] = target_tri_area

    return gu.build_layout_result({
        "outerFace": [str(x) for x in outer_face],
        "triangles": triangles,
        "incident": incident,
        "targetTriangleArea": target_tri_area,
        "outerRingTriangleCount": outer_ring_triangle_count,
    })


def _evaluate_local_state(entries, triangles, pos_by_id, point, tol_area_positive):
    areas: list[float] = []
    feasible = True
    fx = 0.0
    fy = 0.0
    entropy = 0.0
    a = 0.0
    b = 0.0
    c = 0.0

    for entry in entries:
        tri = triangles[entry["faceIndex"]]
        left_pos = pos_by_id.get(entry["left"])
        right_pos = pos_by_id.get(entry["right"])
        if left_pos is None or right_pos is None or tri is None:
            feasible = False
            areas.append(0.0)
            continue
        sx = left_pos[0] - right_pos[0]
        sy = left_pos[1] - right_pos[1]
        rx = -sy
        ry = sx
        dx = point[0] - right_pos[0]
        dy = point[1] - right_pos[1]
        area = 0.5 * (sx * dy - sy * dx)
        areas.append(area)
        if not (area > tol_area_positive):
            feasible = False
            continue
        pressure = tri["targetArea"] / area
        weight = tri["weight"] if math.isfinite(tri["weight"]) else 1.0
        fx += weight * pressure * rx
        fy += weight * pressure * ry
        entropy += -weight * tri["targetArea"] * math.log(max(pressure, 1e-300))
        coeff = -0.25 * weight * tri["targetArea"] / (area * area)
        a += coeff * rx * rx
        b += coeff * rx * ry
        c += coeff * ry * ry

    return {
        "feasible": feasible,
        "areas": areas,
        "force": (fx, fy),
        "entropy": entropy,
        "a": a,
        "b": b,
        "c": c,
    }


def _solve_balanced_position(vertex_id, air_data, pos_by_id, opts):
    pv = pos_by_id[vertex_id]
    p = (pv[0], pv[1])
    entries = opts["entries"]
    max_newton = opts["maxNewtonIter"]
    tol_force = opts["tolForceVertex"]
    tol_area_positive = opts["tolAreaPositive"]
    armijo = opts["armijo"]
    min_step = opts["minStep"]
    state = opts.get("initialState")

    for _ in range(max_newton):
        if state is None:
            state = _evaluate_local_state(entries, air_data["triangles"], pos_by_id, p, tol_area_positive)
        if not state["feasible"]:
            return {"pos": p, "forceNorm": math.inf, "stalled": True}
        force_norm = math.sqrt(state["force"][0] ** 2 + state["force"][1] ** 2)
        if force_norm <= tol_force:
            return {"pos": p, "forceNorm": force_norm, "stalled": False}

        g = (0.5 * state["force"][0], 0.5 * state["force"][1])
        det = state["a"] * state["c"] - state["b"] * state["b"]
        if det > 1e-18:
            dx = (state["b"] * g[1] - state["c"] * g[0]) / det
            dy = (state["b"] * g[0] - state["a"] * g[1]) / det
            if not (math.isfinite(dx) and math.isfinite(dy)):
                dx, dy = g
        else:
            dx, dy = g
        if g[0] * dx + g[1] * dy <= 0:
            dx, dy = g

        alpha = 1.0
        accepted = False
        while alpha >= min_step:
            q = (p[0] + alpha * dx, p[1] + alpha * dy)
            q_state = _evaluate_local_state(entries, air_data["triangles"], pos_by_id, q, tol_area_positive)
            if q_state["feasible"] and q_state["entropy"] >= state["entropy"] + armijo * alpha * (g[0] * dx + g[1] * dy):
                p = q
                state = q_state
                accepted = True
                break
            alpha *= 0.5
        if not accepted:
            return {"pos": p, "forceNorm": force_norm, "stalled": True}

    final_state = state or _evaluate_local_state(entries, air_data["triangles"], pos_by_id, p, tol_area_positive)
    fn = math.sqrt(final_state["force"][0] ** 2 + final_state["force"][1] ** 2) if final_state["feasible"] else math.inf
    return {"pos": p, "forceNorm": fn, "stalled": False}


def _compute_air_stats(air_data, pos_by_id, movable_vertices, tol_area_positive):
    max_rel = 0.0
    for tri in air_data["triangles"]:
        a = pos_by_id.get(tri["vertices"][0])
        b = pos_by_id.get(tri["vertices"][1])
        c = pos_by_id.get(tri["vertices"][2])
        area = abs(geo.triangle_area2(a, b, c)) / 2 if (a and b and c) else 0.0
        target = tri["targetArea"]
        rel = abs(area - target) / max(target, 1e-12)
        if not math.isfinite(rel):
            rel = math.inf
        if rel > max_rel:
            max_rel = rel
    max_force = 0.0
    balanced = 0
    for v in movable_vertices:
        state = _evaluate_local_state(air_data["incident"][v], air_data["triangles"], pos_by_id, pos_by_id[v], tol_area_positive)
        f = math.sqrt(state["force"][0] ** 2 + state["force"][1] ** 2) if state["feasible"] else math.inf
        if f > max_force:
            max_force = f
        if f <= 1e-8:
            balanced += 1
    return {
        "maxRelError": max_rel,
        "maxForce": max_force,
        "balancedCount": balanced,
        "boundedFaceCount": len(air_data["triangles"]),
    }


def _build_air_state_from_prepared(context, opts):
    outer = context["augmentedOuterFace"]
    if not isinstance(outer, list) or len(outer) < 3:
        return gu.build_layout_error({"message": "Air setup failed: missing augmented outer face"})
    air_data = _build_air_data(context["augmented"]["embedding"], outer, context["posById"], context["graph"].node_ids)
    if not air_data.get("ok"):
        return gu.build_layout_error({"message": air_data.get("reason")})
    if not air_data["triangles"]:
        return gu.build_layout_result({
            "opts": opts,
            "graph": context["graph"],
            "baseEmbedding": context["baseEmbedding"],
            "outerFace": outer,
            "augmented": context["augmented"],
            "posById": context["posById"],
            "airData": air_data,
            "movableVertices": [],
        })
    for tri in air_data["triangles"]:
        a = context["posById"].get(tri["vertices"][0])
        b = context["posById"].get(tri["vertices"][1])
        c = context["posById"].get(tri["vertices"][2])
        area = abs(geo.triangle_area2(a, b, c)) / 2 if (a and b and c) else 0.0
        if not (area > AIR_INTERNAL["tolAreaPositive"]):
            return gu.build_layout_error({"message": "Air initialization failed: degenerate augmented triangle"})
    movable_vertices: list[str] = []
    for nid in context["movableVertices"]:
        v = str(nid)
        if air_data["incident"].get(v):
            movable_vertices.append(v)
    return gu.build_layout_result({
        "opts": opts,
        "graph": context["graph"],
        "baseEmbedding": context["baseEmbedding"],
        "outerFace": outer,
        "augmented": context["augmented"],
        "posById": context["posById"],
        "airData": air_data,
        "movableVertices": movable_vertices,
    })


def _run_air_iterations(state, opts):
    g = state["graph"]
    pos_by_id = state["posById"]
    air_data = state["airData"]
    movable = state["movableVertices"]
    status = "max_sweeps"
    last_stats = _compute_air_stats(air_data, pos_by_id, movable, AIR_INTERNAL["tolAreaPositive"])
    outer_diameter = geo.outer_face_diameter(pos_by_id, air_data["outerFace"])
    move_tol = AIR_INTERNAL["moveTolAbs"] + AIR_INTERNAL["moveTolRel"] * outer_diameter
    avg_move_tol = 0.25 * move_tol
    plateau_err_abs = AIR_INTERNAL["plateauErrTolAbs"] if AIR_INTERNAL["plateauErrTolAbs"] is not None else AIR_INTERNAL["tolAreaGlobal"]
    plateau_err_rel = AIR_INTERNAL["plateauErrTolRel"] if AIR_INTERNAL["plateauErrTolRel"] is not None else 5 * AIR_INTERNAL["errTolRel"]
    plateau_err_guard = AIR_INTERNAL["plateauErrGuardFactor"] * AIR_INTERNAL["tolAreaGlobal"]
    prev_max_rel = last_stats["maxRelError"]
    stalled = 0
    dead = 0
    plateau = 0
    err_window = [prev_max_rel]

    if prev_max_rel <= AIR_INTERNAL["tolAreaGlobal"]:
        last_stats["maxMove"] = 0
        last_stats["avgMove"] = 0
        last_stats["acceptedCount"] = 0
        last_stats["sweeps"] = 0
        return {"status": "realized", "stats": last_stats,
                "hasCrossings": geo.has_position_crossings(pos_by_id, g.edge_pairs)}

    for sweep in range(1, AIR_INTERNAL["maxSweeps"] + 1):
        accepted = 0
        sum_move = 0.0
        max_move = 0.0
        for v in movable:
            current = _evaluate_local_state(air_data["incident"][v], air_data["triangles"], pos_by_id, pos_by_id[v], AIR_INTERNAL["tolAreaPositive"])
            force_norm = math.sqrt(current["force"][0] ** 2 + current["force"][1] ** 2) if current["feasible"] else math.inf
            if force_norm <= AIR_INTERNAL["tolForceGlobal"]:
                continue
            solved = _solve_balanced_position(v, air_data, pos_by_id, {
                "entries": air_data["incident"][v],
                "initialState": current,
                "maxNewtonIter": AIR_INTERNAL["maxNewtonIter"],
                "tolForceVertex": AIR_INTERNAL["tolForceVertex"],
                "tolAreaPositive": AIR_INTERNAL["tolAreaPositive"],
                "armijo": AIR_INTERNAL["armijo"],
                "minStep": AIR_INTERNAL["minStep"],
            })
            if not solved or solved.get("pos") is None:
                continue
            base = pos_by_id[v]
            dx = solved["pos"][0] - base[0]
            dy = solved["pos"][1] - base[1]
            accepted_pos = None
            step_scale = 1.0
            while step_scale >= AIR_INTERNAL["minStep"]:
                candidate = (base[0] + step_scale * dx, base[1] + step_scale * dy)
                cand_state = _evaluate_local_state(air_data["incident"][v], air_data["triangles"], pos_by_id, candidate, AIR_INTERNAL["tolAreaPositive"])
                if cand_state["feasible"]:
                    accepted_pos = candidate
                    break
                step_scale *= 0.5
            if accepted_pos is not None:
                pos_by_id[v] = accepted_pos
                mvx = accepted_pos[0] - base[0]
                mvy = accepted_pos[1] - base[1]
                mv = math.sqrt(mvx * mvx + mvy * mvy)
                if mv > max_move:
                    max_move = mv
                sum_move += mv
                accepted += 1
            else:
                pos_by_id[v] = base

        last_stats = _compute_air_stats(air_data, pos_by_id, movable, AIR_INTERNAL["tolAreaPositive"])
        max_rel = last_stats["maxRelError"]
        improvement = prev_max_rel - max_rel
        rel_improvement = improvement / max(1.0, prev_max_rel)
        err_window.append(max_rel)
        if len(err_window) > AIR_INTERNAL["plateauWindow"] + 1:
            err_window.pop(0)
        plateau_abs = None
        plateau_rel = None
        if len(err_window) >= AIR_INTERNAL["plateauWindow"] + 1:
            plateau_abs = err_window[0] - max_rel
            plateau_rel = plateau_abs / max(1.0, err_window[0])
        last_stats["maxMove"] = max_move
        last_stats["avgMove"] = (sum_move / accepted) if accepted > 0 else 0
        last_stats["acceptedCount"] = accepted
        last_stats["sweeps"] = sweep

        if max_rel <= AIR_INTERNAL["tolAreaGlobal"]:
            status = "realized"
            break
        if accepted == 0:
            dead += 1
        else:
            dead = 0
        if dead >= AIR_INTERNAL["deadlockPatience"]:
            status = "deadlock"
            break

        if max_move <= move_tol and last_stats["avgMove"] <= avg_move_tol and rel_improvement <= AIR_INTERNAL["errTolRel"]:
            stalled += 1
        else:
            stalled = 0
        if stalled >= AIR_INTERNAL["patience"]:
            status = "stalled"
            break
        if (plateau_abs is not None and max_rel <= plateau_err_guard
                and plateau_abs <= plateau_err_abs and plateau_rel <= plateau_err_rel):
            plateau += 1
        else:
            plateau = 0
        if plateau >= AIR_INTERNAL["plateauPatience"]:
            status = "stalled"
            break
        prev_max_rel = max_rel

    return {"status": status, "stats": last_stats,
            "hasCrossings": geo.has_position_crossings(pos_by_id, g.edge_pairs)}


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    layout_input = preprocessing.prepare_graph_and_layout_data(graph, {
        "failureLabel": "Air layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": opts.get("augmentationOptions"),
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "Air failed"})

    state = _build_air_state_from_prepared(layout_input, opts)
    if not state.get("ok"):
        return state

    if not state["airData"]["triangles"]:
        final_pos = geo.filter_position_map(state["posById"], state["graph"].node_ids)
        return gu.build_layout_result({
            "status": "realized",
            "positions": final_pos,
            "graph": state["graph"],
            "outerFace": state["outerFace"],
            "augmented": state["augmented"],
            "boundedFaceCount": 0,
            "dummyCount": state["augmented"].get("dummyCount"),
            "faceAreaScore": None,
            "maxRelError": 0,
        })

    solve_result = _run_air_iterations(state, state["opts"])
    status = solve_result["status"]
    last_stats = solve_result["stats"]
    final_pos = geo.filter_position_map(state["posById"], state["graph"].node_ids)

    if solve_result["hasCrossings"]:
        return gu.build_layout_error({
            "status": status,
            "message": "Air produced a non-plane drawing",
            "graph": state["graph"],
            "outerFace": state["outerFace"],
            "augmented": state["augmented"],
            "maxRelError": last_stats["maxRelError"] if last_stats else None,
            "boundedFaceCount": len(state["airData"]["triangles"]),
            "dummyCount": state["augmented"].get("dummyCount"),
        })

    face_score = metric_mod.compute_uniform_face_area_score(
        state["graph"].node_ids, state["graph"].edge_pairs,
        state["posById"], state["baseEmbedding"],
    )
    quality = face_score.get("quality") if face_score.get("ok") else None

    message = gu.build_layout_status_message("Air", {
        "outerFaceVertexCount": len(state["outerFace"]) if isinstance(state["outerFace"], list) else None,
        "boundedFaceCount": len(state["airData"]["triangles"]),
        "dummyCount": state["augmented"].get("dummyCount"),
        "status": status,
        "maxRelError": last_stats["maxRelError"] if last_stats else None,
        "faceAreaScore": quality,
    })

    return gu.build_layout_result({
        "status": status,
        "positions": final_pos,
        "graph": state["graph"],
        "outerFace": state["outerFace"],
        "augmented": state["augmented"],
        "message": message,
        "faceAreaScore": quality,
        "maxRelError": last_stats["maxRelError"] if last_stats else None,
        "boundedFaceCount": len(state["airData"]["triangles"]),
        "dummyCount": state["augmented"].get("dummyCount"),
        "iters": last_stats.get("sweeps") if last_stats else None,
    })
