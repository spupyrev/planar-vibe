Here is a concrete proposal a developer can implement.

## Goal

We want a score in `[0,1]` that measures **internal axis alignment** of a 2D point set.

The score should be high when many points reuse the same `x`-coordinates and/or the same `y`-coordinates, up to tolerance. It should be low when coordinates are mostly distinct, as with random points.

This metric is **not** about equal spacing or fitting an external grid. It is only about whether the point set internally organizes itself into a small number of vertical and horizontal lines.

---

# 1. Intuition

A point set is internally aligned when many points lie on the same vertical or horizontal lines.

For example, if 9 points have `x`-coordinates that fall into 3 groups, then we say the set uses 3 vertical lines, not 9. Random points would usually use many more distinct vertical lines.

The core objects are the clusters of `x`-coordinates and `y`-coordinates after merging coordinates that are within a tolerance.

The main refinement in this version is that we do not score alignment using only the **number** of lines. We also account for how many points lie on each line.

That matters because these two cases should not be treated equally:

* `5 + 4` points on two `x`-lines
* `8 + 1` points on two `x`-lines

Both use two lines, but the second case feels more aligned because almost all points reuse the same line and there is only one outlier.

---

# 2. Metric definition

Let the input be

`P = {(x_i, y_i)}_{i=1}^n`

with `n >= 2`.

After clustering nearby coordinates, let:

* `A_x = (a_1, ..., a_{L_x})` be the cluster sizes of the `x_i`'s
* `A_y = (b_1, ..., b_{L_y})` be the cluster sizes of the `y_i`'s

where:

* `a_k >= 1`, `sum_k a_k = n`
* `b_k >= 1`, `sum_k b_k = n`

Define the corresponding cluster mass fractions:

* `p_k = a_k / n`
* `q_k = b_k / n`

Now define the **effective number of lines** on each axis by the inverse Simpson concentration:

```text
Lx_eff = 1 / sum_k p_k^2
Ly_eff = 1 / sum_k q_k^2
```

Then define axis scores

```text
Sx = (n - Lx_eff) / (n - 1)
Sy = (n - Ly_eff) / (n - 1)
```

and the final score

```text
S = (Sx + Sy) / 2
```

This guarantees `S in [0,1]`.

---

# 3. Why effective line count

If all line clusters on one axis are equally populated, then the effective number of lines equals the ordinary number of lines.

Example:

* cluster sizes `3,3,3`
* fractions `1/3,1/3,1/3`
* `L_eff = 1 / (3 * (1/3)^2) = 3`

So this metric agrees with the simpler line-count metric in balanced cases.

But if one line dominates and the rest are small outliers, the effective number of lines is closer to `1`.

Example:

* cluster sizes `8,1`
* fractions `8/9,1/9`
* `L_eff = 1 / ((8/9)^2 + (1/9)^2) = 81/65 approx 1.246`

This captures the idea that the set is "almost on one line" even though there are technically two clusters.

---

# 4. Interpretation

* `S = 0`: worst case
  all `x` values are distinct and all `y` values are distinct, so every cluster has size `1` and `Lx_eff = Ly_eff = n`

* `S = 1`: best case
  all points share one `x`-line and one `y`-line, so `Lx_eff = Ly_eff = 1`

* intermediate values reflect partial reuse of coordinate lines

Examples:

* 9 points, `x`-cluster sizes `3,3,3`
  then `Lx_eff = 3`, so
  `Sx = (9 - 3) / 8 = 0.75`

* 9 points, `x`-cluster sizes `8,1`
  then `Lx_eff = 81/65 approx 1.246`, so
  `Sx approx (9 - 1.246) / 8 approx 0.969`

* if those same points use 9 distinct `y`-lines, then `Sy = 0`

* overall in the `8+1` example:
  `S approx (0.969 + 0) / 2 approx 0.484`

This is slightly higher than the pure line-count metric, which matches the intuition that one outlier should not erase strong alignment.

---

# 5. How line clustering works

We still need a way to decide which coordinates belong to the same line, allowing tolerance.

For one axis, say `x`:

1. sort the values
2. walk left to right
3. group consecutive values into the same cluster if they are close enough
4. start a new cluster when there is a sufficiently large gap

This is 1D clustering by thresholding sorted gaps.

---

# 6. Choosing the tolerance automatically

The tolerance should come from the data.

## Motivation

If multiple points belong to the same underlying line, then after sorting coordinates:

* gaps within the same line are small
* gaps between different lines are large

So the lower tail of the consecutive-gap distribution is a proxy for within-line noise.

## Axis-specific tolerance

For axis values `(v_1, ..., v_n)` (either all `x_i` or all `y_i`):

1. sort:
   `v_(1) <= ... <= v_(n)`

2. consecutive gaps:
   `g_j = v_(j+1) - v_(j)`, for `j = 1, ..., n-1`

3. let `q_p` be a low quantile of the gaps, recommended `p = 0.2`

4. define the raw tolerance:
   `eps_raw = c * q_p`
   with recommended `c = 2`

So the default is:

```text
eps = 2 * quantile_0.2(g_1, ..., g_{n-1})
```

## Safeguards

Use clamping to avoid degeneracy:

```text
eps = min(alpha * range(v), max(eps_min, 2 * q_0.2))
```

where:

* `range(v) = max(v) - min(v)`
* `alpha = 0.05` is a reasonable cap
* `eps_min` is a small numeric floor, for example `1e-9 * range(v)` or a fixed tiny constant

Use this separately for `x` and `y`:

* `eps_x`
* `eps_y`

## Fallback for small `n` or degenerate cases

If there are too few points, or all values are identical, or quantiles are unstable, use:

```text
eps = 0.01 * range(v)
```

and if range is zero, set `eps = 0`.

## Practical note

It is useful to make the tolerance overrideable in code. The automatic rule is a good default, but a fixed `eps` is helpful for experiments, tests, and comparisons across datasets.

---

# 7. Exact clustering algorithm

For one axis:

Input: values `v_1, ..., v_n`, tolerance `eps`

1. sort the values
2. initialize the first cluster with the first sorted value
3. for each consecutive pair in sorted order:
   * if gap `> eps`, start a new cluster
   * otherwise stay in the current cluster
4. output the cluster sizes

If the sorted values are `v_(1) <= ... <= v_(n)`, then the cluster boundaries occur exactly where

```text
v_(j+1) - v_(j) > eps
```

for `j = 1, ..., n-1`.

This produces cluster sizes `a_1, ..., a_L`, which are then used to compute the effective number of lines.

Apply this once to the `x_i`'s and once to the `y_i`'s.

---

# 8. Summary

The metric has two layers:

1. **Cluster coordinates into reused axis lines**, using a tolerance derived from sorted gaps.
2. **Score how concentrated the points are across those lines**, using effective line count rather than raw line count.

This keeps the method simple and intuitive:

* if all coordinates are distinct, the score is low
* if many points reuse the same few lines, the score is high
* if one line dominates and the rest are just a few outliers, the score remains high
38