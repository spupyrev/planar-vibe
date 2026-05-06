"""Schnyder grid drawing. Port of static/js/layout-schnyder.js."""

from __future__ import annotations

import math
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import preprocessing

SCHNYDER_PREPARE_OPTIONS = {"triangulateOuterFace": True}


def _build_rotation_by_id(embedding: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    rot = embedding["rotation"]
    for i, nid in enumerate(embedding["idByIndex"]):
        out[str(nid)] = [str(x) for x in (rot[i] if i < len(rot) else [])]
    return out


def _contract(node_ids, adjacency, a, b, c) -> list[str]:
    N = sum(len(adjacency.get(nid, [])) for nid in node_ids) // 2
    marked: dict[str, bool] = {nid: False for nid in node_ids}
    deg: dict[str, int] = {nid: 0 for nid in node_ids}
    L: list[str] = []
    candidates: list[str] = []

    marked[a] = marked[b] = marked[c] = True
    deg[a] = deg[b] = deg[c] = N

    an = list(adjacency.get(a, []))
    for x in an:
        marked[x] = True
        for y in adjacency.get(x, []):
            deg[y] = deg.get(y, 0) + 1
    for x in an:
        if deg[x] <= 2:
            candidates.append(x)

    while candidates:
        u = candidates.pop(0)
        if deg[u] != 2:
            continue
        L.insert(0, u)
        deg[u] = N
        for nb in adjacency.get(u, []):
            deg[nb] = deg.get(nb, 0) - 1
            if not marked.get(nb):
                marked[nb] = True
                for t in adjacency.get(nb, []):
                    deg[t] = deg.get(t, 0) + 1
                if deg[nb] <= 2:
                    candidates.append(nb)
            elif deg[nb] == 2:
                candidates.append(nb)
    return L


def _add_directed_labeled_edge(out_adj_by_label: dict, src: str, dst: str, label: int) -> None:
    a = out_adj_by_label[label]
    if src not in a:
        a[src] = []
    a[src].append(dst)


def _realizer(node_ids, L, a, b, c, rotation_by_id, adjacency) -> dict:
    ord_: dict[str, int] = {}
    i = 0
    ord_[b] = i; i += 1
    ord_[c] = i; i += 1
    for x in L:
        ord_[x] = i; i += 1
    ord_[a] = i; i += 1

    out_adj_by_label = {1: {}, 2: {}, 3: {}}
    for nid in node_ids:
        out_adj_by_label[1][nid] = []
        out_adj_by_label[2][nid] = []
        out_adj_by_label[3][nid] = []

    for v in L:
        rot = rotation_by_id.get(v, [])
        if not rot:
            return gu.build_layout_error({"reason": f"Missing rotation at vertex {v}"})
        first_idx = -1
        for j, w in enumerate(rot):
            if (ord_.get(w, 0)) > (ord_.get(v, 0)):
                first_idx = j
                break
        if first_idx < 0:
            return gu.build_layout_error({"reason": f"Could not find higher-order neighbor at vertex {v}"})

        idx1 = first_idx
        while (ord_.get(rot[idx1], 0)) > (ord_.get(v, 0)):
            idx1 = (idx1 + 1) % len(rot)
        _add_directed_labeled_edge(out_adj_by_label, rot[idx1], v, 2)

        idx2 = first_idx
        while (ord_.get(rot[idx2], 0)) > (ord_.get(v, 0)):
            idx2 = (idx2 - 1) % len(rot)
        _add_directed_labeled_edge(out_adj_by_label, rot[idx2], v, 3)

        walk = (idx1 + 1) % len(rot)
        while walk != idx2:
            _add_directed_labeled_edge(out_adj_by_label, v, rot[walk], 1)
            walk = (walk + 1) % len(rot)

    for x in adjacency.get(a, []):
        _add_directed_labeled_edge(out_adj_by_label, a, x, 1)
    _add_directed_labeled_edge(out_adj_by_label, b, a, 2)
    _add_directed_labeled_edge(out_adj_by_label, b, c, 2)
    _add_directed_labeled_edge(out_adj_by_label, c, a, 3)
    _add_directed_labeled_edge(out_adj_by_label, c, b, 3)

    return gu.build_layout_result({"ord": ord_, "outAdjByLabel": out_adj_by_label})


def _subtree_sizes(out_adj_by_label: dict, label: int, root: str) -> dict[str, int]:
    memo: dict[str, int] = {}
    visiting: dict[str, bool] = {}
    adj = out_adj_by_label[label]

    def dfs(v: str) -> int:
        if v in memo:
            return memo[v]
        if visiting.get(v):
            return 1
        visiting[v] = True
        s = 0
        for w in adj.get(v, []):
            s += dfs(w)
        visiting[v] = False
        memo[v] = s + 1
        return memo[v]

    import sys
    sys.setrecursionlimit(max(10000, sys.getrecursionlimit()))
    dfs(root)
    return memo


def _prefix_sum(out_adj_by_label: dict, label: int, root: str, val: dict[str, float]) -> dict[str, float]:
    summed: dict[str, float] = {}
    adj = out_adj_by_label[label]
    queue = [root]
    summed[root] = float(val.get(root, 0))
    head = 0
    while head < len(queue):
        v = queue[head]; head += 1
        for w in adj.get(v, []):
            if w in summed:
                continue
            summed[w] = float(val.get(w, 0)) + summed[v]
            queue.append(w)
    return summed


def _compute_schnyder_coordinates(node_ids, realizer_out, a, b, c) -> dict:
    out_adj = realizer_out["outAdjByLabel"]
    t1 = _subtree_sizes(out_adj, 1, a)
    t2 = _subtree_sizes(out_adj, 2, b)
    ones = {nid: 1.0 for nid in node_ids}
    p1 = _prefix_sum(out_adj, 1, a, ones)
    p2 = _prefix_sum(out_adj, 2, b, ones)
    p3 = _prefix_sum(out_adj, 3, c, ones)

    sum1 = _prefix_sum(out_adj, 2, b, {k: float(v) for k, v in t1.items()})
    sum1[a] = float(t1.get(a, 1))
    sum2 = _prefix_sum(out_adj, 3, c, {k: float(v) for k, v in t1.items()})
    sum2[a] = float(t1.get(a, 1))

    x: dict[str, float] = {}
    for v in node_ids:
        r1 = sum1.get(v, 0) + sum2.get(v, 0) - t1.get(v, 1)
        x[v] = r1 - p3.get(v, 1)

    sum1 = _prefix_sum(out_adj, 3, c, {k: float(v) for k, v in t2.items()})
    sum1[b] = float(t2.get(b, 1))
    sum2 = _prefix_sum(out_adj, 1, a, {k: float(v) for k, v in t2.items()})
    sum2[b] = float(t2.get(b, 1))

    y: dict[str, float] = {}
    for v in node_ids:
        r2 = sum1.get(v, 0) + sum2.get(v, 0) - t2.get(v, 1)
        y[v] = r2 - p1.get(v, 1)

    return {"x": x, "y": y}


def _build_screen_positions(coords: dict, node_ids: Sequence[str]) -> dict | None:
    min_x = math.inf
    max_y = -math.inf
    for nid in node_ids:
        xi = coords["x"].get(nid)
        yi = coords["y"].get(nid)
        if xi is None or yi is None or not math.isfinite(xi) or not math.isfinite(yi):
            return None
        if xi < min_x:
            min_x = xi
        if yi > max_y:
            max_y = yi
    if not math.isfinite(min_x) or not math.isfinite(max_y):
        return None
    SCALE = 30.0
    out: dict[str, tuple[float, float]] = {}
    for nid in node_ids:
        out[nid] = ((coords["x"][nid] - min_x) * SCALE + 20, (max_y - coords["y"][nid]) * SCALE + 20)
    return out


def _group_overlaps(pos_by_id: dict) -> list[list[str]]:
    buckets: dict[str, list[str]] = {}
    for nid, p in (pos_by_id or {}).items():
        if p is None or not math.isfinite(p[0]) or not math.isfinite(p[1]):
            continue
        k = f"{p[0]},{p[1]}"
        buckets.setdefault(k, []).append(nid)
    out: list[list[str]] = []
    for v in buckets.values():
        if len(v) > 1:
            v.sort()
            out.append(v)
    return out


def _count_overlap_extras(groups: list[list[str]]) -> int:
    return sum(len(g) - 1 for g in groups)


def _resolve_overlaps_without_crossings(pos_by_id: dict, edge_pairs: Sequence[tuple[str, str]]) -> dict | None:
    overlap_groups = _group_overlaps(pos_by_id)
    if not overlap_groups:
        return geo.copy_position_map(pos_by_id)
    pos = geo.copy_position_map(pos_by_id)
    DIRS = 24
    ring = [(math.cos(2 * math.pi * a / DIRS), math.sin(2 * math.pi * a / DIRS)) for a in range(DIRS)]
    radii = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]

    for group in overlap_groups:
        anchor = pos[group[0]]
        placed = False
        for radius in radii:
            if placed:
                break
            for phase in range(len(ring)):
                if placed:
                    break
                trial = geo.copy_position_map(pos)
                for i, nid in enumerate(group):
                    idx = (phase + (i * len(ring)) // len(group)) % len(ring)
                    dx, dy = ring[idx]
                    trial[nid] = (anchor[0] + dx * radius, anchor[1] + dy * radius)
                if _group_overlaps(trial):
                    continue
                if geo.has_position_crossings(trial, edge_pairs):
                    continue
                pos = trial
                placed = True
        if not placed:
            return None
    if _group_overlaps(pos) or geo.has_position_crossings(pos, edge_pairs):
        return None
    return pos


def _candidate_outer_triples(emb: dict, rotation_by_id: dict) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    edges = emb.get("edges") or []
    if not edges:
        return out
    e0 = edges[0]
    a = str(e0[0])
    b = str(e0[1])
    rot_b = rotation_by_id.get(b, [])
    try:
        idx_a = rot_b.index(a)
    except ValueError:
        return out
    c = str(rot_b[(idx_a - 1) % len(rot_b)])
    out.append((a, b, c))
    out.append((a, c, b))
    return out


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    opts = options or {}
    prepared = preprocessing.prepare_graph_data(graph, {
        "failureLabel": "Schnyder",
        "currentPositions": initial_positions or {},
        "augmentationMethod": opts.get("augmentationMethod"),
        "augmentationOptions": SCHNYDER_PREPARE_OPTIONS,
    })
    if not prepared or not prepared.get("ok"):
        return gu.build_layout_error(prepared or {"message": "Schnyder failed"})

    emb = prepared["augmented"]["embedding"]
    rotation_by_id = _build_rotation_by_id(emb)
    augmented_graph = prepared["augmented"]["graph"]
    adjacency = {k: list(v) for k, v in augmented_graph.adjacency.items()}
    g = prepared["graph"]

    best_pos = None
    best_overlap_count = float("inf")
    candidates = _candidate_outer_triples(emb, rotation_by_id)
    if not candidates and emb.get("outerFace") and len(emb["outerFace"]) >= 3:
        of = emb["outerFace"]
        candidates = [(str(of[0]), str(of[1]), str(of[2]))]

    for (a, b, c) in candidates:
        L = _contract(augmented_graph.node_ids, adjacency, a, b, c)
        if len(L) != len(augmented_graph.node_ids) - 3:
            continue
        r = _realizer(augmented_graph.node_ids, L, a, b, c, rotation_by_id, adjacency)
        if not r.get("ok"):
            continue
        coords = _compute_schnyder_coordinates(augmented_graph.node_ids, r, a, b, c)
        pos = _build_screen_positions(coords, g.node_ids)
        if not pos:
            continue
        if geo.has_position_crossings(pos, g.edge_pairs):
            continue
        overlap_groups = _group_overlaps(pos)
        if overlap_groups:
            resolved = _resolve_overlaps_without_crossings(pos, g.edge_pairs)
            if resolved:
                pos = resolved
                overlap_groups = _group_overlaps(pos)
        overlap_count = _count_overlap_extras(overlap_groups)
        if overlap_count < best_overlap_count:
            best_overlap_count = overlap_count
            best_pos = pos
        if overlap_count == 0:
            break

    if best_pos is None:
        return gu.build_layout_error({"message": "Schnyder failed to find crossing-free embedding", "graph": g})

    final_pos = geo.normalize_position_map_to_viewport(best_pos)
    result = gu.build_layout_result({
        "nodeIds": g.node_ids,
        "edgePairs": g.edge_pairs,
        "graph": g,
        "positions": final_pos,
    })
    result["message"] = gu.build_layout_status_message("Schnyder layout", {"vertexCount": len(g.node_ids)})
    return result
