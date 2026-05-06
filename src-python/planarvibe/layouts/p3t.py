"""P3T equal-face-area layout (planar 3-trees only). Port of static/js/layout-p3t.js."""

from __future__ import annotations

import math
import sys
from typing import Sequence

from .. import geometry as geo
from .. import graph as gu
from .. import planarity


def _clique_key(a: str, b: str, c: str, index_by_id: dict[str, int]) -> str:
    arr = sorted([a, b, c], key=lambda x: index_by_id[x])
    return f"{arr[0]}|{arr[1]}|{arr[2]}"


def _compute_p3t_positions(graph) -> dict:
    info = planarity.analyze_planar_3_tree(graph)
    if not info.get("ok"):
        return gu.build_layout_error({"message": "P3T requires a planar 3-tree: " + str(info.get("reason", ""))})

    emb = info["embedding"]
    outer = list(info["outerFace"])
    index_by_id = emb["indexById"]

    parents2v: dict[str, str] = {}
    for rec in reversed(info["elimination"]):
        parents2v[_clique_key(rec["parents"][0], rec["parents"][1], rec["parents"][2], index_by_id)] = rec["vertex"]

    count_internals: dict[str, int] = {}
    sys.setrecursionlimit(max(10000, sys.getrecursionlimit()))

    def count_internal(v0, v1, v2):
        key = _clique_key(v0, v1, v2, index_by_id)
        v = parents2v.get(key)
        if v is None:
            count_internals[key] = 0
            return 0
        c0 = count_internal(v1, v2, v)
        c1 = count_internal(v2, v0, v)
        c2 = count_internal(v0, v1, v)
        count_internals[key] = c0 + c1 + c2 + 1
        return count_internals[key]

    coord: dict[str, tuple[float, float]] = {}
    for i in range(len(outer)):
        angle = 2.0 * math.pi * i / len(outer)
        coord[outer[len(outer) - i - 1]] = (1000 * math.cos(angle) + 2000, 1000 * math.sin(angle) + 2000)

    count_internal(outer[0], outer[1], outer[2])

    def process_clique(v0, v1, v2):
        key = _clique_key(v0, v1, v2, index_by_id)
        v = parents2v.get(key)
        if v is None:
            return
        k0 = _clique_key(v1, v2, v, index_by_id)
        k1 = _clique_key(v2, v0, v, index_by_id)
        k2 = _clique_key(v0, v1, v, index_by_id)
        a0 = count_internals.get(k0, 0) * 2 + 1
        a1 = count_internals.get(k1, 0) * 2 + 1
        a2 = count_internals.get(k2, 0) * 2 + 1
        total = a0 + a1 + a2
        x0, y0 = coord[v0]; x1_, y1_ = coord[v1]; x2_, y2_ = coord[v2]
        coord[v] = ((a0 * x0 + a1 * x1_ + a2 * x2_) / total, (a0 * y0 + a1 * y1_ + a2 * y2_) / total)
        process_clique(v1, v2, v)
        process_clique(v2, v0, v)
        process_clique(v0, v1, v)

    process_clique(outer[0], outer[1], outer[2])

    result = gu.build_layout_result({
        "nodeIds": graph.node_ids,
        "edgePairs": graph.edge_pairs,
        "outerFace": list(outer),
        "graph": graph,
        "embedding": emb,
        "positions": geo.normalize_position_map_to_viewport(coord),
    })
    result["message"] = f"Applied P3T equal-face-area layout ({len(graph.node_ids)} vertices)"
    return result


def apply_layout(graph, initial_positions: dict | None = None, options: dict | None = None) -> dict:
    return _compute_p3t_positions(graph)
