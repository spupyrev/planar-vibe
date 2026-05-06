"""Python CLI mirroring scripts/apply-layout.mjs.

Usage:
  python src-python/scripts/apply_layout.py <benchmark.dot> <graph-name> <algorithm>
       [--out PATH]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src-python"))

from planarvibe import benchmarks, geometry, metrics
from planarvibe.graph import create_graph
from planarvibe.layouts import random_layout, tutte, fpp, schnyder, p3t, reweight, ceg, forcedir, air, areagrad, impred, facebalancer, edgebalancer, anglebalancer, fabalancer, gpt, claude


def _hash_string_to_seed(text: str) -> int:
    h = 2166136261
    for ch in str(text or ""):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _seeded_rng(seed: int):
    state = (int(seed) & 0xFFFFFFFF) or 1

    def next_value() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 4294967296.0

    return next_value


def _is_finite_pair(value) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return False
    return math.isfinite(float(value[0])) and math.isfinite(float(value[1]))


def _initialize_mock_positions(node_ids: list[str], seed_key: str, explicit_positions: dict | None) -> dict:
    """Mirror report-shared.mjs initializeMockCyPositions for JS parity."""
    rng = _seeded_rng(_hash_string_to_seed(seed_key))
    span = max(400.0, 30.0 * math.sqrt(max(1, len(node_ids))) * 10.0)
    raw_positions: dict[str, tuple[float, float]] = {}
    for i, nid0 in enumerate(node_ids):
        nid = str(nid0)
        jitter = i * 1e-4
        raw_positions[nid] = (span * rng() + jitter, span * rng() + jitter)

    has_explicit_input = False
    for nid0 in node_ids:
        nid = str(nid0)
        p = explicit_positions.get(nid) if explicit_positions else None
        if not _is_finite_pair(p):
            continue
        raw_positions[nid] = (float(p[0]), float(p[1]))
        has_explicit_input = True

    if has_explicit_input:
        return geometry.normalize_position_map_to_viewport(raw_positions)
    return raw_positions

def _input_layout(graph, initial_positions: dict, options: dict | None = None) -> dict:
    """Pseudo-algorithm that just returns the caller-provided positions,
    viewport-normalized. Matches the 'input' branch in js_driver.mjs."""
    from planarvibe.geometry import normalize_position_map_to_viewport
    from planarvibe.graph import build_layout_result

    # Verify all node ids have finite positions (match JS hasAllPositions check).
    for nid in graph.node_ids:
        p = initial_positions.get(nid) if initial_positions else None
        if (p is None
                or not isinstance(p, (list, tuple))
                or len(p) < 2
                or not (isinstance(p[0], (int, float)) and isinstance(p[1], (int, float)))):
            return build_layout_result({
                "ok": False,
                "message": "Input coordinates are missing or invalid for one or more vertices",
            })
    pos = {nid: tuple(initial_positions[nid]) for nid in graph.node_ids}
    pos = normalize_position_map_to_viewport(pos)
    return build_layout_result({
        "ok": True,
        "message": "Used input coordinates",
        "positions": pos,
    })


LAYOUT_REGISTRY = {
    "random": lambda graph, initial_positions=None, options=None: random_layout.apply_layout(graph, options),
    "input": _input_layout,
    "tutte": tutte.apply_layout,
    "fpp": fpp.apply_layout,
    "schnyder": schnyder.apply_layout,
    "p3t": p3t.apply_layout,
    "reweight": reweight.apply_layout,
    "ceg_bfs": ceg.apply_bfs,
    "ceg_xy": ceg.apply_xy,
    "forcedir": forcedir.apply_layout,
    "air": air.apply_layout,
    "areagrad": areagrad.apply_layout,
    "impred": impred.apply_layout,
    "facebalancer": facebalancer.apply_layout,
    "edgebalancer": edgebalancer.apply_layout,
    "anglebalancer": anglebalancer.apply_layout,
    "fabalancer": fabalancer.apply_layout,
    "gpt": gpt.apply_layout,
    "claude": claude.apply_layout,
}


def compute_all_metrics(graph, edge_pairs, pos_by_id) -> dict:
    """Compute the 10 drawing metrics + plane flag, mirroring run-dataset-algorithm-batch-worker.mjs."""
    is_plane = not geometry.has_position_crossings(pos_by_id, edge_pairs)

    aspect = metrics.compute_aspect_ratio_score(graph.node_ids, pos_by_id)
    node_u = metrics.compute_node_uniformity_score(graph.node_ids, pos_by_id)
    edge_dev = metrics.compute_edge_length_deviation_score(edge_pairs, pos_by_id)
    edge_ratio = metrics.compute_edge_length_ratio(edge_pairs, pos_by_id)
    spacing = metrics.compute_spacing_uniformity_score(graph.node_ids, pos_by_id)
    edge_orth = metrics.compute_edge_orthogonality_score(edge_pairs, pos_by_id)
    alignment = metrics.compute_axis_alignment_score(graph.node_ids, pos_by_id)
    ang_res = metrics.compute_angular_resolution_score(graph, pos_by_id)

    face = None
    convex = None
    if is_plane:
        try:
            from planarvibe import planar_graph as pg
            embedding = pg.extract_embedding_from_positions(graph.node_ids, edge_pairs, pos_by_id)
            face = metrics.compute_uniform_face_area_score(graph.node_ids, edge_pairs, pos_by_id, embedding)
            convex = metrics.compute_convexity_score(graph.node_ids, edge_pairs, pos_by_id, embedding)
        except (ImportError, AttributeError):
            # planar_graph not ported yet — face/convexity stay None.
            pass

    def pick(res, key):
        if not res or not res.get("ok"):
            return None
        val = res.get(key)
        return val if isinstance(val, (int, float)) else None

    return {
        "isPlane": is_plane,
        "angularResolution": pick(ang_res, "score"),
        "aspectRatio": pick(aspect, "score"),
        "convexity": pick(convex, "score"),
        "edgeLengthDeviation": pick(edge_dev, "score"),
        "edgeRatio": pick(edge_ratio, "ratio"),
        "edgeOrthogonality": pick(edge_orth, "score"),
        "face": pick(face, "quality"),
        "nodeUniformity": pick(node_u, "score"),
        "alignment": pick(alignment, "score"),
        "spacing": pick(spacing, "score"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("benchmark")
    ap.add_argument("graph_name")
    ap.add_argument("algorithm")
    ap.add_argument("--out", help="Write JSON result to PATH instead of stdout.")
    args = ap.parse_args()

    bench = benchmarks.load_benchmark(args.benchmark)
    graph_entry = next((g for g in bench.graphs if g.graph_name == args.graph_name), None)
    if graph_entry is None:
        print(f"No graph named {args.graph_name} in {args.benchmark}", file=sys.stderr)
        return 2

    parsed = graph_entry.parsed
    graph = create_graph(parsed.node_ids, parsed.edge_pairs)

    if args.algorithm not in LAYOUT_REGISTRY:
        print(f"Layout not yet ported: {args.algorithm}", file=sys.stderr)
        return 2

    explicit_positions = dict(parsed.positions_by_id) if parsed.positions_by_id else None
    initial_positions = (explicit_positions if args.algorithm == "input"
                         else _initialize_mock_positions(
                             parsed.node_ids,
                             f"{bench.dataset}:{args.graph_name}",
                             explicit_positions,
                         ))
    t0 = time.perf_counter()
    result = LAYOUT_REGISTRY[args.algorithm](graph, initial_positions=initial_positions)
    runtime_ms = (time.perf_counter() - t0) * 1000.0

    record: dict = {
        "dataset": bench.dataset,
        "graph": args.graph_name,
        "algorithm": args.algorithm,
        "n": len(parsed.node_ids),
        "m": len(parsed.edge_pairs),
        "runtime_ms": runtime_ms,
        "ok": bool(result.get("ok")),
        "message": result.get("message", ""),
        "positions": None,
        "metrics": None,
    }
    if record["ok"] and result.get("positions"):
        pos_by_id = result["positions"]
        record["positions"] = {nid: [p[0], p[1]] for nid, p in pos_by_id.items()}
        record["metrics"] = compute_all_metrics(graph, parsed.edge_pairs, pos_by_id)

    out_json = json.dumps(record, indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(out_json + "\n", encoding="utf-8")
    else:
        print(out_json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
