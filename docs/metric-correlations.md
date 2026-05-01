# Metric Correlations

Input: `evaluation_data/all-algorithms-4bench-results.csv`

Rows: 79646
Successful runs used: 79385
Skipped rows: 261
Datasets: gd_collection, north, rome, sample_graphs, wiki
Algorithms: air, anglebalancer, ceg_bfs, ceg_xy, edgebalancer, facebalancer, forcedir, fpp, hybrid, impred, areagrad, reweight, schnyder, tutte

Primary statistic: Spearman rank correlation. Pearson is included as a secondary linear-correlation check.

## Spearman Matrix

| Metric | Angular Resolution | Aspect Ratio | Convexity | Edge-Length Deviation | Edge-Length Ratio | Edge Orthogonality | Face-Area Uniformity | Node Uniformity | Axis Alignment | Spacing Uniformity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Angular Resolution | 1.000 | 0.100 | 0.028 | 0.062 | 0.041 | 0.001 | 0.328 | -0.028 | -0.030 | 0.020 |
| Aspect Ratio | 0.100 | 1.000 | 0.052 | 0.208 | 0.108 | -0.007 | 0.096 | 0.274 | -0.112 | 0.181 |
| Convexity | 0.028 | 0.052 | 1.000 | 0.356 | 0.391 | 0.027 | 0.265 | 0.215 | -0.305 | 0.299 |
| Edge-Length Deviation | 0.062 | 0.208 | 0.356 | 1.000 | 0.856 | 0.019 | 0.374 | 0.692 | -0.495 | 0.760 |
| Edge-Length Ratio | 0.041 | 0.108 | 0.391 | 0.856 | 1.000 | 0.017 | 0.431 | 0.626 | -0.494 | 0.760 |
| Edge Orthogonality | 0.001 | -0.007 | 0.027 | 0.019 | 0.017 | 1.000 | 0.046 | 0.021 | 0.080 | 0.005 |
| Face-Area Uniformity | 0.328 | 0.096 | 0.265 | 0.374 | 0.431 | 0.046 | 1.000 | 0.330 | -0.267 | 0.438 |
| Node Uniformity | -0.028 | 0.274 | 0.215 | 0.692 | 0.626 | 0.021 | 0.330 | 1.000 | -0.432 | 0.693 |
| Axis Alignment | -0.030 | -0.112 | -0.305 | -0.495 | -0.494 | 0.080 | -0.267 | -0.432 | 1.000 | -0.442 |
| Spacing Uniformity | 0.020 | 0.181 | 0.299 | 0.760 | 0.760 | 0.005 | 0.438 | 0.693 | -0.442 | 1.000 |

## Strongest Pairs

| Metric A | Metric B | n | Pearson | Spearman |
| --- | --- | ---: | ---: | ---: |
| Edge-Length Deviation | Edge-Length Ratio | 79385 | 0.862998 | 0.855848 |
| Edge-Length Ratio | Spacing Uniformity | 79385 | 0.678726 | 0.760456 |
| Edge-Length Deviation | Spacing Uniformity | 79385 | 0.761847 | 0.760195 |
| Node Uniformity | Spacing Uniformity | 79385 | 0.692791 | 0.692762 |
| Edge-Length Deviation | Node Uniformity | 79385 | 0.669284 | 0.692137 |
| Edge-Length Ratio | Node Uniformity | 79385 | 0.500432 | 0.625619 |
| Edge-Length Deviation | Axis Alignment | 79385 | -0.482807 | -0.494832 |
| Edge-Length Ratio | Axis Alignment | 79385 | -0.404186 | -0.493675 |
| Axis Alignment | Spacing Uniformity | 79385 | -0.432647 | -0.442378 |
| Face-Area Uniformity | Spacing Uniformity | 79385 | 0.515640 | 0.437789 |
| Node Uniformity | Axis Alignment | 79385 | -0.432250 | -0.431695 |
| Edge-Length Ratio | Face-Area Uniformity | 79385 | 0.333733 | 0.431037 |
| Convexity | Edge-Length Ratio | 79385 | 0.412735 | 0.390900 |
| Edge-Length Deviation | Face-Area Uniformity | 79385 | 0.405977 | 0.373732 |
| Convexity | Edge-Length Deviation | 79385 | 0.384282 | 0.355669 |
| Face-Area Uniformity | Node Uniformity | 79385 | 0.424364 | 0.330163 |
| Angular Resolution | Face-Area Uniformity | 79385 | 0.229573 | 0.327969 |
| Convexity | Axis Alignment | 79385 | -0.343166 | -0.305119 |
| Convexity | Spacing Uniformity | 79385 | 0.341091 | 0.299387 |
| Aspect Ratio | Node Uniformity | 79385 | 0.297123 | 0.274397 |

Generated files:
- `evaluation_data/metric-correlations-pairs.csv`
- `evaluation_data/metric-correlations-spearman.csv`
- `evaluation_data/metric-correlations-pearson.csv`
