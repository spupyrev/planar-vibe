"""Random layout. Literal port of static/js/layout-random.js.

Position of a node id `v` is deterministic given the (hashed) id; the JS
"cy.width()/cy.height()" defaults come from the mock-cy fixture
(900 / 620 in scripts/report-shared.mjs). We inline those defaults.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..graph import Graph, build_layout_result, normalized_hash

DEFAULT_WIDTH = 900
DEFAULT_HEIGHT = 620


def compute_random_positions(
    graph: Graph,
    width: float | None = None,
    height: float | None = None,
) -> dict:
    ids = [str(nid) for nid in (graph.node_ids or [])]
    safe_width = float(width) if (width is not None and _finite(width)) else 320.0
    safe_height = float(height) if (height is not None and _finite(height)) else 260.0
    width_px = max(safe_width, 320.0)
    height_px = max(safe_height, 260.0)
    margin = 26.0
    x_span = max(width_px - margin * 2, 1.0)
    y_span = max(height_px - margin * 2, 1.0)
    pos_by_id: dict[str, tuple[float, float]] = {}
    for nid in ids:
        x = margin + normalized_hash(nid + ":x", 2166136261) * x_span
        y = margin + normalized_hash(nid + ":y", 33554467) * y_span
        pos_by_id[nid] = (x, y)
    return build_layout_result({"ok": True, "nodeIds": ids, "positions": pos_by_id})


def apply_layout(graph: Graph, options: dict | None = None) -> dict:
    opts = options or {}
    width = opts.get("width", DEFAULT_WIDTH)
    height = opts.get("height", DEFAULT_HEIGHT)
    result = compute_random_positions(graph, width, height)
    result["message"] = "Applied random coordinates"
    return result


def _finite(x) -> bool:
    import math
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False
