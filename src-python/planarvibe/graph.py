"""Graph container + light graph helpers.

Literal port of static/js/graph-utils.js. Exposes:
  - Graph dataclass-like with `node_ids`, `edge_pairs`, `adjacency`,
    `adjacency_sets`.
  - `edge_key`, `face_key`, hashing helpers.
  - `build_layout_result`/`build_layout_error`: a uniform dict-like result
    object returned from every layout (matches JS shape; positions keyed by
    node id → (x, y) tuple).
  - `create_movement_convergence_tracker`, `compute_position_move_stats`:
    shared iteration-control helpers.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence


def edge_key(u: str, v: str) -> str:
    return f"{u}::{v}" if u < v else f"{v}::{u}"


def clone_edge_pairs(edge_pairs: Sequence[tuple[str, str]] | None) -> list[tuple[str, str]]:
    if not edge_pairs:
        return []
    return [(a, b) for (a, b) in edge_pairs]


def normalize_outer_face(outer_face: Sequence | None) -> list:
    if outer_face is None:
        return []
    return list(outer_face)


def hash_string(value, seed: int) -> int:
    """FNV-1a-like hash matching JS `hashString` (Math.imul semantics)."""
    h = seed & 0xFFFFFFFF
    text = str(value)
    for ch in text:
        h ^= ord(ch) & 0xFFFFFFFF
        # Math.imul(h, 16777619): 32-bit multiply, keep low 32 bits as signed-ish.
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def normalized_hash(value, seed: int) -> float:
    return hash_string(value, seed) / 4294967295.0


def resolve_int_option(value, fallback: int, min_val=None, max_val=None) -> int:
    if value is None or not _finite(value):
        return fallback
    out = math.floor(float(value))
    if min_val is not None and _finite(min_val):
        out = max(int(min_val), out)
    if max_val is not None and _finite(max_val):
        out = min(int(max_val), out)
    return out


def resolve_non_negative_option(value, fallback: float) -> float:
    return float(value) if (value is not None and _finite(value) and value >= 0) else float(fallback)


def resolve_function_option(value, fallback):
    return value if callable(value) else fallback


def face_key(face: Sequence) -> str:
    if not face:
        return ""
    arr = [str(x) for x in face]
    n = len(arr)
    best: str | None = None
    for i in range(n):
        rot = "|".join(arr[i:] + arr[:i])
        if best is None or rot < best:
            best = rot
    rev = list(reversed(arr))
    for i in range(n):
        rrot = "|".join(rev[i:] + rev[:i])
        if best is None or rrot < best:
            best = rrot
    return best or ""


@dataclass
class Graph:
    node_ids: list[str] = field(default_factory=list)
    edge_pairs: list[tuple[str, str]] = field(default_factory=list)
    adjacency: dict[str, list[str]] = field(default_factory=dict)
    adjacency_sets: dict[str, set[str]] = field(default_factory=dict)


def create_graph(node_ids: Sequence[str], edge_pairs: Sequence[tuple[str, str]]) -> Graph:
    if not isinstance(node_ids, (list, tuple)):
        raise TypeError("Graph requires nodeIds array")
    if not isinstance(edge_pairs, (list, tuple)):
        raise TypeError("Graph requires edgePairs array")

    g = Graph(node_ids=list(node_ids), edge_pairs=[])

    node_id_set: set[str] = set()
    for nid in g.node_ids:
        if not isinstance(nid, str):
            raise TypeError("Graph node ids must be strings")
        if nid in node_id_set:
            raise ValueError("Graph node ids must be unique")
        node_id_set.add(nid)
        g.adjacency[nid] = []
        g.adjacency_sets[nid] = set()

    edge_set: set[str] = set()
    for pair in edge_pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            raise ValueError("Graph edges must be [source, target] pairs")
        u, v = pair[0], pair[1]
        if not isinstance(u, str) or not isinstance(v, str):
            raise TypeError("Graph edge endpoints must be strings")
        if u not in node_id_set or v not in node_id_set:
            raise ValueError("Graph edges must reference known node ids")
        if u == v:
            raise ValueError("Graph edges must be simple and cannot contain self-loops")
        key = edge_key(u, v)
        if key in edge_set:
            raise ValueError("Graph edges must be unique")
        edge_set.add(key)
        g.edge_pairs.append((u, v))

    for (u, v) in g.edge_pairs:
        g.adjacency[u].append(v)
        g.adjacency[v].append(u)
        g.adjacency_sets[u].add(v)
        g.adjacency_sets[v].add(u)

    return g


def collect_movable_vertices(node_ids: Sequence[str], outer_face: Sequence[str] | None) -> list[str]:
    outer_set = set(outer_face or [])
    return [nid for nid in (node_ids or []) if nid not in outer_set]


@dataclass
class MoveStats:
    moved_vertices: int
    total_move: float
    avg_move: float
    max_move: float


def compute_move_stats(
    items: Sequence,
    distance_fn: Callable[[Any, int], float],
    options: dict | None = None,
) -> MoveStats:
    opts = options or {}
    move_tol = resolve_non_negative_option(opts.get("moveTol"), 1e-9)
    moved_vertices = 0
    total_move = 0.0
    max_move = 0.0
    lst = list(items) if items else []
    for i, it in enumerate(lst):
        dist = distance_fn(it, i)
        if not _finite(dist) or dist < 0:
            continue
        total_move += dist
        if dist > max_move:
            max_move = dist
        if dist > move_tol:
            moved_vertices += 1
    return MoveStats(
        moved_vertices=moved_vertices,
        total_move=total_move,
        avg_move=(total_move / len(lst)) if lst else 0.0,
        max_move=max_move,
    )


def compute_position_move_stats(
    node_ids: Sequence[str],
    prev_pos_by_id: dict,
    next_pos_by_id: dict,
    options: dict | None = None,
) -> MoveStats:
    def distance(nid, _idx):
        prev = prev_pos_by_id.get(nid) if prev_pos_by_id else None
        nxt = next_pos_by_id.get(nid) if next_pos_by_id else None
        if (not prev or not nxt
                or not _finite(prev[0]) or not _finite(prev[1])
                or not _finite(nxt[0]) or not _finite(nxt[1])):
            return float("nan")
        return math.hypot(nxt[0] - prev[0], nxt[1] - prev[1])

    return compute_move_stats(node_ids, distance, options)


def build_layout_result(fields: dict | None) -> dict:
    base = dict(fields or {})
    out = dict(base)
    out.pop("pos", None)
    positions = base.get("positions", base.get("posById"))
    pos_by_id = base.get("posById", positions)
    iters = base["iters"] if _finite(base.get("iters")) else None

    out.update({
        "ok": base.get("ok", True) is not False,
        "positions": positions,
        "posById": pos_by_id,
        "iters": iters,
        "outerFace": base.get("outerFace"),
        "graph": base.get("graph"),
        "augmented": base.get("augmented"),
        "status": base.get("status"),
        "stopReason": base.get("stopReason"),
    })
    return out


def build_layout_error(fields: dict | None = None) -> dict:
    defaults = {
        "ok": False,
        "positions": None,
        "posById": None,
        "iters": None,
        "outerFace": None,
        "graph": None,
        "augmented": None,
        "status": None,
        "stopReason": None,
    }
    merged = {**defaults, **(fields or {})}
    return build_layout_result(merged)


def build_layout_status_message(layout_name: str, stats: dict | None) -> str:
    name = str(layout_name or "Layout")
    data = stats or {}
    parts: list[str] = []

    def fmt_finite(key, transform):
        v = data.get(key)
        if _finite(v):
            parts.append(transform(v))

    fmt_finite("outerFaceVertexCount", lambda v: f"{int(v)}-vertex outer face")
    fmt_finite("boundedFaceCount", lambda v: f"{int(v)} bounded faces")
    fmt_finite("vertexCount", lambda v: f"{int(v)} vertices")
    dummy_count = data.get("dummyCount")
    if _finite(dummy_count) and dummy_count > 0:
        parts.append(f"+{int(dummy_count)} dummy vertices")
    fmt_finite("iters", lambda v: f"{int(v)} iters")
    fmt_finite("outerSteps", lambda v: f"{int(v)} steps")
    fmt_finite("accepted", lambda v: f"accepted {int(v)}")
    fmt_finite("rejected", lambda v: f"rejected {int(v)}")

    if data.get("status"):
        parts.append(f"status {data['status']}")
    elif data.get("stopReason"):
        parts.append(str(data["stopReason"]))

    for key in ("maxRelError", "faceAreaScore", "faceAreaMinRatio", "faceAreaMaxRatio"):
        v = data.get(key)
        if _finite(v):
            label = {
                "maxRelError": "max rel err",
                "faceAreaScore": "face score",
                "faceAreaMinRatio": "min ratio",
                "faceAreaMaxRatio": "max ratio",
            }[key]
            parts.append(f"{label} {v:.3f}")

    extras = data.get("extraParts")
    if isinstance(extras, list):
        for e in extras:
            if e:
                parts.append(str(e))

    return f"Applied {name} ({', '.join(parts)})"


@dataclass
class MovementConvergenceUpdate:
    stable: bool
    stable_iterations: int
    stable_iter_limit: int
    converged: bool
    reason: str | None


class MovementConvergenceTracker:
    def __init__(self, options: dict | None = None) -> None:
        opts = options or {}
        self._min_iters_before_stop = resolve_int_option(opts.get("minItersBeforeStop"), 20, 1)
        self._stable_iter_limit = resolve_int_option(opts.get("stableIterLimit"), 5, 1)
        self._max_move_tol = resolve_non_negative_option(opts.get("maxMoveTol"), 1e-3)
        self._avg_move_tol = resolve_non_negative_option(opts.get("avgMoveTol"), self._max_move_tol)
        self._stable_iterations = 0

    def update(self, stats: MoveStats | dict | None, iter_idx: int) -> MovementConvergenceUpdate:
        if stats is None:
            stable = False
        else:
            if isinstance(stats, MoveStats):
                max_move = stats.max_move
                avg_move = stats.avg_move
            else:
                max_move = stats.get("maxMove")
                avg_move = stats.get("avgMove")
            stable = (_finite(max_move) and _finite(avg_move)
                      and max_move <= self._max_move_tol
                      and avg_move <= self._avg_move_tol)
        self._stable_iterations = self._stable_iterations + 1 if stable else 0
        ready = iter_idx >= self._min_iters_before_stop and self._stable_iterations >= self._stable_iter_limit
        return MovementConvergenceUpdate(
            stable=stable,
            stable_iterations=self._stable_iterations,
            stable_iter_limit=self._stable_iter_limit,
            converged=ready,
            reason="movement-converged" if ready else None,
        )


def create_movement_convergence_tracker(options: dict | None = None) -> MovementConvergenceTracker:
    return MovementConvergenceTracker(options)


def _finite(x) -> bool:
    if x is None or isinstance(x, bool):
        return False
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)
