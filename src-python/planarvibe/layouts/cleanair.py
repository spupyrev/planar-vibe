"""CleanAir layout (LM/pattern-search equal-area with continuation).

Port of static/js/layout-cleanair.js.
"""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import linear_algebra as la
from .. import metrics as metric_mod
from .. import planar_graph as pg
from .. import planarity
from . import tutte as tutte_mod

CLEAN_AIR_CONFIG = {
    "maxSweeps": 200,
    "tolForceGlobal": 1e-8,
    "tolAreaGlobal": 1e-3,
    "tolAreaPositive": 1e-12,
    "minObjectiveGain": 1e-12,
    "minStep": 2 ** -40,
    "lmStepRel": 0.5,
    "patternSearchMaxDim": 14,
    "patternSearchMaxSteps": 250,
    "patternSearchMinStep": 1e-6,
    "continuationEnabled": True,
    "continuationInitialStep": 0.25,
    "continuationMaxStep": 0.25,
    "continuationMinStep": 1 / 4096,
    "continuationMaxStages": 80,
    "continuationStageTol": 2e-2,
    "deadlockPatience": 2,
}


def _choose_longest_face(embedding) -> list[str] | None:
    faces = embedding.get("faces") if isinstance(embedding.get("faces"), list) else []
    best: list[str] | None = None
    for face in faces:
        if isinstance(face, (list, tuple)) and len(face) > 3 and (best is None or len(face) > len(best)):
            best = [str(x) for x in face]
    if best is not None:
        return best
    for face in faces:
        if isinstance(face, (list, tuple)) and len(face) >= 3 and (best is None or len(face) > len(best)):
            best = [str(x) for x in face]
    if best is not None:
        return best
    outer = embedding.get("outerFace")
    return [str(x) for x in outer] if isinstance(outer, list) else None


def _extract_original_embedding(graph):
    embedding = planarity.compute_planar_embedding(graph.node_ids, graph.edge_pairs)
    if not embedding or not embedding.get("ok"):
        return gu.build_layout_error({"message": "CleanAir requires a planar graph"})
    return gu.build_layout_result({"embedding": embedding, "outerFace": _choose_longest_face(embedding)})


def _build_bounded_face_records(embedding, outer_face, pos_by_id, target_scale):
    faces = embedding.get("faces") or []
    outer_index = pg.find_outer_face_index(faces, outer_face or [])
    records = []
    target_total = 0.0
    scale = target_scale if (isinstance(target_scale, (int, float)) and math.isfinite(target_scale) and target_scale > 0) else 1.0
    for i, raw_face in enumerate(faces):
        if i == outer_index:
            continue
        if not isinstance(raw_face, (list, tuple)) or len(raw_face) < 3:
            continue
        target_area = scale * (len(raw_face) - 2)
        if not (target_area > 0):
            continue
        records.append({
            "index": i,
            "vertices": geo.orient_face_ccw([str(x) for x in raw_face], pos_by_id),
            "targetArea": target_area,
            "finalTargetArea": target_area,
            "seedTargetArea": target_area,
        })
        target_total += target_area
    return {"records": records, "targetTotal": target_total}


def _bounded_target_total_for_outer(embedding, outer_face):
    faces = embedding.get("faces") or []
    outer_index = pg.find_outer_face_index(faces, outer_face or [])
    total = 0
    for i, face in enumerate(faces):
        if i == outer_index:
            continue
        if isinstance(face, (list, tuple)) and len(face) >= 3:
            total += len(face) - 2
    return total


def _compute_tutte_seed_positions(graph):
    prepared = tutte_mod.__dict__  # placeholder; we call apply_layout directly
    result = tutte_mod.apply_layout(graph)
    if not result or not result.get("ok") or not result.get("positions"):
        return gu.build_layout_error({
            "message": (result or {}).get("message") or "CleanAir initialization failed: Tutte layout failed",
        })
    return result


def _build_incident_face_data(graph, face_records):
    incident: dict[str, list[dict]] = {str(nid): [] for nid in graph.node_ids}
    for i, record in enumerate(face_records):
        face = record["vertices"]
        n = len(face)
        for j in range(n):
            v = str(face[j])
            if v not in incident:
                incident[v] = []
            incident[v].append({
                "faceIndex": i,
                "left": str(face[(j - 1) % n]),
                "right": str(face[(j + 1) % n]),
            })
    return incident


def _polygon_area_with_point(face, pos_by_id, vertex_id, point):
    total = 0.0
    n = len(face)
    for i in range(n):
        a_id = str(face[i])
        b_id = str(face[(i + 1) % n])
        a = point if a_id == vertex_id else pos_by_id.get(a_id)
        b = point if b_id == vertex_id else pos_by_id.get(b_id)
        if a is None or b is None:
            return 0
        total += a[0] * b[1] - b[0] * a[1]
    return total / 2


def _evaluate_local_state(vertex_id, entries, faces, pos_by_id, point, tol_area_positive):
    feasible = True
    fx = 0.0
    fy = 0.0
    entropy = 0.0
    a = 0.0
    b = 0.0
    c = 0.0
    for entry in entries:
        face = faces[entry["faceIndex"]]
        left_pos = pos_by_id.get(entry["left"])
        right_pos = pos_by_id.get(entry["right"])
        if face is None or left_pos is None or right_pos is None:
            feasible = False
            continue
        area = _polygon_area_with_point(face["vertices"], pos_by_id, vertex_id, point)
        if not (area > tol_area_positive):
            feasible = False
            continue
        sx = left_pos[0] - right_pos[0]
        sy = left_pos[1] - right_pos[1]
        rx = -sy
        ry = sx
        pressure = face["targetArea"] / area
        fx += pressure * rx
        fy += pressure * ry
        entropy += -face["targetArea"] * math.log(max(pressure, 1e-300))
        coeff = -0.25 * face["targetArea"] / (area * area)
        a += coeff * rx * rx
        b += coeff * rx * ry
        c += coeff * ry * ry
    return {"feasible": feasible, "force": (fx, fy), "entropy": entropy, "a": a, "b": b, "c": c}


def _compute_clean_air_stats(clean_air_data, pos_by_id, movable_vertices):
    max_rel_error = 0.0
    total_entropy = 0.0
    for face in clean_air_data["faces"]:
        area = geo.polygon_area_abs(face["vertices"], pos_by_id)
        rel = abs(area - face["targetArea"]) / max(face["targetArea"], 1e-12)
        if not math.isfinite(rel):
            rel = math.inf
        if rel > max_rel_error:
            max_rel_error = rel
        if area > 0:
            total_entropy += -face["targetArea"] * math.log(max(face["targetArea"] / area, 1e-300))
    max_force = 0.0
    balanced = 0
    for v_raw in movable_vertices:
        v = str(v_raw)
        state = _evaluate_local_state(
            v, clean_air_data["incident"].get(v, []), clean_air_data["faces"],
            pos_by_id, pos_by_id[v], CLEAN_AIR_CONFIG["tolAreaPositive"],
        )
        force = math.hypot(state["force"][0], state["force"][1]) if state["feasible"] else math.inf
        if force > max_force:
            max_force = force
        if force <= CLEAN_AIR_CONFIG["tolForceGlobal"]:
            balanced += 1
    return {
        "maxRelError": max_rel_error,
        "maxForce": max_force,
        "balancedCount": balanced,
        "entropy": total_entropy,
        "boundedFaceCount": len(clean_air_data["faces"]),
    }


def _compute_area_system(state, pos_by_id):
    clean = state["cleanAirData"]
    movable = state["movableVertices"]
    dim = 2 * len(movable)
    index_by_id = {str(v): i for i, v in enumerate(movable)}
    jtj = [[0.0] * dim for _ in range(dim)]
    jtr = [0.0] * dim
    loss = 0.0
    max_rel_error = 0.0
    for face in clean["faces"]:
        area = geo.polygon_area2(face["vertices"], pos_by_id) / 2
        if not (area > CLEAN_AIR_CONFIG["tolAreaPositive"]):
            return {"ok": False, "reason": "nonpositive-face", "faceIndex": face["index"], "area": area}
        target = max(face["targetArea"], 1e-12)
        residual = (area - face["targetArea"]) / target
        abs_rel = abs(residual)
        if abs_rel > max_rel_error:
            max_rel_error = abs_rel
        loss += 0.5 * residual * residual
        row = [0.0] * dim
        n = len(face["vertices"])
        for j in range(n):
            v = str(face["vertices"][j])
            vi = index_by_id.get(v)
            if vi is None:
                continue
            left = str(face["vertices"][(j - 1) % n])
            right = str(face["vertices"][(j + 1) % n])
            pl = pos_by_id[left]
            pr = pos_by_id[right]
            rx = -(pl[1] - pr[1])
            ry = (pl[0] - pr[0])
            row[2 * vi] += 0.5 * rx / target
            row[2 * vi + 1] += 0.5 * ry / target
        for j in range(dim):
            jtr[j] += row[j] * residual
            for k in range(dim):
                jtj[j][k] += row[j] * row[k]
    return {
        "ok": True,
        "loss": loss,
        "maxRelError": max_rel_error,
        "gradNorm": math.sqrt(sum(v * v for v in jtr)),
        "JTJ": jtj,
        "JTr": jtr,
        "indexById": index_by_id,
        "dim": dim,
    }


def _clone_position_map(pos_by_id, node_ids):
    out: dict[str, tuple[float, float]] = {}
    for nid_raw in node_ids:
        nid = str(nid_raw)
        p = pos_by_id.get(nid)
        out[nid] = (p[0], p[1]) if p is not None else (0.0, 0.0)
    return out


def _replace_state_positions(state, positions):
    state["posById"] = _clone_position_map(positions, state["graph"].node_ids)


def _initialize_continuation_targets(face_records, pos_by_id):
    for face in face_records:
        face["finalTargetArea"] = face["targetArea"]
        seed_area = geo.polygon_area2(face["vertices"], pos_by_id) / 2
        face["seedTargetArea"] = seed_area if seed_area > CLEAN_AIR_CONFIG["tolAreaPositive"] else face["finalTargetArea"]


def _set_continuation_targets(clean_air_data, t):
    clamped = max(0, min(1, t))
    total = 0.0
    for face in clean_air_data["faces"]:
        seed = face["seedTargetArea"] if math.isfinite(face["seedTargetArea"]) else face["targetArea"]
        final_target = face["finalTargetArea"] if math.isfinite(face["finalTargetArea"]) else face["targetArea"]
        face["targetArea"] = (1 - clamped) * seed + clamped * final_target
        total += face["targetArea"]
    clean_air_data["targetTotal"] = total


def _bounded_faces_are_positive(clean_air_data, pos_by_id):
    for face in clean_air_data["faces"]:
        area = geo.polygon_area2(face["vertices"], pos_by_id) / 2
        if not (area > CLEAN_AIR_CONFIG["tolAreaPositive"]):
            return False
    return True


def _apply_candidate_positions(pos_by_id, candidate_positions, movable_vertices):
    moved = 0
    max_move = 0.0
    sum_move = 0.0
    for v_raw in movable_vertices:
        v = str(v_raw)
        old = pos_by_id.get(v)
        nxt = candidate_positions.get(v)
        if old is None or nxt is None:
            continue
        move = math.hypot(nxt[0] - old[0], nxt[1] - old[1])
        pos_by_id[v] = nxt
        moved += 1
        sum_move += move
        if move > max_move:
            max_move = move
    return {
        "movedVertices": moved,
        "maxMove": max_move,
        "avgMove": (sum_move / moved) if moved > 0 else 0,
    }


def _try_lm_step(state, current_system):
    graph = state["graph"]
    pos_by_id = state["posById"]
    movable = state["movableVertices"]
    dim = current_system["dim"]
    if dim == 0:
        return {"accepted": False, "reason": "no-movable-vertices"}
    if not (current_system["gradNorm"] > 0):
        return {"accepted": False, "reason": "zero-gradient"}
    outer_area = geo.polygon_area_abs(state["outerFace"], pos_by_id)
    max_step = CLEAN_AIR_CONFIG["lmStepRel"] * math.sqrt(max(outer_area, 1))
    zero = [0.0] * dim
    lambdas = [1e-10, 1e-8, 1e-6, 1e-4, 1e-2, 1, 100, 1e4, 1e6, 1e8]
    diagnostics = {
        "singular": 0, "nonfiniteStep": 0, "nonpositiveFace": 0, "crossings": 0,
        "noImprovement": 0, "maxRelIncrease": 0, "tested": 0,
        "bestLoss": math.inf, "bestMaxRelError": math.inf, "bestAlpha": 0, "bestLambda": None,
    }
    best_strict = None
    best_relaxed = None

    for lam in lambdas:
        A = [row[:] for row in current_system["JTJ"]]
        b = [-x for x in current_system["JTr"]]
        for i in range(dim):
            A[i][i] += lam * max(current_system["JTJ"][i][i], 1e-8)
        factor = la.lu_factorize(A)
        solved = la.solve_lu_with_two_rhs(factor, b, zero) if factor else None
        if solved is None:
            diagnostics["singular"] += 1
            continue
        step, _ = solved
        step_norm = 0.0
        finite = True
        for i in range(len(movable)):
            sx = step[2 * i]
            sy = step[2 * i + 1]
            if not (math.isfinite(sx) and math.isfinite(sy)):
                finite = False
                break
            sn = math.sqrt(sx * sx + sy * sy)
            if sn > step_norm:
                step_norm = sn
        if not finite or not (step_norm > 0):
            diagnostics["nonfiniteStep"] += 1
            continue
        step_scale = (max_step / step_norm) if step_norm > max_step else 1
        alpha = 1.0
        while alpha >= CLEAN_AIR_CONFIG["minStep"]:
            diagnostics["tested"] += 1
            candidate = _clone_position_map(pos_by_id, graph.node_ids)
            for i, v_raw in enumerate(movable):
                v = str(v_raw)
                p = pos_by_id[v]
                candidate[v] = (p[0] + alpha * step_scale * step[2 * i],
                                p[1] + alpha * step_scale * step[2 * i + 1])
            if not _bounded_faces_are_positive(state["cleanAirData"], candidate):
                diagnostics["nonpositiveFace"] += 1
                alpha *= 0.5
                continue
            if geo.has_position_crossings(candidate, graph.edge_pairs):
                diagnostics["crossings"] += 1
                alpha *= 0.5
                continue
            cand_sys = _compute_area_system(state, candidate)
            if not cand_sys.get("ok"):
                diagnostics["nonpositiveFace"] += 1
                alpha *= 0.5
                continue
            if cand_sys["loss"] < diagnostics["bestLoss"]:
                diagnostics["bestLoss"] = cand_sys["loss"]
                diagnostics["bestMaxRelError"] = cand_sys["maxRelError"]
                diagnostics["bestAlpha"] = alpha * step_scale
                diagnostics["bestLambda"] = lam
            if cand_sys["loss"] < current_system["loss"] - CLEAN_AIR_CONFIG["minObjectiveGain"]:
                cand = {"positions": candidate, "system": cand_sys, "lambda": lam, "alpha": alpha * step_scale}
                if cand_sys["maxRelError"] <= current_system["maxRelError"] + CLEAN_AIR_CONFIG["minObjectiveGain"]:
                    if best_strict is None or cand_sys["loss"] < best_strict["system"]["loss"]:
                        best_strict = cand
                else:
                    diagnostics["maxRelIncrease"] += 1
                    if state["allowRelaxedAreaSteps"] and (best_relaxed is None or cand_sys["loss"] < best_relaxed["system"]["loss"]):
                        best_relaxed = cand
                    alpha *= 0.5
                    continue
                break
            diagnostics["noImprovement"] += 1
            alpha *= 0.5

    best = best_strict or best_relaxed
    if best is not None:
        stats = _apply_candidate_positions(pos_by_id, best["positions"], movable)
        return {
            "accepted": True,
            "movedVertices": stats["movedVertices"],
            "maxMove": stats["maxMove"],
            "avgMove": stats["avgMove"],
            "loss": best["system"]["loss"],
            "maxRelError": best["system"]["maxRelError"],
            "gradNorm": best["system"]["gradNorm"],
            "lambda": best["lambda"],
            "alpha": best["alpha"],
            "diagnostics": diagnostics,
        }
    return {
        "accepted": False,
        "reason": "no-acceptable-lm-step" if diagnostics["tested"] > 0 else "no-linear-solve",
        "diagnostics": diagnostics,
        "loss": current_system["loss"],
        "gradNorm": current_system["gradNorm"],
        "maxRelError": current_system["maxRelError"],
    }


def _build_pattern_search_directions(dim):
    directions = []
    for i in range(dim):
        d = [0.0] * dim
        e = [0.0] * dim
        d[i] = 1
        e[i] = -1
        directions.append(d)
        directions.append(e)
    for i in range(dim):
        for j in range(i + 1, dim):
            for sx, sy in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
                d = [0.0] * dim
                d[i] = sx / math.sqrt(2)
                d[j] = sy / math.sqrt(2)
                directions.append(d)
    return directions


def _make_pattern_candidate(state, direction, step):
    graph = state["graph"]
    pos_by_id = state["posById"]
    candidate = _clone_position_map(pos_by_id, graph.node_ids)
    for i, v_raw in enumerate(state["movableVertices"]):
        v = str(v_raw)
        p = pos_by_id[v]
        candidate[v] = (p[0] + step * direction[2 * i], p[1] + step * direction[2 * i + 1])
    return candidate


def _try_pattern_search(state, current_system):
    graph = state["graph"]
    movable = state["movableVertices"]
    dim = 2 * len(movable)
    if dim == 0:
        return {"accepted": False, "reason": "no-movable-vertices"}
    if dim > CLEAN_AIR_CONFIG["patternSearchMaxDim"]:
        return {"accepted": False, "reason": "pattern-dimension-limit"}
    directions = _build_pattern_search_directions(dim)
    outer_area = geo.polygon_area_abs(state["outerFace"], state["posById"])
    step = 0.25 * math.sqrt(max(outer_area, 1))
    current = current_system
    accepted_any = False
    total_move = {"movedVertices": 0, "maxMove": 0, "avgMove": 0}
    diagnostics = {
        "accepted": 0, "shrink": 0, "tested": 0, "crossings": 0,
        "nonpositiveFace": 0, "noImprovement": 0, "maxRelIncrease": 0, "finalStep": step,
    }
    for it in range(CLEAN_AIR_CONFIG["patternSearchMaxSteps"]):
        if not (step >= CLEAN_AIR_CONFIG["patternSearchMinStep"] and current["maxRelError"] > CLEAN_AIR_CONFIG["tolAreaGlobal"]):
            break
        best_strict_pos = None
        best_strict_sys = current
        best_relaxed_pos = None
        best_relaxed_sys = current
        for d in directions:
            diagnostics["tested"] += 1
            candidate = _make_pattern_candidate(state, d, step)
            if not _bounded_faces_are_positive(state["cleanAirData"], candidate):
                diagnostics["nonpositiveFace"] += 1
                continue
            if geo.has_position_crossings(candidate, graph.edge_pairs):
                diagnostics["crossings"] += 1
                continue
            cand_sys = _compute_area_system(state, candidate)
            if not cand_sys.get("ok"):
                diagnostics["nonpositiveFace"] += 1
                continue
            if cand_sys["loss"] < current["loss"] - CLEAN_AIR_CONFIG["minObjectiveGain"]:
                if cand_sys["maxRelError"] <= current["maxRelError"] + CLEAN_AIR_CONFIG["minObjectiveGain"]:
                    if best_strict_pos is None or cand_sys["loss"] < best_strict_sys["loss"]:
                        best_strict_sys = cand_sys
                        best_strict_pos = candidate
                else:
                    diagnostics["maxRelIncrease"] += 1
                    if state["allowRelaxedAreaSteps"] and (best_relaxed_pos is None or cand_sys["loss"] < best_relaxed_sys["loss"]):
                        best_relaxed_sys = cand_sys
                        best_relaxed_pos = candidate
            else:
                diagnostics["noImprovement"] += 1
        best_pos = best_strict_pos or best_relaxed_pos
        best_sys = best_strict_sys if best_strict_pos is not None else best_relaxed_sys
        if best_pos is not None:
            stats = _apply_candidate_positions(state["posById"], best_pos, movable)
            accepted_any = True
            diagnostics["accepted"] += 1
            current = best_sys
            total_move["movedVertices"] = stats["movedVertices"]
            total_move["maxMove"] = max(total_move["maxMove"], stats["maxMove"])
            total_move["avgMove"] = stats["avgMove"]
        else:
            step *= 0.5
            diagnostics["shrink"] += 1
        diagnostics["finalStep"] = step
    if not accepted_any:
        return {
            "accepted": False,
            "reason": "no-pattern-step",
            "diagnostics": diagnostics,
            "loss": current_system["loss"],
            "gradNorm": current_system["gradNorm"],
            "maxRelError": current_system["maxRelError"],
        }
    return {
        "accepted": True,
        "movedVertices": total_move["movedVertices"],
        "maxMove": total_move["maxMove"],
        "avgMove": total_move["avgMove"],
        "loss": current["loss"],
        "maxRelError": current["maxRelError"],
        "gradNorm": current["gradNorm"],
        "diagnostics": diagnostics,
    }


def _build_state(graph, options):
    embedding_result = _extract_original_embedding(graph)
    if not embedding_result.get("ok"):
        return embedding_result
    embedding = embedding_result["embedding"]
    preferred_outer = embedding_result["outerFace"]
    if not isinstance(preferred_outer, list) or len(preferred_outer) < 3:
        return gu.build_layout_error({"message": "CleanAir could not determine an outer face"})
    n = len(graph.node_ids)
    m = len(graph.edge_pairs)
    is_quad = m == 2 * n - 4
    is_tri = m == 3 * n - 6
    if not is_quad and not is_tri:
        return gu.build_layout_error({
            "message": "CleanAir requires a quadrangulated graph (m = 2n - 4) or triangulated graph (m = 3n - 6)"
        })
    outer_face = [str(x) for x in preferred_outer]
    raw_target_total = _bounded_target_total_for_outer(embedding, outer_face)
    if not (raw_target_total > 0):
        return gu.build_layout_error({"message": "CleanAir requires at least one bounded face"})
    initial = _compute_tutte_seed_positions(graph)
    if (not initial.get("ok") or not initial.get("positions")
            or geo.has_position_crossings(initial["positions"], graph.edge_pairs)):
        return gu.build_layout_error({"message": "CleanAir initialization produced a non-plane drawing"})
    pos_by_id = initial["positions"]
    fixed_outer_area = geo.polygon_area_abs(outer_face, pos_by_id)
    if not (fixed_outer_area > 0):
        return gu.build_layout_error({"message": "CleanAir initialization produced a degenerate outer face"})
    target_scale = fixed_outer_area / raw_target_total
    face_build = _build_bounded_face_records(embedding, outer_face, pos_by_id, target_scale)
    if not face_build["records"]:
        return gu.build_layout_error({"message": "CleanAir requires at least one bounded face"})
    _initialize_continuation_targets(face_build["records"], pos_by_id)
    incident = _build_incident_face_data(graph, face_build["records"])
    movable = gu.collect_movable_vertices(graph.node_ids, outer_face)
    return gu.build_layout_result({
        "graph": graph,
        "embedding": embedding,
        "outerFace": outer_face,
        "posById": pos_by_id,
        "seedPositions": _clone_position_map(pos_by_id, graph.node_ids),
        "allowRelaxedAreaSteps": False,
        "movableVertices": movable,
        "opts": options or {},
        "cleanAirData": {
            "faces": face_build["records"],
            "incident": incident,
            "targetTotal": face_build["targetTotal"],
        },
    })


def _run_iterations(state, options):
    graph = state["graph"]
    pos_by_id = state["posById"]
    clean = state["cleanAirData"]
    movable = state["movableVertices"]
    status = "max_sweeps"
    last_stats = _compute_clean_air_stats(clean, pos_by_id, movable)
    dead = 0
    last_move = {"movedVertices": 0, "avgMove": 0, "maxMove": 0, "acceptedCount": 0}
    last_step = None

    if last_stats["maxRelError"] <= CLEAN_AIR_CONFIG["tolAreaGlobal"]:
        last_stats["sweeps"] = 0
        return {"status": "realized", "stats": last_stats, "moveStats": last_move,
                "hasCrossings": geo.has_position_crossings(pos_by_id, graph.edge_pairs)}

    for sweep in range(1, CLEAN_AIR_CONFIG["maxSweeps"] + 1):
        current = _compute_area_system(state, pos_by_id)
        if not current.get("ok"):
            status = current.get("reason") or "invalid-area-state"
            last_step = current
            break
        lm = _try_lm_step(state, current)
        if not lm["accepted"]:
            ps = _try_pattern_search(state, current)
            if ps["accepted"]:
                lm = ps
            elif lm.get("diagnostics") and ps.get("diagnostics"):
                lm["patternDiagnostics"] = ps["diagnostics"]
        last_step = lm
        accepted = lm["movedVertices"] if lm["accepted"] else 0
        max_move = lm["maxMove"] if lm["accepted"] else 0
        avg_move = lm["avgMove"] if lm["accepted"] else 0
        last_move = {"movedVertices": accepted, "avgMove": avg_move, "maxMove": max_move, "acceptedCount": accepted}
        last_stats = _compute_clean_air_stats(clean, pos_by_id, movable)
        max_rel_err = last_stats["maxRelError"]
        last_stats["maxMove"] = max_move
        last_stats["avgMove"] = avg_move
        last_stats["acceptedCount"] = accepted
        last_stats["sweeps"] = sweep
        last_stats["objective"] = lm["loss"] if lm["accepted"] else current["loss"]
        last_stats["gradNorm"] = lm["gradNorm"] if lm["accepted"] else current["gradNorm"]
        last_stats["failureReason"] = None if lm["accepted"] else lm.get("reason")
        last_stats["lmDiagnostics"] = lm.get("diagnostics")
        last_stats["patternDiagnostics"] = lm.get("patternDiagnostics")
        if max_rel_err <= CLEAN_AIR_CONFIG["tolAreaGlobal"]:
            status = "realized"
            break
        if accepted == 0:
            dead += 1
        else:
            dead = 0
        if dead >= CLEAN_AIR_CONFIG["deadlockPatience"]:
            status = "blocked"
            break
    return {
        "status": status,
        "stats": last_stats,
        "moveStats": last_move,
        "lastStep": last_step,
        "hasCrossings": geo.has_position_crossings(pos_by_id, graph.edge_pairs),
    }


def _run_continuation(state):
    diagnostics = {
        "enabled": True, "acceptedStages": 0, "rejectedStages": 0, "stages": [],
        "finalT": 0, "minStepReached": False,
    }
    t = 0.0
    step = CLEAN_AIR_CONFIG["continuationInitialStep"]
    last_result = None
    _replace_state_positions(state, state["seedPositions"])
    _set_continuation_targets(state["cleanAirData"], 0)
    for stage in range(CLEAN_AIR_CONFIG["continuationMaxStages"]):
        if t >= 1:
            break
        from_t = t
        to_t = min(1, t + step)
        backup = _clone_position_map(state["posById"], state["graph"].node_ids)
        _set_continuation_targets(state["cleanAirData"], to_t)
        state["allowRelaxedAreaSteps"] = False
        result = _run_iterations(state, {})
        if result["status"] != "realized":
            _replace_state_positions(state, backup)
            _set_continuation_targets(state["cleanAirData"], to_t)
            state["allowRelaxedAreaSteps"] = True
            relaxed = _run_iterations(state, {})
            strict_err = result["stats"].get("maxRelError", math.inf) if result.get("stats") else math.inf
            relaxed_err = relaxed["stats"].get("maxRelError", math.inf) if relaxed.get("stats") else math.inf
            if relaxed["status"] == "realized" or relaxed_err < strict_err:
                result = relaxed
                result["relaxedContinuationStage"] = True
            else:
                _replace_state_positions(state, backup)
                _set_continuation_targets(state["cleanAirData"], to_t)
            state["allowRelaxedAreaSteps"] = False
        last_result = result
        stats = result.get("stats") or {}
        stage_error = stats.get("maxRelError", math.inf)
        final_stage = to_t >= 1
        diagnostics["stages"].append({
            "from": from_t, "to": to_t, "step": step, "status": result["status"],
            "maxRelError": stage_error if math.isfinite(stage_error) else None,
            "failureReason": stats.get("failureReason"),
            "relaxed": bool(result.get("relaxedContinuationStage")),
            "acceptedInexact": (result["status"] != "realized" and not final_stage
                                and stage_error <= CLEAN_AIR_CONFIG["continuationStageTol"]),
        })
        if result["status"] == "realized" or (not final_stage and stage_error <= CLEAN_AIR_CONFIG["continuationStageTol"]):
            t = to_t
            diagnostics["acceptedStages"] += 1
            diagnostics["finalT"] = t
            step = min(CLEAN_AIR_CONFIG["continuationMaxStep"], step * 1.5)
            continue
        _replace_state_positions(state, backup)
        _set_continuation_targets(state["cleanAirData"], from_t)
        diagnostics["rejectedStages"] += 1
        step *= 0.5
        if step < CLEAN_AIR_CONFIG["continuationMinStep"]:
            diagnostics["minStepReached"] = True
            break
    if t >= 1 and last_result is not None:
        last_result["continuationDiagnostics"] = diagnostics
        return last_result
    _set_continuation_targets(state["cleanAirData"], 1)
    final_stats = _compute_clean_air_stats(state["cleanAirData"], state["posById"], state["movableVertices"])
    final_stats["sweeps"] = (last_result.get("stats") or {}).get("sweeps", 0) if last_result else 0
    final_stats["failureReason"] = "continuation-min-step" if diagnostics["minStepReached"] else "continuation-stage-limit"
    return {
        "status": "blocked",
        "stats": final_stats,
        "moveStats": {"movedVertices": 0, "avgMove": 0, "maxMove": 0, "acceptedCount": 0},
        "continuationDiagnostics": diagnostics,
        "hasCrossings": geo.has_position_crossings(state["posById"], state["graph"].edge_pairs),
    }


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    state = _build_state(graph, options or {})
    if not state.get("ok"):
        return gu.build_layout_error(state)
    if not state["cleanAirData"]["faces"]:
        return gu.build_layout_result({
            "graph": graph,
            "outerFace": state["outerFace"],
            "positions": geo.filter_position_map(state["posById"], graph.node_ids),
            "status": "realized",
            "boundedFaceCount": 0,
            "faceAreaScore": None,
            "maxRelError": 0,
        })

    solve_result = _run_iterations(state, state["opts"])
    continuation_diag = None
    if solve_result["status"] != "realized" and CLEAN_AIR_CONFIG["continuationEnabled"]:
        direct_result = solve_result
        direct_positions = _clone_position_map(state["posById"], graph.node_ids)
        continuation_result = _run_continuation(state)
        continuation_diag = continuation_result.get("continuationDiagnostics")
        direct_err = (direct_result.get("stats") or {}).get("maxRelError", math.inf)
        continuation_err = (continuation_result.get("stats") or {}).get("maxRelError", math.inf)
        if continuation_result["status"] == "realized" or continuation_err < direct_err:
            solve_result = continuation_result
        else:
            _replace_state_positions(state, direct_positions)
            _set_continuation_targets(state["cleanAirData"], 1)
            solve_result = direct_result
            solve_result["continuationDiagnostics"] = continuation_diag
    else:
        _set_continuation_targets(state["cleanAirData"], 1)

    final_positions = geo.filter_position_map(state["posById"], graph.node_ids)
    if solve_result["hasCrossings"]:
        return gu.build_layout_error({
            "graph": graph,
            "outerFace": state["outerFace"],
            "message": "CleanAir produced a non-plane drawing",
            "status": solve_result["status"],
            "maxRelError": (solve_result.get("stats") or {}).get("maxRelError"),
            "boundedFaceCount": len(state["cleanAirData"]["faces"]),
        })
    face_score = metric_mod.compute_uniform_face_area_score(
        graph.node_ids, graph.edge_pairs, final_positions, state["embedding"],
    )
    stats = solve_result.get("stats") or {}
    message = gu.build_layout_status_message("CleanAir", {
        "outerFaceVertexCount": len(state["outerFace"]),
        "boundedFaceCount": len(state["cleanAirData"]["faces"]),
        "status": solve_result["status"],
        "maxRelError": stats.get("maxRelError") if (isinstance(stats.get("maxRelError"), (int, float)) and math.isfinite(stats.get("maxRelError"))) else None,
        "faceAreaScore": face_score.get("quality") if face_score.get("ok") else None,
    })
    return gu.build_layout_result({
        "graph": graph,
        "outerFace": state["outerFace"],
        "positions": final_positions,
        "status": solve_result["status"],
        "message": message,
        "faceAreaScore": face_score.get("quality") if face_score.get("ok") else None,
        "maxRelError": stats.get("maxRelError") if (isinstance(stats.get("maxRelError"), (int, float)) and math.isfinite(stats.get("maxRelError"))) else None,
        "boundedFaceCount": len(state["cleanAirData"]["faces"]),
        "targetTotal": state["cleanAirData"]["targetTotal"],
        "failureReason": stats.get("failureReason"),
        "lmDiagnostics": stats.get("lmDiagnostics"),
        "continuationDiagnostics": continuation_diag or solve_result.get("continuationDiagnostics"),
        "dummyCount": 0,
        "iters": stats.get("sweeps") if (isinstance(stats.get("sweeps"), (int, float)) and math.isfinite(stats.get("sweeps"))) else None,
    })
