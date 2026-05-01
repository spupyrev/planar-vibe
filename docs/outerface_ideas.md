# Outer-Face Selection Ideas

Goal: choose one simple default outer-face rule that works well across the shared outer-face-based stack.

Affected algorithms in this sweep:
- `Tutte`
- `Air`
- `AreaGrad`
- `FaceBalancer`
- `Reweight`
- `ForceDir`
- `ImPrEd`
- `CEG-bfs`
- `CEG-xy`

Ignored here:
- `FPP`
- `Schnyder`

Method:
- keep the rest of the code fixed
- vary only the default `chooseOuterFaceFromEmbedding(...)` strategy
- run the full benchmark on all affected algorithms and all benchmark graphs
- compare totals, failures, and notable per-graph changes

## Candidate Strategies

| Key | Description |
| --- | --- |
| `current` | Current rule: prefer `embedding.outerFace` when it is chordless, otherwise choose the longest chordless face. |
| `explicit` | Use `embedding.outerFace` whenever available; otherwise fall back to the longest face. |
| `longest` | Choose the face with the largest boundary length. |
| `longest_chordless` | Choose the longest face with no boundary chord. |
| `shortest` | Choose the face with the smallest boundary length. |
| `shortest_chordless` | Choose the shortest face with no boundary chord. |
| `fewest_chords_longest` | Prefer fewer boundary chords; break ties by longer boundary. |
| `fewest_chords_shortest` | Prefer fewer boundary chords; break ties by shorter boundary. |
| `len_minus_chords` | Maximize `faceLength - chordCount`. |
| `len_over_chords` | Maximize `faceLength / (chordCount + 1)`. |
| `min_degree_sum_longest` | Prefer smaller total degree on the boundary; break ties by longer boundary. |
| `max_degree_sum_longest` | Prefer larger total degree on the boundary; break ties by longer boundary. |
| `max_min_degree_longest` | Maximize the minimum degree along the boundary; break ties by longer boundary. |
| `min_degree_variance_longest` | Prefer more regular boundary degrees; break ties by longer boundary. |

## Results

Benchmark sweep completed.

Raw outputs were written to:
- `docs/outerface_benchmark_raw.csv`
- `docs/outerface_benchmark_summary.csv`

Overall totals below aggregate all affected algorithms on all 22 benchmark graphs.

| Key | ok | Runtime ms | Face | Edge | Angle | EdgeRatio | Spacing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `current` | `196/198` | `705007.232` | `132.2404` | `173.3683` | `77.9792` | `21.8921` | `116.5102` |
| `explicit` | `196/198` | `719923.402` | `132.2404` | `173.3683` | `77.9792` | `21.8921` | `116.5102` |
| `longest` | `190/198` | `771227.935` | `128.5436` | `171.3938` | `78.3059` | `25.1861` | `125.2521` |
| `longest_chordless` | `196/198` | `777545.735` | `132.2404` | `173.3683` | `77.9792` | `21.8921` | `116.5102` |
| `shortest` | `193/198` | `837439.177` | `101.1314` | `166.0318` | `61.4990` | `14.5181` | `107.0251` |
| `shortest_chordless` | `193/198` | `847478.192` | `101.1314` | `166.0318` | `61.4990` | `14.5181` | `107.0251` |
| `fewest_chords_longest` | `197/198` | `763218.715` | `132.6934` | `174.2192` | `78.0305` | `21.8923` | `116.7384` |
| `fewest_chords_shortest` | `193/198` | `794996.006` | `101.1314` | `166.0318` | `61.4990` | `14.5181` | `107.0251` |
| `len_minus_chords` | `191/198` | `721924.169` | `132.1211` | `172.5310` | `80.6449` | `25.3970` | `126.0266` |
| `len_over_chords` | `196/198` | `722390.385` | `131.5686` | `174.0454` | `79.2343` | `23.9730` | `118.3506` |
| `min_degree_sum_longest` | `194/198` | `845208.259` | `88.3427` | `157.5853` | `59.1661` | `13.8713` | `100.8040` |
| `max_degree_sum_longest` | `190/198` | `751778.969` | `119.5585` | `173.5182` | `76.2716` | `25.7594` | `129.5916` |
| `max_min_degree_longest` | `197/198` | `794670.644` | `96.8991` | `175.1828` | `67.4141` | `16.0387` | `122.6974` |
| `min_degree_variance_longest` | `197/198` | `868943.178` | `91.5887` | `163.3098` | `62.2062` | `14.4443` | `105.0980` |

## Observations

### 1. `current` remains a very strong baseline

- It is the fastest of the stable high-quality rules.
- `explicit` and `longest_chordless` are dominated by `current`: same quality and robustness, but slower.
- This means the current rule is already near a local optimum among the "simple longest chordless" family.

### 2. `fewest_chords_longest` is the only clearly competitive alternative

- Compared with `current`, it is:
  - `+1` more successful run overall: `197/198` vs `196/198`
  - `+0.34%` better on total face score
  - `+0.49%` better on total edge score
  - `+8.26%` slower overall
- The extra success comes from `ImPrEd` on `planar3tree100`, which TLEs under `current` but succeeds under `fewest_chords_longest`.
- For the shared-prep stack (`Tutte`, `Air`, `AreaGrad`, `FaceBalancer`, `Reweight`, `ForceDir`) and the two `CEG` variants, the quality totals ended up unchanged from `current`; the measurable benefit showed up almost entirely in `ImPrEd`.

### 3. Pure "longest" is too risky

- `longest` loses `6` runs relative to `current`.
- The common failure pattern is `sample5` on the shared-prep algorithms:
  - `Tutte`
  - `Air`
  - `AreaGrad`
  - `FaceBalancer`
  - `Reweight`
  - `ForceDir`
- The observed error there is `Provided outer face is not a face of the embedding` or the corresponding invalid-face failure in `FaceBalancer`.
- So "take the longest face" is not robust enough as a shared default.

### 4. "Shortest" families are clearly bad defaults

- `shortest`, `shortest_chordless`, and `fewest_chords_shortest` all collapse to the same totals.
- They are much slower than `current` and lose `3` runs.
- They also cause `grid4x20` failures for:
  - `Tutte`
  - `Air`
  - `AreaGrad`
- These are easy rejects.

### 5. Degree-based rules underperform badly

- `min_degree_sum_longest`, `max_min_degree_longest`, and `min_degree_variance_longest` all lose a lot of face quality.
- Some of them improve edge totals or success count slightly, but only at a very large face-quality cost and with slower runtime.
- `min_degree_sum_longest` is especially poor:
  - `-33.20%` face total vs `current`
  - `-9.10%` edge total vs `current`

### 6. Chord-aware scoring helps more than length-only scoring

- `fewest_chords_longest` outperforms `longest`.
- `len_over_chords` is also fairly stable:
  - same success count as `current`
  - `+0.39%` edge total
  - but `-0.51%` face total
  - and `+2.47%` runtime
- `len_minus_chords` is not good enough:
  - `-5` runs vs `current`

## Shortlist

The data leaves a very small shortlist:

1. `current`
   - simplest mental model
   - best runtime among the strong candidates
   - already robust

2. `fewest_chords_longest`
   - best overall totals
   - one extra successful run
   - small face/edge improvements
   - but about `8.3%` slower

3. `len_over_chords`
   - acceptable but not compelling
   - slightly better edge total
   - slightly worse face total
   - slower than `current`

## Provisional Recommendation

Do not switch the default yet.

The choice is really between:
- `current` if we prioritize simplicity and speed
- `fewest_chords_longest` if we are willing to pay about `8%` runtime for a small quality/robustness gain

Everything else is clearly dominated or too unstable to be the shared default.
