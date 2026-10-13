# ADR 0006: A cloud that is often wrong

- Status: Accepted
- Date: 2026-10-12
- Scope: `@swissspidy/belay-learn` (`teacherAccuracy`, `correctForTeacher()`), docs, example scripts
- Amends: ADR 0004 §2 (what the confidence is a probability of), ADR 0005 §3 (which threshold rule applies)

## Context

The learned classifier's confidence is Platt-calibrated on whether it agreed with the labels it
received: the cloud's answers and users' corrections (ADR 0004 §2). So it is the probability of
*agreeing with the cloud*, and that can never exceed the cloud's own accuracy. With a teacher right
83.7% of the time on content moderation, a threshold of 0.9 kept 1.3% of comments on the device,
however good the classifier was.

Before adding anything, we asked where the headroom is. With an always-right teacher the
classifier is already close to what bge-small embeddings allow. Heads trained on `examples.jsonl`
and the first half of each stream, every label known, then tested on the second half:

| Task | Best head on the second half | Simulation, last 300 inputs |
| --- | --- | --- |
| Content moderation | 33% of inputs at 96% accuracy | 39% |
| Ticket triage | about 100% at 99% | 94% |
| Intent detection | about 90% at 99% | 87% |

A better head or calibration could not lift moderation much; that takes a stronger embedding model.
The large gap was elsewhere: a fallible cloud.

## Decision

`learnedClassifier({ teacherAccuracy })`, opt-in, takes how often the cloud is right (e.g.
`expected.cloudAccuracy` from `belay.calibration.json`) and maps the calibrated agreement to a
probability of being right. If the cloud's mistakes are independent of the classifier's and spread
evenly over the other labels, agreement = `p·a + (1 − p)·e` with `e = (1 − a)/(K − 1)` for `K`
labels, so

    p = (agreement − e) / (a − e)

clamped to [0, 1] (`correctForTeacher()`). It is the identity for a perfect teacher, and for one at
or below chance (`a ≤ 1/K`, where the denominator reaches zero: agreement says nothing about being
right). Calibration pairs scored against a reference label (a seed's leave-one-out pairs, users'
corrections) measure being right, not agreeing; the fit maps them into agreement space, a right one
to `a` and a wrong one to `e` as soft targets, so that the one correction applies to all. The confidence
is then calibrated against labels, not the cloud, so `costAwareThreshold()` takes
`calibratedAgainst: 'labels'`.

It is not the default, because the independence assumption fails exactly where it matters most.

## Results

Simulated streams, threshold 0.9 unless noted; on device / accuracy on device / overall accuracy.
`noisy`: wrong as often as the task's calibrated cloud model, at random. `hard`: as often (6.2% on
triage, 15.6% on moderation), but mostly on borderline inputs, where an embedding model also errs,
so the two make the same mistakes. Seeds are the 300 examples of `examples.jsonl`.

| Task | Teacher | Threshold | Seed | Without | With `teacherAccuracy` |
| --- | --- | --- | --- | --- | --- |
| Ticket triage | noisy, 94.3% right | 0.9 | – | 77.3 / 99.9 / 98.9 | 86.3 / 98.8 / 98.2 |
| Ticket triage | noisy | 0.95 | – | 54.7 / 99.9 / 97.3 | 77.5 / 100.0 / 98.9 |
| Ticket triage | noisy | 0.9 | 300 | 89.1 / 99.9 / 99.3 | 91.4 / 99.9 / 99.5 |
| Ticket triage | hard, 93.8% right | 0.9 | – | 66.8 / 100.0 / 97.2 | 81.1 / 99.2 / 97.9 |
| Ticket triage | hard | 0.95 | – | 60.5 / 100.0 / 97.0 | 71.1 / 99.8 / 97.6 |
| Content moderation | noisy, 83.7% right | 0.9 | – | 1.3 / 84.6 / 81.6 | 10.2 / 93.1 / 82.5 |
| Content moderation | noisy | 0.9 | 300 | 2.7 / 100.0 / 81.9 | 24.1 / 95.0 / 83.6 |
| Content moderation | hard, 84.4% right | 0.9 | – | 12.5 / 90.4 / 83.6 | 29.5 / **80.7** / 81.8 |
| Content moderation | hard | 0.9 | 300 | 13.0 / 96.2 / 84.3 | 40.8 / 89.5 / 84.7 |
| Intent detection | noisy, 99.7% right | 0.9 | – | 85.3 / 98.6 / 98.6 | 84.7 / 98.7 / 98.8 |

- With random cloud mistakes it is a large lift: on triage at 0.95, 23 more points on the device
  with no loss of accuracy; on moderation, the share kept goes from nothing to 10–24%, more
  accurate than the cloud.
- A threshold below the cloud's accuracy trades accuracy for share: triage at 0.9 lost 0.7 points
  overall, because 0.9 < 94.3%. At or above it, every measure improved.
- With correlated mistakes it is overconfident: cold-start moderation with the `hard` teacher
  answered 29.5% on the device at 80.7%, below the 0.9 target and below the cloud.
- A first version corrected the seed's pairs too, as if they measured agreement with the cloud;
  CodeRabbit's review caught it. The mix was inconsistent: seeded moderation kept 22.2% at
  93.7% and fell to 4.3% over the last 300 inputs. Mapping those pairs into agreement space (see
  the decision) gives 24.1% at 95.0%, and 37.3% over the last 300.

**Real cloud mistakes.** `examples/scripts/teacher-independence.mjs` compares the calibration's
cached cloud answers on `examples.jsonl` with a leave-one-out kNN. On ticket triage the kNN made
none of Claude's (or Jev's) mistakes, and the correction was exact. On moderation the mistakes are
correlated: Jev is wrong 22.5% of the time where the kNN is wrong and 14.1% where it is right, and
on the kNN's most confident half it is right 92% of the time (83.7% overall). There the correction
estimated 93% where the kNN was right 83% of the time.

So the guide says: with a cloud more accurate than the threshold, it isn't needed, and it still
lowers the agreement an answer needs (to 0.852 for a 94%-accurate cloud, two labels and a
threshold of 0.9); set the threshold at or above `teacherAccuracy`; on subjective tasks, check the
device's accuracy against users' corrections or a labeled sample before relying on it.

## Not adopted

- **Per-label calibration** (a Platt fit per predicted label; always-right teacher). The diagnosis
  suggested kNN's "civil" answers are far more reliable than its "toxic" ones, but in the
  simulation moderation went from 25.2% to 23.6% on device (96.0% → 96.2% accurate), and triage
  from 85.9% to 84.2%.
- **Risk control with a finite-sample guarantee** (Clopper–Pearson bounds per stratum: escalated
  pairs, and explored pairs weighted 1/p; tested as a fixed sequence, as in Learn then Test, and as
  a Bonferroni grid). It never broke its error target, but kept 7.3% of moderation on device at
  α = 10% (realized error 1.4%) against Platt's 25.2% at 4.0%, 8.7% of triage against 85.9%, and
  11.9% of intents against 84.8%; at α = 5%, nothing on moderation. The cause is arithmetic: 5%
  exploration yields about one label per 20 local answers, and certifying ≤ 10% error at δ = 0.1
  takes 25–45 clean labels in that region. Platt works because it extrapolates from the escalated
  runs, without a guarantee. A guarantee needs far more exploration, or a seed's labeled pairs.

These two were measured before ADR 0005's gate refits moved off the run path, a change that left
every unseeded result identical; the prototypes are not in the repository.

## Consequences

- With `teacherAccuracy` unset, nothing changes.
- A follow-up could have `belay calibrate` report the independence check for a task, so an app
  knows whether `teacherAccuracy` is safe for it before turning it on.
- Content moderation needs a stronger embedding model rather than a different head.
