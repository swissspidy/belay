import type { TuneReport } from './loop.js';

const pct = (v: number | null | undefined, d = 1): string => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const OUTCOME: Record<TuneReport['outcome'], string> = {
  promoted: 'A candidate passed the gate.',
  rejected: 'The best candidate failed the gate. Nothing was changed.',
  inconclusive: 'The gate could not tell: the holdout is too small. Nothing was changed.',
  plateau: 'Plateau: nothing beat the baseline. Nothing was changed.',
};

/** The night's report, as Markdown: what ran, what it cost, and why it ended as it did. */
export function renderReport(report: TuneReport): string {
  const { baseline, best, experiments, spend } = report;
  const out: string[] = [];
  out.push(`# Belay Tune: ${report.task}, run ${report.run}`, '');
  out.push(`**${OUTCOME[report.outcome]}**`, '');
  out.push(`- Local runner: ${[report.environment.runner, report.environment.model].filter(Boolean).join(', ')}${report.environment.userAgent ? ` (${report.environment.userAgent})` : ''}`);
  out.push(`- Target: ${pct(report.target)} cascade accuracy`);
  out.push(`- Data: ${report.datasets.train} training, ${report.datasets.validation} validation (${report.datasets.gold.validation} gold)${report.datasets.holdout === null ? '; the holdout was not used' : `, ${report.datasets.holdout} holdout (${report.datasets.gold.holdout} gold)`}`);
  out.push(`- Experiments: ${experiments.run} run, ${experiments.kept} kept, ${experiments.discarded} discarded (${experiments.screenedOut} at screening), ${experiments.errors} errors; stopped: ${report.stopped}`);
  out.push(`- Reflector spend: ${spend.reflector.toFixed(4)} ${spend.currency} in ${spend.calls} calls (cap ${spend.cap} ${spend.currency})`);
  if (report.cloudCostPer1k) out.push(`- Cloud cost per 1,000 runs: ${report.cloudCostPer1k.best.toFixed(2)} ${spend.currency} (baseline ${report.cloudCostPer1k.baseline.toFixed(2)})`);
  out.push(`- Protected files (gate config, instructions, evaluator, holdout): ${report.protected.unchanged ? 'unchanged' : 'CHANGED'} (${report.protected.start.slice(0, 19)}…)`, '');

  out.push('## On validation', '');
  out.push('| | Local share | Accuracy | Threshold | Against gold | Agrees with cloud | Prompt size |', '| --- | --- | --- | --- | --- | --- | --- |');
  const row = (name: string, s: TuneReport['baseline']) =>
    `| ${name} | ${pct(s.localShare)} | ${pct(s.accuracy)}${s.targetMet ? '' : ' (target not met)'} | ${s.threshold === null ? 'none' : s.threshold.toFixed(3)} | ${pct(s.goldAccuracy)} | ${pct(s.cloudAgreement)} | ${s.contextChars ?? '–'} chars |`;
  out.push(row('Baseline', baseline));
  if (best.id !== report.entries[0]?.id) out.push(row(`Best (${best.id}, ${best.rung})`, best));
  out.push('');
  if (best.id !== report.entries[0]?.id) out.push(`Best candidate's hypothesis: ${best.hypothesis}`, '');

  if (report.gate) {
    const g = report.gate;
    out.push('## Gate, on the holdout', '');
    out.push(g.basis === 'gold' ? 'Accuracy is measured against gold labels.' : 'The holdout has too few gold labels: accuracy here means agreement with the cloud.', '');
    out.push('| Check | Result | Detail |', '| --- | --- | --- |');
    for (const check of g.checks) out.push(`| ${check.name} | ${check.skipped ? 'skipped' : check.passed ? 'pass' : check.inconclusive ? '**inconclusive**' : '**FAIL**'} | ${cell(check.detail)} |`);
    out.push('');
    out.push(`Holdout: local share ${pct(g.candidate.localShare)} (baseline ${pct(g.baseline.localShare)}), accuracy ${pct(g.candidate.accuracy)} (baseline ${pct(g.baseline.accuracy)}).`, '');
  }

  if (report.notes.length) {
    out.push('## Notes', '');
    for (const note of report.notes) out.push(`- ${note}`);
    out.push('');
  }

  out.push('## Experiments', '');
  out.push('| Id | Rung | Stage | Local share | Accuracy | Verdict | Hypothesis | Reason |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of report.entries) {
    out.push(`| ${e.id} | ${e.rung} | ${e.stage} | ${e.scores ? pct(e.scores.localShare) : '–'} | ${e.scores ? pct(e.scores.accuracy) : '–'} | ${e.verdict} | ${cell(e.hypothesis)} | ${cell(e.reason)} |`);
  }
  out.push('');
  if (report.files.config) out.push(`Wrote \`${report.files.config}\` and \`${report.files.calibration}\`. Review them and merge to ship.`, '');
  return out.join('\n');
}
