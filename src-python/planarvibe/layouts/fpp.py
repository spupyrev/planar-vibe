"""de Fraysseix-Pach-Pollack grid drawing. Port of static/js/layout-fpp.js."""

from __future__ import annotations

from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import preprocessing

FPP_PREPARE_OPTIONS = {"triangulateOuterFace": True}


def _compute_canonical_ordering(layout_input: dict) -> dict:
    if not layout_input or not layout_input.get("ok"):
        return gu.build_layout_error({"reason": "Missing layoutInput embedding"})
    aug = layout_input.get("augmented") or {}
    embedding = aug.get("embedding")
    if not embedding or not embedding.get("ok"):
        return gu.build_layout_error({"reason": "Missing embedding"})

    node_ids = list(embedding["idByIndex"])
    if len(node_ids) < 3:
        return gu.build_layout_error({"reason": "Need at least 3 vertices"})
    outer_face = list(embedding.get("outerFace") or [])
    if len(outer_face) != 3:
        return gu.build_layout_error({"reason": "Triangulated embedding must have triangular outer face"})

    rotation_by_id: dict[str, list[str]] = {}
    for r, nid in enumerate(embedding["idByIndex"]):
        rot = embedding["rotation"]
        rotation_by_id[nid] = list(rot[r]) if isinstance(rot, list) and r < len(rot) else []

    adjacency = {k: set(v) for k, v in aug["graph"].adjacency_sets.items()}

    def rotation_path_inclusive(v, start, end):
        nbrs = rotation_by_id.get(v, [])
        if not nbrs:
            return None
        try:
            i_start = nbrs.index(start)
            i_end = nbrs.index(end)
        except ValueError:
            return None
        out = [start]
        cur = i_start
        while cur != i_end:
            cur = (cur + 1) % len(nbrs)
            out.append(nbrs[cur])
            if len(out) > len(nbrs) + 1:
                return None
        return out

    def score_replacement_path(path, outer_set, remaining):
        if not path or len(path) < 2:
            return -1
        score = 0
        for s in range(1, len(path) - 1):
            x = path[s]
            if x in remaining and x not in outer_set:
                score += 2
            elif x in remaining:
                score += 1
        return score

    def choose_replacement_path(v, pred, succ, outer_set, remaining):
        path_a = rotation_path_inclusive(v, pred, succ)
        path_b = rotation_path_inclusive(v, succ, pred)
        if path_b is not None:
            path_b = list(reversed(path_b))
        sa = score_replacement_path(path_a, outer_set, remaining)
        sb = score_replacement_path(path_b, outer_set, remaining)
        if sa > sb:
            return path_a
        if sb > sa:
            return path_b
        if path_a is not None and path_b is not None:
            if len(path_a) != len(path_b):
                return path_a if len(path_a) > len(path_b) else path_b
            return path_a if "\x01".join(path_a) <= "\x01".join(path_b) else path_b
        return path_a or path_b or [pred, succ]

    def sanitize_replacement_path(path, pred, succ, outer_set, remaining):
        if not path or len(path) < 2:
            return [pred, succ]
        if path[0] != pred or path[-1] != succ:
            return [pred, succ]
        out = [pred]
        seen = {pred}
        for i in range(1, len(path) - 1):
            x = path[i]
            if x not in remaining or x in outer_set or x in seen:
                continue
            out.append(x)
            seen.add(x)
        out.append(succ)
        return out

    def build_next_outer_cycle(outer_cycle, remove_idx, replacement_path):
        n = len(outer_cycle)
        succ_idx = (remove_idx + 1) % n
        pred_idx = (remove_idx - 1) % n
        succ = outer_cycle[succ_idx]
        pred = outer_cycle[pred_idx]
        interior = list(replacement_path[1:-1])
        walk = []
        t = succ_idx
        while t != remove_idx:
            walk.append(outer_cycle[t])
            t = (t + 1) % n
        if not walk or walk[-1] != pred:
            return None
        return walk + interior

    def compute_chord_counts(outer_cycle, remaining):
        outer_set = set(outer_cycle)
        boundary_edge_set: set[str] = set()
        for i in range(len(outer_cycle)):
            a = outer_cycle[i]
            b = outer_cycle[(i + 1) % len(outer_cycle)]
            boundary_edge_set.add(gu.edge_key(str(a), str(b)))
        chords: dict[str, int] = {}
        for v in outer_cycle:
            count = 0
            seen: set = set()
            neigh = list(adjacency.get(v, set()))
            for u in neigh:
                if u not in remaining or u not in outer_set or u == v:
                    continue
                ek = gu.edge_key(str(v), str(u))
                if ek in boundary_edge_set or u in seen:
                    continue
                seen.add(u)
                count += 1
            chords[v] = count
        return chords

    v1, v2, vn = outer_face[0], outer_face[1], outer_face[2]
    remaining = set(node_ids)
    outer_cycle = [v1, vn, v2]
    removed: list[str] = []
    contour_neighbors_by_vertex: dict[str, list[str]] = {}
    mark = {v1: True, v2: True}
    out_flag = {v1: True, v2: True, vn: True}

    while len(remaining) > 3:
        outer_set = set(outer_cycle)
        chords = compute_chord_counts(outer_cycle, remaining)
        chosen = None
        chosen_idx = -1

        if len(remaining) == len(node_ids):
            chosen = vn
            chosen_idx = outer_cycle.index(vn)
        else:
            for c, cand in enumerate(outer_cycle):
                if mark.get(cand) or not out_flag.get(cand) or cand == v1 or cand == v2:
                    continue
                if chords.get(cand, 0) == 0:
                    chosen = cand
                    chosen_idx = c
                    break

        if chosen is None or chosen_idx == -1:
            return gu.build_layout_error({"reason": "Could not find shelling vertex for canonical ordering"})

        pred = outer_cycle[(chosen_idx - 1) % len(outer_cycle)]
        succ = outer_cycle[(chosen_idx + 1) % len(outer_cycle)]
        replacement_path = choose_replacement_path(chosen, pred, succ, outer_set, remaining)
        replacement_path = sanitize_replacement_path(replacement_path, pred, succ, outer_set, remaining)
        contour_neighbors_by_vertex[chosen] = list(replacement_path)

        next_cycle = build_next_outer_cycle(outer_cycle, chosen_idx, replacement_path)
        if next_cycle is None or len(next_cycle) < 2:
            return gu.build_layout_error({"reason": "Failed to update outer cycle during canonical ordering"})

        mark[chosen] = True
        for rp in range(1, len(replacement_path) - 1):
            out_flag[replacement_path[rp]] = True

        for nb in list(adjacency.get(chosen, set())):
            if nb in adjacency:
                adjacency[nb].discard(chosen)
        adjacency[chosen] = set()
        remaining.discard(chosen)
        removed.append(chosen)
        outer_cycle = next_cycle

    base = list(remaining)
    if len(base) != 3:
        return gu.build_layout_error({"reason": "Canonical reduction did not end with 3 vertices"})
    if v1 not in base or v2 not in base:
        return gu.build_layout_error({"reason": "Canonical base does not contain fixed outer edge"})
    v3 = next((b for b in base if b != v1 and b != v2), None)
    if v3 is None:
        return gu.build_layout_error({"reason": "Canonical base triangle is invalid"})

    order = [v1, v2, v3] + list(reversed(removed))
    if len(order) != len(node_ids) or len(set(order)) != len(node_ids):
        return gu.build_layout_error({"reason": "Canonical ordering has duplicate or missing vertices"})

    return gu.build_layout_result({
        "order": list(order),
        "outerFace": [v1, v2, v3],
        "contourNeighborsByVertex": contour_neighbors_by_vertex,
    })


def _find_neighbor_segment(contour: list[str], neighbor_path: list[str]) -> dict | None:
    n = len(contour)
    if n == 0 or not neighbor_path or len(neighbor_path) < 2:
        return None

    def matches_path(path):
        m = len(path)
        if m > n:
            return None
        for start in range(n - m + 1):
            ok = True
            for i in range(m):
                if contour[start + i] != path[i]:
                    ok = False
                    break
            if ok:
                return {"start": start, "end": start + m - 1}
        return None

    seg = matches_path(neighbor_path)
    if seg:
        return seg
    return matches_path(list(reversed(neighbor_path)))


def _compute_fpp_positions_from_canonical(canonical: dict) -> dict:
    order = canonical.get("order") or []
    if not order or len(order) < 3:
        return gu.build_layout_error({"message": "Canonical ordering is too short for FPP"})
    contour_neighbors_by_vertex = canonical.get("contourNeighborsByVertex") or {}
    coords: dict[str, tuple[float, float]] = {}
    layers: dict[str, set[str]] = {}

    v1, v2, v3 = order[0], order[1], order[2]
    coords[v1] = (0.0, 0.0)
    coords[v2] = (2.0, 0.0)
    coords[v3] = (1.0, 1.0)
    base_y = coords[v1][1]
    layers[v1] = {v1}
    layers[v2] = {v2}
    layers[v3] = {v3}

    contour = [v1, v3, v2]

    def collect_layer_vertices(contour_list, from_idx, to_idx_inclusive):
        result: set[str] = set()
        if from_idx > to_idx_inclusive:
            return result
        for a in range(from_idx, to_idx_inclusive + 1):
            w = contour_list[a]
            layer = layers.get(w)
            if layer is None:
                continue
            for x in layer:
                result.add(x)
        return result

    def shift_x(vset, delta):
        for v in vset:
            if v in coords:
                x, y = coords[v]
                coords[v] = (x + delta, y)

    for i in range(3, len(order)):
        vk = order[i]
        neigh = contour_neighbors_by_vertex.get(vk)
        if neigh is None or len(neigh) < 2:
            return gu.build_layout_error({"message": f"Missing contour neighbors for vertex {vk}"})
        segment = _find_neighbor_segment(contour, neigh)
        if segment is None:
            return gu.build_layout_error({"message": f"Could not find consecutive contour segment for vertex {vk}"})
        p, q = segment["start"], segment["end"]
        wp = contour[p]
        wq = contour[q]
        if wp not in coords or wq not in coords:
            return gu.build_layout_error({"message": f"Missing endpoint coordinates for vertex {vk}"})

        inner = collect_layer_vertices(contour, p + 1, q - 1)
        right = collect_layer_vertices(contour, q, len(contour) - 1)
        shift_x(inner, 1)
        shift_x(right, 2)

        xq, yq = coords[wq]
        xp, yp = coords[wp]
        x = (xq + yq + xp - yp) / 2.0
        y = (xq + yq - xp + yp) / 2.0
        if y < base_y:
            return gu.build_layout_error({"message": f"FPP invariant violated: vertex {vk} placed below base edge (v1,v2)"})
        coords[vk] = (x, y)
        layers[vk] = set(inner)
        layers[vk].add(vk)
        for clear_idx in range(p + 1, q):
            layers[contour[clear_idx]] = set()
        contour = contour[: p + 1] + [vk] + contour[q:]

    SCALE = 30.0
    max_y = 0.0
    for nid in order:
        if nid in coords and coords[nid][1] > max_y:
            max_y = coords[nid][1]
    screen_pos: dict[str, tuple[float, float]] = {}
    for nid in order:
        sid = str(nid)
        if sid not in coords:
            continue
        cx, cy = coords[sid]
        screen_pos[sid] = (cx * SCALE + 20, (max_y - cy) * SCALE + 20)

    return gu.build_layout_result({
        "order": list(order),
        "outerFace": list(canonical.get("outerFace") or []),
        "positions": geo.normalize_position_map_to_viewport(screen_pos),
    })


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    prepared = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "FPP",
        "currentPositions": initial_positions or {},
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": FPP_PREPARE_OPTIONS,
    })
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": "FPP failed"})

    canonical = _compute_canonical_ordering(prepared)
    if not canonical.get("ok"):
        return gu.build_layout_error({
            "message": canonical.get("reason"),
            "graph": prepared.get("graph"),
            "outerFace": prepared.get("outerFace"),
        })

    placed = _compute_fpp_positions_from_canonical(canonical)
    if not placed or not placed.get("ok"):
        return gu.build_layout_error(placed or {"message": "FPP placement failed"})

    dummy_count = int(prepared["augmented"].get("dummyCount") or 0)
    extra = [f"after augmentation (+{dummy_count} dummy vertices)"] if dummy_count > 0 else None
    # Filter positions to only the original graph's nodes (the JS mock cy only
    # holds original nodes, so writes to dummy ids get dropped).
    projected = geo.filter_position_map(placed["positions"], prepared["graph"].node_ids)
    result = gu.build_layout_result({
        "nodeIds": prepared["graph"].node_ids,
        "edgePairs": prepared["graph"].edge_pairs,
        "outerFace": list(canonical.get("outerFace") or []),
        "graph": prepared["graph"],
        "augmentedDummyCount": dummy_count,
        "positions": projected,
    })
    result["message"] = gu.build_layout_status_message("FPP layout", {
        "vertexCount": len(prepared["graph"].node_ids),
        "extraParts": extra,
    })
    return result
