# Tutte Exploration Report

## Goal

Follow the exploration plan in `docs/tutte_ideas.md` and test simple Tutte-family ideas that might improve layout quality without turning into a brand new algorithm.

The emphasis was:
- keep the methods simple
- stay inside the Tutte / positive-weight barycentric framework
- judge ideas by benchmark metrics, not by local visual intuition alone

Implemented exploration variants live in `static/js/layout-tutte-explore.js`.

Raw benchmark output is saved in `docs/tutte_exploration_report_raw.json`.

---

## Variants explored

### 1. `DistanceReweightedTutte`

Repeated exact Tutte solves with geometry-dependent positive edge weights.

Important tuning result:
- the literal inverse-distance rule from the note was bad in this repo
- on the two focus samples it dropped face score to:
  - `sample1`: `0.706 -> 0.643`
  - `sample2`: `0.762 -> 0.689`
- the only useful distance-based direction was the opposite sign: weights proportional to normalized edge length

So the benchmarked implementation uses normalized-length reweighting, not inverse-length reweighting.

### 2. `TutteAntiSmooth`

A light post-pass:

\[
p_i \leftarrow p_i + \eta (p_i - \operatorname{avgNbr}(i))
\]

with planarity-preserving step clipping.

### 3. `TutteFaceExpand`

A light face-centroid expansion pass:
- estimate bounded-face areas
- upweight small faces
- move incident interior vertices away from those face centroids
- clip each step to remain plane

### 4. `DistanceReweightedTuttePlus`

Best combined simple variant from the experiments:
- normalized-length distance reweighting
- then face-centroid expansion

I intentionally did not keep anti-smoothing enabled by default in the combined variant because it consistently hurt the difficult sample during tuning.

---

## Benchmark setup

Dataset:
- the same 22-graph benchmark from `docs/edgebalancer_objective_baseline.json`

Baselines compared:
- `Tutte`
- `TutteAdaptive`
- `Reweight`

New follow-up FABalancer:
- `TutteAdaptiveFaceExpand`

Metrics recorded:
- face area score
- edge length score
- angle resolution score
- edge length ratio
- spacing score
- runtime
- success / failure

Success rule:
- algorithm returned `ok`
- no crossings in the final drawing
- all five metrics were available

Known family failure:
- all Tutte-style variants except `Reweight` fail on `randomplanar4` for the same existing augmentation reason:
  `triangulateByFaceStellation requires simple face boundaries`

Additional existing `Reweight` failure:
- `grid2x20` crosses

---

## Full benchmark summary

| Algorithm | Success | Avg ms | Face | Edge | Angle | Ratio | Spacing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `Tutte` | `21/22` | `29.09` | `0.6096` | `0.8512` | `0.4297` | `0.1002` | `0.4462` |
| `TutteAdaptive` | `21/22` | `37.94` | `0.7731` | `0.8926` | `0.5200` | `0.1128` | `0.5906` |
| `TutteAdaptiveFaceExpand` | `21/22` | `154.21` | `0.7794` | `0.8932` | `0.5166` | `0.1126` | `0.5908` |
| `Reweight` | `20/22` | `423.98` | `0.8089` | `0.9039` | `0.5083` | `0.1219` | `0.6054` |
| `DistanceReweightedTutte` | `21/22` | `240.55` | `0.6358` | `0.8734` | `0.4375` | `0.1049` | `0.4848` |
| `TutteAntiSmooth` | `21/22` | `281.84` | `0.6094` | `0.8506` | `0.4290` | `0.0982` | `0.4395` |
| `TutteFaceExpand` | `21/22` | `296.97` | `0.6201` | `0.8558` | `0.4323` | `0.1015` | `0.4713` |
| `DistanceReweightedTuttePlus` | `21/22` | `530.08` | `0.6409` | `0.8780` | `0.4283` | `0.1060` | `0.4884` |

---

## Focus samples

### `sample1`

| Algorithm | Face | Edge | Angle | Ratio | Spacing |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Tutte` | `0.7060` | `0.8698` | `0.4941` | `0.0085` | `0.4728` |
| `TutteAdaptive` | `0.8442` | `0.9232` | `0.4419` | `0.0629` | `0.5130` |
| `TutteAdaptiveFaceExpand` | `0.8475` | `0.9237` | `0.4379` | `0.0576` | `0.5127` |
| `Reweight` | `0.8601` | `0.9310` | `0.4380` | `0.1002` | `0.5157` |
| `DistanceReweightedTutte` | `0.7707` | `0.9064` | `0.4542` | `0.0248` | `0.4790` |
| `TutteAntiSmooth` | `0.7028` | `0.8686` | `0.5240` | `0.0009` | `0.4735` |
| `TutteFaceExpand` | `0.7092` | `0.8765` | `0.4364` | `0.0002` | `0.4810` |
| `DistanceReweightedTuttePlus` | `0.7707` | `0.9064` | `0.4542` | `0.0248` | `0.4790` |

### `sample2`

| Algorithm | Face | Edge | Angle | Ratio | Spacing |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Tutte` | `0.7620` | `0.9232` | `0.3398` | `0.0035` | `0.4263` |
| `TutteAdaptive` | `0.8711` | `0.9273` | `0.4224` | `0.0136` | `0.6052` |
| `TutteAdaptiveFaceExpand` | `0.8770` | `0.9270` | `0.4298` | `0.0130` | `0.6043` |
| `Reweight` | `0.8651` | `0.9326` | `0.3891` | `0.0117` | `0.5722` |
| `DistanceReweightedTutte` | `0.7467` | `0.9326` | `0.2987` | `0.0003` | `0.3797` |
| `TutteAntiSmooth` | `0.7825` | `0.9131` | `0.3794` | `0.0035` | `0.4491` |
| `TutteFaceExpand` | `0.8021` | `0.9156` | `0.4102` | `0.0032` | `0.4824` |
| `DistanceReweightedTuttePlus` | `0.7735` | `0.9322` | `0.3146` | `0.0003` | `0.4005` |

---

## What worked

### `TutteAdaptiveFaceExpand`

This was the best result of the follow-up round.

It takes `TutteAdaptive` and adds a gated, very light face-centroid expansion post-pass:
- gate threshold: face score below `0.90`
- face expansion passes: `4`
- step size: `0.04`

Full-benchmark deltas over `TutteAdaptive`:
- face: `+0.0062`
- edge: `+0.0007`
- angle: `-0.0035`
- ratio: `-0.0002`
- spacing: `+0.0002`
- runtime: `+112.8 ms`

Important behavior:
- same `21/22` success count as `TutteAdaptive`
- better face score on `15` of the `21` successful graphs
- equal face score on the other `6`
- worse on `0`

Best face-score gains over `TutteAdaptive`:
- `planar3tree10`: `+0.038`
- `planar3tree30`: `+0.024`
- `randomplanar3`: `+0.018`
- `sample7`: `+0.013`
- `grid2x10`: `+0.009`
- `sample2`: `+0.006`
- `sample1`: `+0.003`

### `DistanceReweightedTutte`

This was the best new idea on the hard collapsed sample:
- `sample1` face score improved by `+0.0647`

It also beat plain `Tutte` on face score on `16/21` successful graphs.

Full-benchmark gains over `Tutte`:
- face: `+0.0263`
- edge: `+0.0222`
- angle: `+0.0078`
- ratio: `+0.0047`
- spacing: `+0.0386`

Best graphs for face gain over `Tutte`:
- `planar3tree30`: `+0.143`
- `planar3tree100`: `+0.076`
- `planar3tree10`: `+0.075`
- `sample1`: `+0.065`
- `sample3`: `+0.058`

### `TutteFaceExpand`

This was the best pure post-processing idea.

It did not solve `sample1`, but it gave a clean improvement on `sample2`:
- `sample2` face score improved by `+0.0401`

It also helped several triangulated / tree-like graphs:
- `planar3tree10`: `+0.079`
- `sample3`: `+0.062`
- `planar3tree30`: `+0.060`

### `DistanceReweightedTuttePlus`

This was the best average-performing new variant, but only narrowly:
- face: `0.6409`
- spacing: `0.4884`

That is only slightly better than `DistanceReweightedTutte`, while being much slower.

---

## What did not work

### `TutteAntiSmooth`

This idea is not worth pursuing in its current form.

It was basically flat or slightly worse than baseline on the full benchmark:
- face: `0.6096 -> 0.6094`
- spacing: `0.4462 -> 0.4395`

It helped `sample2` a bit, but it actively hurt `sample1`.

### Inverse-distance weighting

This is the clearest negative result from the tuning stage.

Literal inverse-length weights made the focus samples substantially worse:
- `sample1`: `0.706 -> 0.643`
- `sample2`: `0.762 -> 0.689`

So for this repo, the naive “short edges get bigger weights” rule points in the wrong direction.

---

## Comparison against existing improved Tutte variants

Only one follow-up beat `TutteAdaptive` on average face score:
- `TutteAdaptiveFaceExpand`

Gap to `TutteAdaptive`:
- `TutteAdaptiveFaceExpand`: `+0.0062`
- `DistanceReweightedTutte`: `-0.1373`
- `TutteAntiSmooth`: `-0.1637`
- `TutteFaceExpand`: `-0.1530`
- `DistanceReweightedTuttePlus`: `-0.1322`

Among the simple follow-ups:
- `TutteAdaptiveFaceExpand` is the only one that consistently improved `TutteAdaptive`
- none of the other simple variants beat `TutteAdaptive` on face score on any of the 21 successful benchmark graphs

So the current ranking stays:
1. `Reweight` for raw quality, with higher cost and one extra failure
2. `TutteAdaptive` for the best fast baseline
3. `TutteAdaptiveFaceExpand` for a modest but real quality bump when extra runtime is acceptable
4. best non-adaptive new simple experiment: `DistanceReweightedTuttePlus` or `DistanceReweightedTutte`

---

## Recommendation

### Keep

- keep `TutteAdaptive` as the main improved Tutte variant
- keep `TutteAdaptiveFaceExpand` as the best lightweight follow-up on top of it
- keep `Reweight` as the stronger but heavier option

### Experimental ideas worth keeping around

- `DistanceReweightedTutte`
  - because it is the only new simple idea that materially helps `sample1`
- `TutteFaceExpand`
  - because it is the cleanest cheap post-pass and helps `sample2` and several planar 3-tree style graphs

### Ideas not worth more time right now

- `TutteAntiSmooth`
- inverse-distance reweighting

### If we do one more follow-up

The best next refinement would be to tune the gate:
- current gate uses a face-score threshold of `0.90`
- the most promising next lever is making that gate more selective using a local small-face criterion instead of a single global threshold

I still would not replace `TutteAdaptive` as the default without a separate decision, but `TutteAdaptiveFaceExpand` is now good enough to keep as a serious variant rather than just a failed experiment.
