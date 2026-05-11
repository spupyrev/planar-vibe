# C++ port — project plan

Port the geometric / layout algorithms from `static/js/` to C++. No UI, no
Cytoscape, no async. Input: benchmark graphs (from `benchmark/*.dot`). Output:
node coordinates + 10 drawing metrics + runtime. Written for speed — target
5–20× over JS, same metric quality.

## ⚠️ Completeness requirement

**ALL 18 layouts must be ported.** The port is not complete until every
algorithm listed in the "In" scope below — including the balancers and
ensembles — is ported and parity-checked. Nothing should be left as
"TODO in a follow-up".

**The balancers (`facebalancer`, `edgebalancer`, `anglebalancer`,
`fabalancer`) and ensembles (`gpt`, `claude`) are the most important
layouts.** They are what PlanarVibe uses to produce the highest-quality
drawings; metrics improvements on those layouts are the project's reason for
existing. They are also the most complex (L-BFGS, 3300+ LOC combined; the
ensembles wrap all other layouts). Do not defer them. Any "partial port"
that omits these is not a port.

Current status: **port complete (18/18)**. All layouts ported and
parity-checked on `benchmark/planar_train.dot` (499 graphs): aggregate Δscore
within ±0.0006 of JS on every layout, 5–23× speedup.

## ⚠️ HARD RULE: DO NOT MODIFY JS

JS (`static/js/`, `scripts/`, `tests/`, `index.html`, everything outside
`src-cpp/`) is **read-only** for the entire port. JS is ground truth — we read
it to understand behaviour, run the JS tools to capture reference output, but
never edit a JS file. If a JS bug makes the C++ port awkward, we replicate the
bug. The Python port (`src-python/`) is a validated secondary reference when
JS semantics are ambiguous; JS still wins ties.

Any edits happen inside `src-cpp/` only.

---

## Scope

### In — all of these must be ported before calling the port "done"
- 15 planar layouts: `tutte`, `reweight`, `ceg-bfs`, `ceg-xy`, `air`,
  `areagrad`, `impred`, `forcedir`, `fpp`, `schnyder`, `p3t`.
- **4 L-BFGS balancers (highest priority)**: `facebalancer`, `edgebalancer`,
  `anglebalancer`, `fabalancer`. These are the most complex layouts (~3300
  LOC Python combined) and also the most important — they produce the
  highest-quality drawings.
- **2 ensembles (highest priority)**: `gpt`, `claude`. These wrap the other
  layouts and pick the best by scoring, so they require everything else to
  be done first.
- 1 generic layout: `random`.
- All shared utilities: geometry, graph, planar-graph, planarity (Boyer-Myrvold
  literal port), linear-algebra, metrics, alignment, rotation, preprocessing.
- 10 drawing metrics identical to JS.
- Per-layout runtime measurement (`std::chrono::steady_clock`).

### Out
- `circle`, `grid`, `cose` (pure Cytoscape wrappers).
- UI, Cytoscape runtime, debug overlay.
- Async / progress callbacks.
- SVG export.

---

## Style

- **Keep it small.** Flat layout, single binary. No CMake, no header/source
  split unless a file gets big.
- **stdlib only.** No Boost, no Eigen, no JSON lib. Hand-written LU, tiny JSON
  writer + reader, simple DOT parser. Port `linear-algebra.js` as-is.
- **C++17.** `std::optional`, structured bindings, `std::variant` if useful.
  Nothing later (no `std::expected`, no `<ranges>` fanciness).
- **Node IDs are `int`.** JS/Python use strings (`"1"`, `"dummy_3"`). C++
  converts to a contiguous `int` index at graph construction; a
  `std::vector<std::string>` on the side holds display names for JSON
  round-tripping. Every hot path uses `int` only — no `std::unordered_map` in
  inner loops.
- **Tagged result struct**, not exceptions, in the hot path. Mirrors JS
  `buildLayoutResult`. Exceptions reserved for `main`-level fatals (bad CLI
  args, malformed DOT, I/O).
- Functions, not god-classes. One `apply_layout(...)` per layout. The `Graph`
  struct holds adjacency + the int↔string mapping; it's a plain aggregate.
- Bug-for-bug parity. If JS has a stale branch, C++ has it too.

---

## Repository layout

```
src-cpp/
  Makefile
  PLAN.md
  include/
    planarvibe.hpp            # single umbrella header (convenience)
    geometry.hpp
    graph.hpp                 # Graph struct, int<->string mapping
    planar_graph.hpp
    planarity.hpp             # Boyer-Myrvold
    linear_algebra.hpp        # LU with partial pivot; solve / solveT
    metrics.hpp
    alignment.hpp
    rotation.hpp
    preprocessing.hpp
    dot.hpp                   # minimal DOT reader
    json.hpp                  # minimal JSON reader/writer
    layout_result.hpp         # LayoutResult struct
    layouts/
      random_layout.hpp
      tutte.hpp
      reweight.hpp
      ceg.hpp                 # both ceg-bfs and ceg-xy
      air.hpp
      areagrad.hpp
      facebalancer.hpp
      edgebalancer.hpp
      anglebalancer.hpp
      fabalancer.hpp
      impred.hpp
      forcedir.hpp
      fpp.hpp
      schnyder.hpp
      p3t.hpp
      gpt.hpp
      claude.hpp
  src/
    *.cpp                     # one .cpp per header above; split only if big
  apps/
    apply_layout.cpp          # CLI binary (mirrors scripts/apply-layout-js.mjs)
  tests/
    test_main.cpp             # single binary, plain asserts
  build/                      # gitignored
```

Build:
```
make           # builds build/apply_layout and build/test_main
make test      # runs test_main
make clean
```
`CXX`, `CXXFLAGS` overridable. Default `-std=c++17 -O2 -Wall -Wextra`. Debug
profile via `make DEBUG=1`.

---

## Common API

Every layout exposes one function:

```cpp
LayoutResult apply_layout(const Graph& g,
                          const PositionMap* initial_positions = nullptr,
                          const Options* options = nullptr);
```

`Graph` holds `(n, edges, adjacency)` as `int`s, plus `node_names[i]` for
JSON round-trip. `PositionMap` is `std::vector<std::array<double,2>>` indexed
by node id, with a "set" mask (or `std::optional` if small).

`LayoutResult`: `{ok, positions, iters, stop_reason, message, E, ...}` —
aggregate struct with the union of fields any layout emits. Per-layout extras
that aren't generic live in a small `extras` map keyed by string and holding
`double`/`string`. Matches JS `buildLayoutResult` by field name (camelCase in
JSON).

No Cytoscape instance, no callbacks, no debug state.

---

## Output formats

### `apply_layout` binary output
```
apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]
```
One JSON per run, **exact same schema as src-python/scripts/apply_layout.py**:
```json
{
  "dataset": "...",
  "graph": "<graph-id>",
  "algorithm": "tutte",
  "n": 12, "m": 22,
  "runtime_ms": 2.3,
  "ok": true,
  "message": "...",
  "positions": { "1": [x, y], ... },
  "metrics": {
    "isPlane": true,
    "angularResolution": 0.xxx,
    "aspectRatio": 0.xxx,
    "convexity": 0.xxx,
    "edgeLengthDeviation": 0.xxx,
    "edgeRatio": 0.xxx,
    "edgeOrthogonality": 0.xxx,
    "face": 0.xxx,
    "nodeUniformity": 0.xxx,
    "alignment": 0.xxx,
    "spacing": 0.xxx
  }
}
```
Same keys the Python `apply_layout.py` emits — so `compare_metrics.py` reads
both with zero changes beyond path resolution.

### Parity harness integration
Extend `src-python/scripts/compare_metrics.py` with `--impl cpp` (default
`python`). When `cpp`, `_run_python(...)` is replaced by a shell-out to
`src-cpp/build/apply_layout`. The JS reference path is unchanged.

---

## Parity target

Per (graph, layout):
- All layouts (including ensembles): all 10 metrics within **0.5%** of JS.
- Corpus-mean Δscore < 0.1% per layout.
- `ok` flag and `stop_reason` match where deterministic.
- Positions: not asserted bit-exact.

RNG differences and FP drift shouldn't move metrics by more than ~0.01% on
their own; larger deviations almost certainly indicate bugs. Flag per-graph
outliers for investigation rather than widening the tolerance.

---

## Checkpoints

Bottom-up. Pause at each, report parity.

**C0 — scaffolding**
- Makefile, `apply_layout.cpp` stub.
- `dot.hpp` reads `benchmark/sample_graphs_coords.dot`.
- `json.hpp` writes the output schema above.
- `graph.hpp` + int↔name mapping.
- `apply_layout <dot> <graph-id> random` works end-to-end (random positions +
  metrics stub of zeros). Proves the JSON round-trip and the harness
  integration before any real algorithm.

**C1 — utilities + random**
- Port: geometry, graph, planar_graph, planarity (Boyer-Myrvold — biggest
  risk; write unit tests in `test_main.cpp`), linear_algebra, metrics,
  preprocessing, alignment, rotation, random_layout.
- Parity on iteration corpus.
- Success: `random`'s 10 metrics within 0.1% of JS across sample corpus.

**C2 — Tutte**
- Port tutte (exercises: preprocessing → planarity → triangulation → LU solve).
- Parity on sample + planar_train.

**C3 — simple planar**
- `fpp`, `schnyder`, `p3t`, `reweight`, `ceg`.
- Parity on both corpora.

**C4 — iterative layouts**
- `air`, `areagrad`, `forcedir`, `impred`.
- Expect big runtime wins here vs JS.

**C5 — balancers**
- `facebalancer`, `edgebalancer`, `anglebalancer`, `fabalancer`.
- L-BFGS + LU. Use the same flat-index design the Python numpy balancers use
  (pre-built flat arrays of row_i / neighbor / interior_n instead of ragged
  loops). Skip the scalar-intermediate we did in Python.

**C6 — ensembles**
- `gpt`, `claude`.
- Same 0.5% target as every other layout. Per-graph outliers get investigated,
  not excused. Sub-layout selection must be stable — if an ensemble picks a
  different winner than JS, that's a bug (probably in scoring tie-break or
  candidate-ordering).

**C7 — full corpus run + report**
- All layouts × `sample_graphs_coords.dot` + `planar_train.dot`.
- Use parallel `compare_metrics.py --impl cpp --workers 16`.
- Per-layout parity summary + runtime table (JS vs Python vs C++).

---

## Risks & open items

1. **Boyer-Myrvold planarity port.** ~900 LOC of pointer-chasing. Biggest
   correctness risk. Unit-test heavily in C1 — downstream everything assumes
   correct combinatorial embeddings.
2. **RNG.** JS uses `Math.random()` (V8 xorshift). C++ will use a deterministic
   PRNG (e.g. `std::mt19937` seeded from graph structure) — not bit-matched,
   same tolerance treatment as Python port.
3. **Ensemble parity.** In principle small numeric drift can change which
   sub-layout `gpt`/`claude` picks. In practice we don't expect FP/RNG to move
   metrics by more than ~0.01%; if we see bigger per-graph drift, treat it as
   a bug to investigate, not a tolerance to accept.
4. **JSON / DOT hand-written.** They'll be incomplete (only what the corpus
   uses). If we hit a file with an unsupported feature, extend the parser.
5. **No external deps means no vectorization magic.** Speed comes from native
   code + `int` IDs, not SIMD. Balancers should still beat numpy on small
   graphs (less overhead); numpy may win on large n×n solves. That's fine.

---

## Out of scope (explicit)

- Any JS code changes.
- SVG / graphical output.
- Match V8 floating-point bit-for-bit.
- SIMD / OpenMP / threading inside a single layout. Parallelism at the
  graph-level via `compare_metrics.py` is plenty.
- Integrating the C++ port back into the browser.
