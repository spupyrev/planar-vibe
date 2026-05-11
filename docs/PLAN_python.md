# Python port — project plan

Port the geometric / layout algorithms from `static/js/` to Python. No UI, no
Cytoscape, no async. Input: benchmark graphs (from `benchmark/*.dot`). Output:
node coordinates + 10 drawing metrics + runtime.

## ⚠️ HARD RULE: DO NOT MODIFY JS

The JS side (`static/js/`, `scripts/`, `tests/`, `index.html`, everything
outside `src-python/`) is **read-only** for the entire port. We read JS to
understand behaviour, we run the JS tools (`scripts/apply-layout-js.mjs` etc.) to
capture reference output, but we never edit a JS file. If a JS bug makes the
Python port awkward, we replicate the bug in Python — we do not patch JS.

Any edits should be inside `src-python/` only.

---

## Scope

### In
- 17 planar layouts: `tutte`, `reweight`, `ceg-bfs`, `ceg-xy`, `air`,
  `areagrad`, `facebalancer`, `edgebalancer`, `anglebalancer`, `fabalancer`,
  `impred`, `forcedir`, `fpp`, `schnyder`, `p3t`, plus ensembles `gpt` and `claude`.
- 1 generic layout: `random`.
- All shared utilities needed by the above: `geometry-utils`, `graph-utils`,
  `planar-graph-utils`, `planarity-test` (Boyer-Myrvold literal port),
  `linear-algebra`, `metrics`, `alignment`, `rotation`, `layout-preprocessing`.
- 10 drawing metrics identical to JS: angular resolution, aspect ratio,
  axis alignment, convexity, edge-length deviation, edge-length ratio,
  edge orthogonality, face-area uniformity, node uniformity, spacing
  uniformity. Plus overall mean score.
- Per-layout runtime measurement (`time.perf_counter`).

### Out
- `circle`, `grid`, `cose` (pure Cytoscape wrappers).
- UI controller, Cytoscape runtime, debug overlay, augmentation debug state.
- Async / `onIteration` progress callbacks.
- Interactive mode toggles, SVG export, preferences, status bar.
- Rotation / axis-alignment buttons' UI wiring (but the underlying
  `rotation.py` / `alignment.py` modules are ported, since `layout-claude.js`
  calls `alignToAxisGreedy`).

---

## Style

- High-level file/module structure mirrors the JS side; Python naming
  conventions (`snake_case` functions, `PascalCase` classes) within.
- Where the JS exports a namespaced bag of functions (`global.GeometryUtils`),
  Python equivalent is a module; callers import functions, not a bag.
- Bug-for-bug parity. If JS has a stale branch, Python has it too.
- Dependencies: stdlib + `numpy` (used sparingly, only where JS uses dense
  float arrays). No scipy, no networkx, no DOT-library.
- Python 3.10+.

---

## Repository layout

```
src-python/
  pyproject.toml
  PLAN.md
  planarvibe/
    __init__.py
    geometry.py              # from geometry-utils.js
    graph.py                 # from graph-utils.js (Graph class + helpers)
    planar_graph.py          # from planar-graph-utils.js
    planarity.py             # from planarity-test.js  (Boyer-Myrvold)
    linear_algebra.py        # from linear-algebra.js
    metrics.py               # from metrics.js
    alignment.py             # from alignment.js
    rotation.py              # from rotation.js
    preprocessing.py         # from layout-preprocessing.js
    layouts/
      __init__.py
      random_layout.py       # from layout-random.js
      tutte.py
      reweight.py
      ceg.py                 # both ceg-bfs and ceg-xy (matches JS file)
      air.py
      areagrad.py
      facebalancer.py
      edgebalancer.py
      anglebalancer.py
      fabalancer.py
      impred.py
      forcedir.py
      fpp.py
      schnyder.py
      p3t.py
      gpt.py                 # from layout-gpt.js
      claude.py              # from layout-claude.js
  scripts/
    apply_layout.py          # mirrors scripts/apply-layout-js.mjs
    layout_table_renderer.py # mirrors scripts/layout-html-renderer.mjs
    freeze_js_reference.py   # runs the JS side and captures golden data
    parity_check.py          # compares Python output vs JS golden
  tests/
    test_geometry.py
    test_graph.py
    test_planarity.py        # more thorough here — downstream depends on it
    test_metrics.py
    test_parity.py           # corpus-wide parity assertion
    golden/                  # frozen JS output — gitignored, regenerate via freeze_js_reference.py
      <layout>/<graph>.json
  benchmarks_work/           # Python-side outputs (not committed; see §below)
```

---

## Common API

Every layout exposes one function:

```python
def apply_layout(graph: Graph, *,
                 initial_positions: dict[str, tuple[float, float]] | None = None,
                 options: dict | None = None) -> LayoutResult: ...
```

`Graph` wraps `(node_ids, edge_pairs)` plus adjacency (same as
`GraphUtils.createGraph` in JS).

`LayoutResult` is a dataclass with fields matching JS `buildLayoutResult`:
`ok`, `positions`, `iters`, `outer_face`, `graph`, `augmented`, `status`,
`stop_reason`, `message`, and per-layout extras.

No Cytoscape instance; no `cy` argument. No callbacks. No debug state.

---

## Output formats

### `apply_layout.py` output
One JSON per (graph, layout):
```json
{
  "graph": "<graph-id>",
  "layout": "tutte",
  "ok": true,
  "iters": 1,
  "stop_reason": null,
  "runtime_ms": 12.3,
  "positions": { "1": [x, y], ... },
  "metrics": {
    "angular_resolution": 0.xxx,
    "aspect_ratio": 0.xxx,
    "axis_alignment": 0.xxx,
    "convexity": 0.xxx,
    "edge_length_deviation": 0.xxx,
    "edge_length_ratio": 0.xxx,
    "edge_orthogonality": 0.xxx,
    "face_area_uniformity": 0.xxx,
    "node_uniformity": 0.xxx,
    "spacing_uniformity": 0.xxx,
    "mean_score": 0.xxx
  }
}
```
Writes under `benchmarks_work/python/<layout>/<graph>.json` by default. Never
touches existing repo data.

### Golden data (frozen JS)
Same JSON schema, written by `freeze_js_reference.py` into
`src-python/tests/golden/`. This directory is gitignored — goldens are
regeneratable from JS on demand (compare_metrics.py auto-freezes any missing
entries). Re-freeze if JS changes.

---

## Benchmarks

- Iteration corpus: `benchmark/sample_graphs_coords.dot` (small, has embedded
  coords → outer face is fixed → parity is crisp).
- Checkpoint corpus: `benchmark/planar_train.dot` (mid-size, fast).
- Full parity run: all `benchmark/*.dot` corpora — at the end.

Benchmark loader: a minimal DOT reader in `scripts/apply_layout.py` that
understands `u -- v;`, `u [pos="x,y"];`-style coord attributes, and comments.
No external DOT parser.

---

## Parity target

Quantitative (per (graph, layout)):
- All 10 metrics within **0.1%** of JS for deterministic layouts (all non-ensemble).
- Ensembles (`gpt`, `claude`): all 10 metrics within **5%** of JS, and the chosen
  sub-layout matches on ≥80% of graphs.
- `ok` flag and `stop_reason` match exactly where deterministic.
- `iters` not strictly checked (can drift by ±1 due to numeric tie-breaking).

Failures are logged in the parity-check report, not silently tolerated.

---

## Checkpoints

Bottom-up. Pause at each, report parity, discuss before next.

**C0 — scaffolding**
- `src-python/` package skeleton, `pyproject.toml`, `pytest` configured.
- Benchmark loader working on `sample_graphs_coords.dot`.
- `freeze_js_reference.py` runs JS via `scripts/apply-layout-js.mjs` and saves
  golden JSON per (graph, layout). (No Python layouts ported yet — just proves
  we can capture reference data.)

**C1 — utilities + trivial layout**
- Ported: `geometry`, `graph`, `planar_graph`, `planarity` (Boyer-Myrvold),
  `linear_algebra`, `metrics`, `preprocessing`, `alignment`, `rotation`,
  `random_layout`.
- Parity check: `random` on the iteration corpus.
- Success criterion: all 10 metrics within 0.1% on all graphs.

**C2 — Tutte (exercises the full utility stack)**
- Port `tutte`. Uses preprocessing, planarity, triangulation, LU solve.
- Parity check on iteration + checkpoint corpora.

**C3 — simple planar**
- `fpp`, `schnyder`, `p3t`, `reweight`, `ceg`.
- Parity on both corpora.

**C4 — iterative layouts**
- `air`, `areagrad`, `forcedir`, `impred`.
- Expect runtime to become a problem here; we'll triage per layout.

**C5 — balancers**
- `facebalancer`, `edgebalancer`, `anglebalancer`, `fabalancer`.

**C6 — ensembles**
- `gpt`, `claude`.
- Relaxed parity (5% and winner-match).

**C7 — full corpus run + report**
- All layouts × all corpora.
- Per-layout parity summary + runtime table (Python vs JS).

---

## Risks & open items

1. **Runtime.** Pure-Python iterative layouts may be 10–50× slower. Plan: port
   correctness-first, profile, vectorize the hot loop with numpy if a layout
   exceeds ~30× slowdown. Discuss when we hit it.
2. **Boyer-Myrvold planarity port.** ~900 LOC of fiddly pointer-chasing. Single
   biggest risk. I'll write unit tests here (the only module where I'm
   unilaterally adding tests) since everything downstream assumes correct
   combinatorial embeddings.
3. **RNG.** JS uses `Math.random()` in a few spots (TBD which — audit during
   port). Python can't match V8's PRNG; parity for those layouts is within
   tolerance only, not bit-matched. If a layout is genuinely nondeterministic
   and differs significantly between runs, flag it.
4. **Ensemble parity.** Small numeric drift can change which sub-layout
   `gpt`/`claude` picks. Hence the relaxed 5% target.
5. **Freeze reproducibility.** Need to capture JS runtime from the same machine
   we compare on. Runtime numbers will be reported but not asserted; see §13
   when we get there.

---

## Out of scope (explicit)

- Any JS code changes this session.
- SVG / graphical output from Python.
- Match V8 floating-point bit-for-bit.
- Performance optimization beyond numpy vectorization.
- Integrating the Python port back into the browser or any report.
