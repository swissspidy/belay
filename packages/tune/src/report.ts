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

/**
 * The text of the pull request for a promoted config: what changed, the evidence, and what a
 * reviewer should look at. The config and calibration diffs are the pull request itself.
 */
export function renderPullRequest(report: TuneReport): { title: string; body: string } {
  const { baseline, best, spend, experiments } = report;
  const g = report.gate;
  const gain = (best.localShare - baseline.localShare) * 100;
  const title = report.repair
    ? `Belay Tune: restore ${pct(report.target, 0)} accuracy for ${report.task}`
    : `Belay Tune: ${report.task} keeps ${gain.toFixed(1)} points more local at ${pct(report.target, 0)} accuracy`;
  const out: string[] = [];
  out.push(
    report.repair
      ? `The committed local config of \`${report.task}\` no longer held its target accuracy. This change restores it, and passed the promotion gate on the holdout.`
      : `A change to the local side of \`${report.task}\` that passed the promotion gate on the holdout. Nothing ships until this is merged.`,
    '',
  );
  out.push(`**Change** (${best.rung}): ${best.hypothesis}`, '');
  out.push('| | Local share | Accuracy | Threshold | Prompt size |', '| --- | --- | --- | --- | --- |');
  const row = (name: string, s: TuneReport['baseline']) => `| ${name} | ${pct(s.localShare)} | ${pct(s.accuracy)}${s.targetMet ? '' : ' (target not met)'} | ${s.threshold === null ? 'none' : s.threshold.toFixed(3)} | ${s.contextChars ?? '–'} chars |`;
  out.push(row('Before, validation', baseline), row('After, validation', best));
  if (g) {
    out.push(`| Before, holdout | ${pct(g.baseline.localShare)} | ${pct(g.baseline.accuracy)} | | |`, `| After, holdout | ${pct(g.candidate.localShare)} | ${pct(g.candidate.accuracy)} | | |`);
  }
  out.push('', `Target: ${pct(report.target)} cascade accuracy. Local runner: ${[report.environment.runner, report.environment.model].filter(Boolean).join(', ')}${report.environment.userAgent ? ` (${report.environment.userAgent})` : ''}.`);
  if (report.cloudCostPer1k) out.push(`Cloud cost per 1,000 runs: ${report.cloudCostPer1k.best.toFixed(2)} ${spend.currency}, from ${report.cloudCostPer1k.baseline.toFixed(2)}.`);
  out.push('');

  if (g) {
    out.push('## Gate, on the holdout', '', g.basis === 'gold' ? 'Accuracy is measured against gold labels.' : 'The holdout has too few gold labels: accuracy here means agreement with the cloud.', '');
    out.push('| Check | Result | Detail |', '| --- | --- | --- |');
    for (const check of g.checks) out.push(`| ${check.name} | ${check.skipped ? 'not required' : 'pass'} | ${cell(check.detail)} |`);
    out.push('');
  }

  out.push('## Files', '');
  if (report.files.config) out.push(`- \`${report.files.config}\`: the local config. Apps apply it with \`withLocalConfig()\`.`);
  if (report.files.calibration) out.push(`- \`${report.files.calibration}\`: its threshold, fitted on validation.`);
  if (report.files.record) out.push(`- \`${report.files.record}\`: what it did on the holdout, input by input and without input text. \`belay verify\` compares later browsers with it.`);
  out.push(`- \`${report.files.ledger}\`: every experiment of this run and the ones before.`, '');

  out.push('## How it got here', '');
  out.push(`Run \`${report.run}\`: ${experiments.run} experiments, ${experiments.kept} kept, ${experiments.discarded} discarded, ${experiments.errors} errors. The reflecting model cost ${spend.reflector.toFixed(4)} ${spend.currency} in ${spend.calls} calls (cap ${spend.cap}). Protected files (gate config, instructions, evaluator, holdout): ${report.protected.unchanged ? 'unchanged' : 'CHANGED'}.`, '');
  const shown = report.entries.filter((e) => e.verdict === 'baseline' || e.verdict === 'kept' || e.verdict === 'promoted');
  out.push('| Id | Rung | Local share | Accuracy | Verdict | Hypothesis |', '| --- | --- | --- | --- | --- | --- |');
  for (const e of shown.slice(-12)) out.push(`| ${e.id} | ${e.rung} | ${e.scores ? pct(e.scores.localShare) : '–'} | ${e.scores ? pct(e.scores.accuracy) : '–'} | ${e.verdict} | ${cell(e.hypothesis)} |`);
  out.push('', `The discarded experiments are in the ledger (\`belay ledger --task ${report.task} --run ${report.run}\`).`, '');

  out.push('## Before you merge', '');
  if (best.rung !== 'threshold') out.push('- [ ] Read the config. Its examples are real inputs from your traces: check that none holds anything that should not be in the repository or in a prompt.');
  out.push('- [ ] The rules and examples make sense for the task, and not only for the validation set.', `- [ ] \`belay verify --task ${report.task}\` passes in CI.`, '');
  for (const note of report.notes) out.push(`> ${note}`, '');
  return { title, body: out.join('\n') };
}
