# AirPlus Current-Ideas Evaluation

Target case: `sample5`.

## Important Debugging Result

Before comparing ideas, there was a real bug in `AirPlus`:

- `solveBalancedPosition(...)` was called without `shortEdgeBoost`
- and without `longEdgeWeightScale`

That made candidate edge-term evaluations produce `NaN` whenever `edgeWeight > 0`, so the line search rejected every nonzero edge-aware move.

That bug was fixed first. The results below are all after that fix.

## Reference Numbers

Input drawing:
- face score `0.8801`
- edge score `0.9459`
- edge ratio `0.1859`

Plain `Air`:
- face score `0.9222`
- edge score `0.9439`
- edge ratio `0.0959`
- status `max_sweeps`

`AirPlus` baseline immediately after the bug fix, before landing any new idea:
- face score `0.8240`
- edge score `0.9466`
- edge ratio `0.1045`
- status `max_sweeps`

## Results By Idea

| Idea | Variant tested | Face score | Edge score | Edge ratio | Verdict |
|---|---|---:|---:|---:|---|
| 1 | gradient step when edge term is active, `edgeWeight=1e-3` | `0.8240` | `0.9466` | `0.1049` | no signal |
| 2 | sweep-dependent edge schedule, `edgeWeight=1e-3` | `0.8240` | `0.9466` | `0.1048` | no signal |
| 3 | bounded inward correction on oversized real faces | `0.8240` | `0.9466` | `0.1048` | no signal |
| 4 | class-normalized real vs dummy face budgets, tuned | `0.8282` | `0.9537` | `0.1853` | strong win |
| 5 | dummy triangles use seed-area targets, best blend `0.75` | `0.8144` | `0.9498` | `0.1340` | moderate win |
| 6 | edge objective only on original edges | `0.8240` | `0.9466` | `0.1049` | no signal |
| 7 | one-sided short-edge penalty | `0.8240` | `0.9466` | `0.1049` | no signal |
| 8 | more aggressive robust edge target, quantile `0.9` | `0.8240` | `0.9465` | `0.1048` | no signal |
| 9 | special handling for real outer-face vertices | `0.7619` | `0.9326` | `0.1036` | regression |
| 10 | global crossing-guard proxy, `edgeWeight=1e-3`, `maxSweeps=120` | `0.8139` | `0.9539` | `0.2047` | strong metrics, too expensive |

## Interpretation

### Ideas that did not matter

These behaved almost exactly like the post-bugfix baseline:

- idea 1
- idea 2
- idea 3
- idea 6
- idea 7
- idea 8

Conclusion:
- those changes did not move `AirPlus` out of its existing basin on `sample5`
- or they were too weak to matter in the current solver

### Idea 9 was a real regression

Scaling down dummy-face influence only at real outer-face vertices hurt both:

- face score
- edge score

So that direction does not look promising in this form.

### Idea 5 had real but smaller signal

Letting dummy triangles use seed-area targets helped:

- edge score improved from `0.9466` to `0.9498`
- edge ratio improved from `0.1045` to `0.1340`

But face score regressed from `0.8240` to `0.8144`.

So it is directionally good, but weaker than the best option.

### Idea 10 worked, but it is not the right complexity tradeoff

The global crossing-guard proxy gave strong numbers:

- edge score `0.9539`
- edge ratio `0.2047`

But it does that by adding heavy geometric checking in the inner loop.

That is not a good fit for the current goal:
- keep the implementation simple

So it is useful as evidence, but not the right idea to land.

## Best Idea

The best balance of simplicity and quality was:

### Idea 4: Class-Normalized Real vs Dummy Face Budgets

Tuned settings:
- `edgeWeight = 0.001`
- `realFaceBudget = 1.0`
- `dummyFaceBudget = 0.02`

Result on `sample5`:
- face score `0.8282`
- edge score `0.9537`
- edge ratio `0.1853`
- plane drawing `true`

Relative to the post-bugfix `AirPlus` baseline:
- face score: `+0.0042`
- edge score: `+0.0071`
- edge ratio: `+0.0808`

That ratio gain is large, and the face score did not regress.

## Landed Change

This idea is now the checked-in `AirPlus` implementation, together with:

- the edge-term bug fix in `solveBalancedPosition(...)`
- gradient-style local steps when the edge term is active

Current checked-in `AirPlus` on `sample5`:
- face score `0.8282`
- edge score `0.9537`
- edge ratio `0.1853`

## Final Takeaway

The important lesson is:

- the winning change was not a more complicated edge objective
- it was a better real-vs-dummy balance in the face objective

That matches the earlier debugging:
- the main structural problem was dummy influence in aggregate
- not just the exact edge penalty formula
