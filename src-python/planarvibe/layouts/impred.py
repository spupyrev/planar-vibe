"""ImPrEd layout. Port of static/js/layout-impred.js."""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import preprocessing

IMPRED_CONFIG = {
    "maxIters": 600,
    "maxMoveFactor": 3,
    "minMaxMoveFactor": 0.05,
    "sectorCount": 8,
    "forceScale": 0.04,
    "nodeRepulsion": 1.0,
    "edgeAttraction": 1.0,
    "nodeEdgeRepulsion": 0.75,
    "nearbyFactor": 6.0,
    "momentumBeta": 0.78,
    "rejectedVelocityDamp": 0.25,
    "rollbackVelocityDamp": 0.0,
    "fullRollbackVelocityDamp": 0.5,
    "minItersBeforeStop": 60,
    "stableIterLimit": 16,
    "movementStopTolFactor": 0.008,
    "avgMovementStopTolFactor": 0.0015,
}


def _estimate_delta(edge_pairs, pos_by_id):
    total = 0.0
    cnt = 0
    for (u_raw, v_raw) in edge_pairs:
        u, v = str(u_raw), str(v_raw)
        pu = pos_by_id.get(u)
        pv = pos_by_id.get(v)
        if pu is None or pv is None:
            continue
        dx = pu[0] - pv[0]
        dy = pu[1] - pv[1]
        d = math.sqrt(dx * dx + dy * dy)
        if not (d > 1e-9):
            continue
        total += d
        cnt += 1
    if cnt == 0:
        return 40.0
    return total / cnt


def _cross(ax, ay, bx, by):
    return ax * by - ay * bx


def _project_point_on_segment(px, py, ax, ay, bx, by):
    vx = bx - ax
    vy = by - ay
    ww = vx * vx + vy * vy
    if not (ww > 1e-12):
        return None
    t = ((px - ax) * vx + (py - ay) * vy) / ww
    if t < 0 or t > 1:
        return None
    return (ax + t * vx, ay + t * vy, t)


def _ray_segment_distance(px, py, dx, dy, ax, ay, bx, by):
    ex = bx - ax
    ey = by - ay
    den = _cross(dx, dy, ex, ey)
    if abs(den) < 1e-12:
        return math.inf
    qpx = ax - px
    qpy = ay - py
    t = _cross(qpx, qpy, ex, ey) / den
    u = _cross(qpx, qpy, dx, dy) / den
    if t > 1e-9 and -1e-9 <= u <= 1 + 1e-9:
        return t
    return math.inf


def _move_would_cross(v, old_pos, new_pos, node_ids, edge_pairs, adjacency, pos_by_id):
    EPS = 1e-9
    for (a_raw, b_raw) in edge_pairs:
        a, b = str(a_raw), str(b_raw)
        if a == v or b == v:
            continue
        pa = pos_by_id.get(a)
        pb = pos_by_id.get(b)
        if pa is None or pb is None:
            continue
        if geo.point_on_segment_interior(pa, pb, new_pos, EPS):
            return True
        if geo.segments_intersect_or_touch(old_pos, new_pos, pa, pb, EPS):
            return True
    incident = adjacency.get(v, [])
    for u_raw in incident:
        u = str(u_raw)
        pu = pos_by_id.get(u)
        if pu is None:
            continue
        for (a_raw, b_raw) in edge_pairs:
            a, b = str(a_raw), str(b_raw)
            if a == v or b == v or a == u or b == u:
                continue
            pa = pos_by_id.get(a)
            pb = pos_by_id.get(b)
            if pa is None or pb is None:
                continue
            if geo.segments_intersect_or_touch(new_pos, pu, pa, pb, EPS):
                return True
        for w_raw in node_ids:
            w = str(w_raw)
            if w == v or w == u:
                continue
            pw = pos_by_id.get(w)
            if pw is None:
                continue
            if geo.point_on_segment_interior(new_pos, pu, pw, EPS):
                return True
    return False


def _sector_index(dx, dy, sector_count):
    a = math.atan2(dy, dx)
    if a < 0:
        a += 2 * math.pi
    k = int(math.floor((a / (2 * math.pi)) * sector_count))
    if k < 0:
        k = 0
    if k >= sector_count:
        k = sector_count - 1
    return k


def _compute_node_forces(node_ids, edge_pairs, adjacency, pos_by_id, opts):
    delta = opts["delta"]
    c_node_rep = opts["cNodeRep"]
    c_edge_attr = opts["cEdgeAttr"]
    c_node_edge_rep = opts["cNodeEdgeRep"]
    nearby_factor = opts["nearbyFactor"]
    forces: dict[str, list[float]] = {nid: [0.0, 0.0] for nid in node_ids}

    for i, vi in enumerate(node_ids):
        v = vi
        pv = pos_by_id[v]
        for j, vj in enumerate(node_ids):
            if i == j:
                continue
            u = vj
            pu = pos_by_id[u]
            dx = pv[0] - pu[0]
            dy = pv[1] - pu[1]
            dist = math.sqrt(dx * dx + dy * dy)
            if not (dist > 1e-9):
                continue
            ux = dx / dist
            uy = dy / dist
            fr = c_node_rep * (delta / dist) ** 2
            forces[v][0] += fr * ux
            forces[v][1] += fr * uy

        for u_raw in adjacency.get(v, []):
            u = str(u_raw)
            pu = pos_by_id[u]
            dx = pu[0] - pv[0]
            dy = pu[1] - pv[1]
            dist = math.sqrt(dx * dx + dy * dy)
            if not (dist > 1e-9):
                continue
            ux = dx / dist
            uy = dy / dist
            fa = c_edge_attr * (dist / delta)
            forces[v][0] += fa * ux
            forces[v][1] += fa * uy

    for v in node_ids:
        pv = pos_by_id[v]
        for (a_raw, b_raw) in edge_pairs:
            a, b = str(a_raw), str(b_raw)
            if a == v or b == v:
                continue
            pa = pos_by_id.get(a)
            pb = pos_by_id.get(b)
            if pa is None or pb is None:
                continue
            proj = _project_point_on_segment(pv[0], pv[1], pa[0], pa[1], pb[0], pb[1])
            if proj is not None:
                qx, qy, _ = proj
            else:
                da = math.hypot(pv[0] - pa[0], pv[1] - pa[1])
                db = math.hypot(pv[0] - pb[0], pv[1] - pb[1])
                q = pa if da <= db else pb
                qx, qy = q[0], q[1]
            dx = pv[0] - qx
            dy = pv[1] - qy
            dist = math.sqrt(dx * dx + dy * dy)
            if not (dist > 1e-9):
                continue
            if dist > nearby_factor * delta:
                continue
            ux = dx / dist
            uy = dy / dist
            fe = c_node_edge_rep * (delta / dist) ** 2
            forces[v][0] += fe * ux
            forces[v][1] += fe * uy
    return forces


def _compute_movement_limits(node_ids, edge_pairs, pos_by_id, max_move, sector_count):
    limits = {nid: [max_move] * sector_count for nid in node_ids}
    for v in node_ids:
        pv = pos_by_id[v]
        for s in range(sector_count):
            ang = ((s + 0.5) / sector_count) * 2 * math.pi
            dx = math.cos(ang)
            dy = math.sin(ang)
            best = max_move
            for (a_raw, b_raw) in edge_pairs:
                a, b = str(a_raw), str(b_raw)
                if a == v or b == v:
                    continue
                pa = pos_by_id.get(a)
                pb = pos_by_id.get(b)
                if pa is None or pb is None:
                    continue
                t = _ray_segment_distance(pv[0], pv[1], dx, dy, pa[0], pa[1], pb[0], pb[1])
                if t < best:
                    best = t
            limits[v][s] = max(0, best - 1e-4)
    return limits


def _find_crossing_edge_pairs(edge_pairs, pos_by_id):
    out = []
    n = len(edge_pairs)
    for i in range(n):
        a1, b1 = str(edge_pairs[i][0]), str(edge_pairs[i][1])
        p1 = pos_by_id.get(a1); q1 = pos_by_id.get(b1)
        if p1 is None or q1 is None:
            continue
        for j in range(i + 1, n):
            a2, b2 = str(edge_pairs[j][0]), str(edge_pairs[j][1])
            if a1 == a2 or a1 == b2 or b1 == a2 or b1 == b2:
                continue
            p2 = pos_by_id.get(a2); q2 = pos_by_id.get(b2)
            if p2 is None or q2 is None:
                continue
            if geo.segments_intersect_or_touch(p1, q1, p2, q2, 1e-9):
                out.append({"e1": (a1, b1), "e2": (a2, b2)})
    return out


def _resolve_crossings_by_vertex_rollback(pos_by_id, prev_pos_by_id, edge_pairs, fixed_outer):
    EPS = 1e-9
    max_rounds = 64
    rolled_back: set[str] = set()

    def moved_distance(v):
        cur = pos_by_id.get(v)
        prev = prev_pos_by_id.get(v)
        if cur is None or prev is None:
            return 0.0
        return math.hypot(cur[0] - prev[0], cur[1] - prev[1])

    for _ in range(max_rounds):
        crossings = _find_crossing_edge_pairs(edge_pairs, pos_by_id)
        if not crossings:
            return {"resolved": True, "rolledBack": rolled_back}
        changed = False
        for pair in crossings:
            candidates = [pair["e1"][0], pair["e1"][1], pair["e2"][0], pair["e2"][1]]
            best_v = None
            best_dist = 0.0
            for c in candidates:
                v = str(c)
                if v in fixed_outer:
                    continue
                d = moved_distance(v)
                if d > best_dist + EPS:
                    best_dist = d
                    best_v = v
            if best_v is not None and best_dist > EPS and prev_pos_by_id.get(best_v) is not None:
                pp = prev_pos_by_id[best_v]
                pos_by_id[best_v] = (pp[0], pp[1])
                rolled_back.add(best_v)
                changed = True
        if not changed:
            break
    resolved = len(_find_crossing_edge_pairs(edge_pairs, pos_by_id)) == 0
    return {"resolved": resolved, "rolledBack": rolled_back}


def _build_seed(g, layout_input):
    init = preprocessing.compute_initial_positions(
        layout_input["augmented"]["graph"],
        layout_input["augmentedOuterFace"],
        layout_input["augmented"]["embedding"],
        layout_input["graph"],
    )
    if not init or not init.get("ok") or not init.get("positions"):
        return gu.build_layout_error(init or {"message": "ImPrEd initialization failed", "graph": g})
    return {
        "baseEmbedding": layout_input.get("baseEmbedding"),
        "outerFace": list(layout_input["outerFace"]) if layout_input.get("outerFace") else None,
        "posById": geo.copy_position_map(init["positions"]),
    }


def _run_iterations(g, seed, options):
    pos_by_id = geo.copy_position_map(seed["posById"] or {})
    fixed_outer = {str(x) for x in seed["outerFace"]}
    delta = _estimate_delta(g.edge_pairs, pos_by_id)
    max_iters = IMPRED_CONFIG["maxIters"]
    start_max_move = IMPRED_CONFIG["maxMoveFactor"] * delta
    min_max_move = IMPRED_CONFIG["minMaxMoveFactor"] * delta
    sector_count = IMPRED_CONFIG["sectorCount"]
    force_scale = IMPRED_CONFIG["forceScale"]
    c_node_rep = IMPRED_CONFIG["nodeRepulsion"]
    c_edge_attr = IMPRED_CONFIG["edgeAttraction"]
    c_node_edge_rep = IMPRED_CONFIG["nodeEdgeRepulsion"]
    nearby_factor = IMPRED_CONFIG["nearbyFactor"]
    momentum_beta = IMPRED_CONFIG["momentumBeta"]
    rejected_damp = IMPRED_CONFIG["rejectedVelocityDamp"]
    rollback_damp = IMPRED_CONFIG["rollbackVelocityDamp"]
    full_rollback_damp = IMPRED_CONFIG["fullRollbackVelocityDamp"]
    movement_tracker = gu.create_movement_convergence_tracker({
        "minItersBeforeStop": IMPRED_CONFIG["minItersBeforeStop"],
        "stableIterLimit": IMPRED_CONFIG["stableIterLimit"],
        "maxMoveTol": IMPRED_CONFIG["movementStopTolFactor"] * delta,
        "avgMoveTol": IMPRED_CONFIG["avgMovementStopTolFactor"] * delta,
    })
    velocity_by_id = {nid: [0.0, 0.0] for nid in g.node_ids}
    stop_reason = "max-iters"
    last_stats = gu.MoveStats(moved_vertices=0, total_move=0, avg_move=0, max_move=0)
    iter_ = 0

    for iter_ in range(max_iters):
        prev_pos = geo.copy_position_map(pos_by_id)
        alpha = (iter_ / (max_iters - 1)) if max_iters > 1 else 1
        max_move = start_max_move + alpha * (min_max_move - start_max_move)
        forces = _compute_node_forces(g.node_ids, g.edge_pairs, g.adjacency, pos_by_id, {
            "delta": delta,
            "cNodeRep": c_node_rep * (1.0 + 3.0 * alpha),
            "cEdgeAttr": c_edge_attr * (1.0 - 0.6 * alpha),
            "cNodeEdgeRep": c_node_edge_rep,
            "nearbyFactor": nearby_factor,
        })
        limits = _compute_movement_limits(g.node_ids, g.edge_pairs, pos_by_id, max_move, sector_count)
        for v in g.node_ids:
            if v in fixed_outer:
                velocity_by_id[v] = [0.0, 0.0]
                continue
            f = forces.get(v)
            if f is None:
                continue
            fmag = math.hypot(f[0], f[1])
            if not (fmag > 1e-9):
                continue
            k = _sector_index(f[0], f[1], sector_count)
            allowed = limits[v][k]
            if not (allowed > 1e-9):
                continue
            step = min(allowed, force_scale * fmag)
            if not (step > 1e-9):
                continue
            ux = f[0] / fmag
            uy = f[1] / fmag
            old_p = pos_by_id[v]
            prev_vel = velocity_by_id.get(v, [0.0, 0.0])
            proposed_dx = ux * step
            proposed_dy = uy * step
            vel_x = momentum_beta * prev_vel[0] + (1 - momentum_beta) * proposed_dx
            vel_y = momentum_beta * prev_vel[1] + (1 - momentum_beta) * proposed_dy
            vel_mag = math.hypot(vel_x, vel_y)
            if vel_mag > allowed and vel_mag > 1e-12:
                sc = allowed / vel_mag
                vel_x *= sc
                vel_y *= sc
            new_p = (old_p[0] + vel_x, old_p[1] + vel_y)
            shrink = 0
            while _move_would_cross(v, old_p, new_p, g.node_ids, g.edge_pairs, g.adjacency, pos_by_id) and shrink < 12:
                new_p = (old_p[0] + (new_p[0] - old_p[0]) * 0.5, old_p[1] + (new_p[1] - old_p[1]) * 0.5)
                shrink += 1
            if _move_would_cross(v, old_p, new_p, g.node_ids, g.edge_pairs, g.adjacency, pos_by_id):
                velocity_by_id[v][0] *= rejected_damp
                velocity_by_id[v][1] *= rejected_damp
                continue
            moved_dx = new_p[0] - old_p[0]
            moved_dy = new_p[1] - old_p[1]
            if math.hypot(moved_dx, moved_dy) > 1e-6:
                pos_by_id[v] = new_p
                velocity_by_id[v] = [moved_dx, moved_dy]
            else:
                velocity_by_id[v][0] *= rejected_damp
                velocity_by_id[v][1] *= rejected_damp

        has_crossings = geo.has_position_crossings(pos_by_id, g.edge_pairs)
        if has_crossings:
            rollback = _resolve_crossings_by_vertex_rollback(pos_by_id, prev_pos, g.edge_pairs, fixed_outer)
            if not rollback["resolved"]:
                pos_by_id = prev_pos
                for vid in g.node_ids:
                    velocity_by_id[vid][0] *= full_rollback_damp
                    velocity_by_id[vid][1] *= full_rollback_damp
                has_crossings = False
            else:
                for rv in rollback["rolledBack"]:
                    if rv in velocity_by_id:
                        velocity_by_id[rv][0] *= rollback_damp
                        velocity_by_id[rv][1] *= rollback_damp
                has_crossings = geo.has_position_crossings(pos_by_id, g.edge_pairs)
                if has_crossings:
                    pos_by_id = prev_pos
                    for vid in g.node_ids:
                        velocity_by_id[vid][0] *= full_rollback_damp
                        velocity_by_id[vid][1] *= full_rollback_damp
                    has_crossings = False

        last_stats = gu.compute_position_move_stats(g.node_ids, prev_pos, pos_by_id, {"moveTol": 1e-6})
        movement_status = movement_tracker.update(
            {"maxMove": last_stats.max_move, "avgMove": last_stats.avg_move}, iter_ + 1
        )
        if last_stats.moved_vertices == 0:
            stop_reason = "no-movement"
            break
        if movement_status.converged:
            stop_reason = movement_status.reason or "movement-converged"
            break

    # Restrict positions to original nodes only (mock cy filters dummies).
    final_pos = geo.filter_position_map(pos_by_id, g.node_ids)
    return gu.build_layout_result({
        "nodeIds": g.node_ids,
        "edgePairs": g.edge_pairs,
        "graph": g,
        "outerFace": list(seed["outerFace"]) if seed.get("outerFace") else None,
        "embedding": seed.get("baseEmbedding"),
        "positions": final_pos,
        "iters": iter_ + 1,
        "stopReason": stop_reason,
        "totalMove": last_stats.total_move,
        "maxMove": last_stats.max_move,
        "avgMove": last_stats.avg_move,
    })


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    if not graph.edge_pairs:
        return gu.build_layout_error({"message": "ImPrEd requires at least 1 edge", "graph": graph})
    layout_input = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "ImPrEd layout",
        "augmentationMethod": opts.get("augmentationMethod"),
        "currentPositions": initial_positions or {},
    })
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error(layout_input or {"message": "ImPrEd failed"})
    seed = _build_seed(graph, layout_input)
    if not isinstance(seed, dict) or seed.get("ok") is False:
        return seed if isinstance(seed, dict) else gu.build_layout_error({"message": "ImPrEd failed"})
    result = _run_iterations(graph, seed, opts)
    if result.get("ok"):
        result["message"] = gu.build_layout_status_message("ImPrEd", {
            "vertexCount": len(result["nodeIds"]),
            "iters": result.get("iters"),
            "stopReason": result.get("stopReason"),
        })
    return result
