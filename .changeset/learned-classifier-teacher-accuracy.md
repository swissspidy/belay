---
"@swissspidy/belay-learn": minor
---

Learn: `teacherAccuracy` (opt-in) maps the classifier's calibrated agreement with the cloud to an estimate of being right, assuming the cloud's mistakes are independent of the classifier's (`correctForTeacher()`). Without it, the confidence can't exceed the cloud's own accuracy, so with a cloud right less often than the threshold nothing stays on the device. With it set, the confidence is a probability of being right: use `costAwareThreshold({ calibratedAgainst: 'labels' })`. See ADR 0006.
