# PlanarVibe C++ port

Self-contained C++17 port of the PlanarVibe planar-graph layout algorithms.
No external runtime dependencies; stdlib only.

## Build

```
make          # builds build/apply_layout + build/test_main
make test     # runs the smoke test binary
make release  # builds build/apply_layout-release (static, -O3 -flto)
make clean
```

`make release` produces a statically-linked binary that depends only on
`libc`/`libm`/`ld` — runnable on any modern Linux without the build-machine's
libstdc++ present.

Requires: a C++17 compiler (tested with gcc 15, should work with gcc ≥ 7 or
clang ≥ 5). No CMake, Eigen, or Boost.

## Usage

```
apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]
```

Emits one JSON record to stdout (or the `--out` path) matching the schema the
Python port uses — compatible with `src-python/scripts/compare_metrics.py`
via `--impl cpp`.

Supported algorithms (all 18): `random`, `tutte`, `fpp`, `schnyder`, `p3t`,
`reweight`, `ceg_bfs`, `ceg_xy`, `forcedir`, `air`, `areagrad`, `impred`,
`facebalancer`, `edgebalancer`, `anglebalancer`, `fabalancer`, `gpt`, `claude`.

## Parity & performance

On the 499-graph `benchmark/planar_train.dot` corpus, every ported layout is
within ±0.06% aggregate Δscore of JS, with 5–23× speedup:

| layout         |   JS ms | C++ ms | speedup | Δscore |
|----------------|--------:|-------:|--------:|-------:|
| tutte          |    15.4 |    1.5 |     10× | +0.0000 |
| fpp            |    17.6 |    3.3 |      5× | +0.0000 |
| schnyder       |    14.2 |    2.0 |      7× | +0.0000 |
| reweight       |    50.4 |    2.5 |     20× | +0.0000 |
| ceg_bfs        |    34.1 |    1.5 |     23× | +0.0000 |
| ceg_xy         |    41.4 |    2.1 |     20× | +0.0000 |
| forcedir       |   331.0 |   26.2 |     13× | +0.0005 |
| air            |   254.0 |   21.9 |     12× | +0.0001 |
| areagrad       |   403.5 |   65.7 |      6× | -0.0000 |
| impred         |  1466.4 |  137.8 |     11× | +0.0000 |
| facebalancer   |   113.5 |    5.1 |     22× | +0.0006 |
| edgebalancer   |   104.4 |    5.1 |     20× | +0.0000 |
| anglebalancer  |   303.8 |   18.4 |     17× | -0.0000 |
| fabalancer     |   365.4 |   20.9 |     17× | -0.0002 |
| gpt            |  2844.0 |  231.4 |     12× | -0.0004 |
| claude         |  3027.2 |  232.3 |     13× | +0.0004 |

## Layout

```
Makefile
include/            # headers; each layout has include/layouts/<name>.hpp
src/                # implementations
apps/apply_layout.cpp   # CLI binary
tests/test_main.cpp     # smoke tests
```

## Repackaging for distribution

```
make release
tar czf apply_layout-linux-x64.tar.gz -C build apply_layout-release
```
