"""Quick end-to-end parity runner for a single benchmark file.

Usage:
  python src-python/scripts/run_parity_suite.py --algorithm tutte [--algorithm fpp ...]
      [--benchmark benchmark/sample_graphs_coords.dot]
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src-python"))

from planarvibe import benchmarks  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", default="benchmark/sample_graphs_coords.dot")
    ap.add_argument("--algorithm", action="append", required=True)
    ap.add_argument("--max-graphs", type=int, default=None)
    ap.add_argument("--freeze-first", action="store_true", help="Run freeze_js_reference.py first.")
    ap.add_argument("--pos-tol", type=float, default=1e-6)
    ap.add_argument("--skip-positions", action="store_true")
    args = ap.parse_args()

    bench = benchmarks.load_benchmark((REPO_ROOT / args.benchmark).resolve())
    graphs = bench.graphs
    if args.max_graphs:
        graphs = graphs[: args.max_graphs]

    total_ok = 0
    total_fail = 0
    for algorithm in args.algorithm:
        print(f"== {algorithm} ==")
        if args.freeze_first:
            subprocess.run([
                sys.executable,
                str(REPO_ROOT / "src-python/scripts/freeze_js_reference.py"),
                "--benchmark", args.benchmark,
                "--algorithm", algorithm,
            ], cwd=str(REPO_ROOT), check=False)
        for entry in graphs:
            gname = entry.graph_name
            py_out = Path(f"/tmp/py_{algorithm}_{gname}.json")
            gold = REPO_ROOT / "src-python/tests/golden" / algorithm / bench.dataset / f"{gname}.json"
            if not gold.exists():
                print(f"  {gname}: NO GOLDEN (run with --freeze-first)")
                continue
            res = subprocess.run([
                sys.executable,
                str(REPO_ROOT / "src-python/scripts/apply_layout.py"),
                args.benchmark, gname, algorithm,
                "--out", str(py_out),
            ], cwd=str(REPO_ROOT), capture_output=True, text=True)
            if res.returncode != 0:
                print(f"  {gname}: PY FAIL: {res.stderr.strip()}")
                total_fail += 1
                continue
            parity_argv = [
                sys.executable,
                str(REPO_ROOT / "src-python/scripts/parity_check.py"),
                str(py_out), str(gold),
                "--pos-tol", str(args.pos_tol),
            ]
            if args.skip_positions:
                parity_argv.append("--skip-positions")
            parity = subprocess.run(parity_argv, cwd=str(REPO_ROOT), capture_output=True, text=True)
            if parity.returncode == 0:
                total_ok += 1
                print(f"  {gname}: OK")
            else:
                total_fail += 1
                print(f"  {gname}: FAIL")
                for line in parity.stdout.splitlines()[1:6]:
                    print(f"    {line}")
    print(f"\nTotal: {total_ok} OK, {total_fail} FAIL")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
