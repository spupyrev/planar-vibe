"""Parity check: compare Python output JSON vs a frozen JS golden JSON.

Usage:
  python src-python/scripts/parity_check.py <py.json> <golden.json> [--tol 0.001]

Exits 0 on parity success, 1 on any failure. Prints a short diff summary.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


METRIC_KEYS = [
    "angularResolution", "aspectRatio", "convexity",
    "edgeLengthDeviation", "edgeRatio", "edgeOrthogonality",
    "face", "nodeUniformity", "alignment", "spacing",
]


def _num(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def compare(py: dict, js: dict, rel_tol: float, pos_tol: float = 1e-6, skip_positions: bool = False) -> tuple[int, list[str]]:
    errs: list[str] = []

    if bool(py.get("ok")) != bool(js.get("ok")):
        errs.append(f"ok mismatch: py={py.get('ok')} js={js.get('ok')}")

    # Position parity (absolute tolerance tied to drawing diameter ~ 900).
    py_pos = py.get("positions") or {}
    js_pos = js.get("positions") or {}
    if not skip_positions:
        if set(py_pos.keys()) != set(js_pos.keys()):
            only_py = set(py_pos) - set(js_pos)
            only_js = set(js_pos) - set(py_pos)
            errs.append(f"position node-id set differs: py-only={sorted(only_py)[:5]} js-only={sorted(only_js)[:5]}")
        else:
            max_abs = 0.0
            for nid in py_pos:
                px, py_ = py_pos[nid]
                jx, jy = js_pos[nid]
                dx = abs(px - jx)
                dy = abs(py_ - jy)
                if dx > max_abs:
                    max_abs = dx
                if dy > max_abs:
                    max_abs = dy
            if max_abs > pos_tol:
                errs.append(f"positions differ: max abs = {max_abs:.6e} (tol {pos_tol:.1e})")

    # Metric parity at given rel_tol.
    py_m = py.get("metrics") or {}
    js_m = {
        "angularResolution": js.get("angularResolution"),
        "aspectRatio": js.get("aspectRatio"),
        "convexity": js.get("convexity"),
        "edgeLengthDeviation": js.get("edgeLengthDeviation"),
        "edgeRatio": js.get("edgeRatio"),
        "edgeOrthogonality": js.get("edgeOrthogonality"),
        "face": js.get("face"),
        "nodeUniformity": js.get("nodeUniformity"),
        "alignment": js.get("alignment"),
        "spacing": js.get("spacing"),
    } if js.get("metrics") is None else js.get("metrics")

    for key in METRIC_KEYS:
        py_v = _num(py_m.get(key))
        js_v = _num(js_m.get(key))
        if py_v is None and js_v is None:
            continue
        if py_v is None or js_v is None:
            errs.append(f"metric {key}: py={py_v} js={js_v}")
            continue
        denom = max(abs(js_v), 1e-12)
        rel = abs(py_v - js_v) / denom
        if rel > rel_tol:
            errs.append(f"metric {key}: py={py_v:.6f} js={js_v:.6f}  rel_diff={rel:.4%}")

    return (0 if not errs else 1), errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("py_json")
    ap.add_argument("js_json")
    ap.add_argument("--tol", type=float, default=0.001, help="Relative tolerance for metrics.")
    ap.add_argument("--pos-tol", type=float, default=1e-6, help="Absolute tolerance for position parity. Iterative layouts drift to ~1e-4 due to FP accumulation; use --pos-tol 1e-3 or set --skip-positions.")
    ap.add_argument("--skip-positions", action="store_true", help="Only check metrics, not raw positions.")
    args = ap.parse_args()

    py = json.loads(Path(args.py_json).read_text())
    js = json.loads(Path(args.js_json).read_text())
    code, errs = compare(py, js, args.tol, args.pos_tol, args.skip_positions)
    if code == 0:
        print("PARITY OK")
        return 0
    print("PARITY FAIL:")
    for e in errs:
        print("  " + e)
    return 1


if __name__ == "__main__":
    sys.exit(main())
