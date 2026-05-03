# Agentic Layout

## Goal

Design and implement a planar graph drawing algorithm that maximizes the final score under the evaluation below.

## Evaluation

For each input graph, the algorithm produces straight-line vertex positions. The drawing must be plane: if the algorithm crashes, times out, or produces a non-plane drawing, that instance receives `0.0` for every quality metric.

The evaluator computes these 10 quality metrics for every instance:

- angular resolution (`angularResolution`)
- aspect ratio (`aspectRatio`)
- convexity (`convexity`)
- edge-length deviation (`edgeLengthDeviation`)
- edge-length ratio (`edgeRatio`)
- edge orthogonality (`edgeOrthogonality`)
- face-area uniformity (`face`)
- node uniformity (`nodeUniformity`)
- axis alignment (`alignment`)
- spacing uniformity (`spacing`)

For each metric, aggregate values across graphs with p50. The final score is the mean of those 10 p50 metric scores. Runtime is measured only for the timeout and is not part of the final score.

Use `planar_train.dot` for development and progress checks. Final evaluation will use a larger, unreleased benchmark. The time limit is 30 seconds per graph instance.

Use this command for local evaluation:

```bash
node scripts/run-dataset-multi-algorithm-batch.mjs \
  --algorithms agentic \
  --timeout-ms 30000 \
  --files planar_train.dot \
  --output evaluation_data/agentic-train-results.csv
```

The script also writes `evaluation_data/agentic-train-results-scores.csv`. In that score file, `ok=0` or a missing metric value counts as `0.0` for that metric before p50.

## Baselines

The strongest current baselines on `planar_train.dot` are:

- EdgeBalancer: `0.622226`
- Hybrid: `0.596484`

## Implementation Rules

1. Put the implementation in `static/js/layout-agentic.js`.
2. Export it as `window.PlanarVibeAgentic.applyAgenticLayout(cy, options)`.
3. Make only the small wiring changes needed to load and benchmark the new algorithm. Optional tests or helper scripts are allowed.
4. Use existing shared utilities freely. If a useful helper is private to another layout file, copy the needed code into `layout-agentic.js`.
5. Randomized choices must be deterministic for a given graph, so runs are reproducible.
6. There are no algorithmic constraints beyond the API, plane output, and timeout. New augmentation strategies, staged approaches, fallbacks, and metric-driven tricks are all allowed and encouraged.

## Development Process

Work in stages. For each stage, write the idea or goal in `docs/agentic_log.md`, prototype it, run focused experiments on `planar_train.dot`, then record whether it helped or was discarded.
Keep the log concise: enough to explain what was tried, how it scored, and what should be tried next. At the end of the project, the document should be a complete working summary of all development.
