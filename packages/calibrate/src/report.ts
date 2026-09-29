import type { CalibrationFile } from '@belay/core';
import type { Analysis, Sample } from './analyze.js';

export interface ReportInput {
  file: CalibrationFile;
  analysis: Analysis;
  samples: readonly Sample[];
  /** Relative path of the dataset, shown in the header. */
  datasetPath?: string;
  cached?: { local: number; cloud: number };
}

/** Everything the page needs, serialized into the HTML. */
interface ReportData {
  task: string;
  createdAt: string;
  datasetPath: string | null;
  datasetSize: number;
  local: CalibrationFile['local'];
  cloud: CalibrationFile['cloud'];
  target: number;
  targetMet: boolean;
  threshold: number;
  thresholds: Record<string, number> | null;
  expected: CalibrationFile['expected'];
  accuracyInterval: [number, number];
  baseline: { localOnly: number; cloudOnly: number | null };
  currency: string | null;
  cloudOnlyCostPer1k: number | null;
  curve: CalibrationFile['curve'];
  histogram: { edges: number[]; correct: number[]; wrong: number[] };
  confusion: CalibrationFile['confusion'] | null;
  perOption: Analysis['perOption'];
  counts: Analysis['counts'];
  mistakes: { id: string; input: string; truth: string; predicted: string; confidence: number }[];
  cached: { local: number; cloud: number } | null;
}

function toData(input: ReportInput): ReportData {
  const { file, analysis, samples } = input;
  const bins = file.confidenceHistogram.counts.length;
  const correct = new Array<number>(bins).fill(0);
  const wrong = new Array<number>(bins).fill(0);
  for (const s of samples) {
    if (!s.local) continue;
    const b = Math.min(bins - 1, Math.floor(s.local.confidence * bins));
    (s.local.correct ? correct : wrong)[b]!++;
  }
  const atZero = analysis.curve[0]!;
  return {
    task: file.task,
    createdAt: file.createdAt,
    datasetPath: input.datasetPath ?? null,
    datasetSize: file.dataset.size,
    local: file.local,
    cloud: file.cloud,
    target: file.target.value,
    targetMet: analysis.targetMet,
    threshold: file.threshold,
    thresholds: file.thresholds ?? null,
    expected: file.expected,
    accuracyInterval: analysis.accuracyInterval,
    baseline: { localOnly: atZero.accuracy, cloudOnly: file.expected.cloudAccuracy },
    currency: file.cost?.currency ?? null,
    cloudOnlyCostPer1k: file.cost ? file.cost.cloudPerRun * 1000 : null,
    curve: file.curve,
    histogram: { edges: file.confidenceHistogram.edges, correct, wrong },
    confusion: file.confusion ?? null,
    perOption: analysis.perOption,
    counts: analysis.counts,
    mistakes: analysis.confidentMistakes.slice(0, 15).map((s) => ({
      id: s.id,
      input: s.input.length > 280 ? `${s.input.slice(0, 277)}…` : s.input,
      truth: s.truth,
      predicted: s.local!.label,
      confidence: s.local!.confidence,
    })),
    cached: input.cached ?? null,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A self-contained HTML report (no external requests). */
export function renderReport(input: ReportInput): string {
  const data = toData(input);
  // `<` escaped so the JSON can never close the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Belay calibration: ${escapeHtml(data.task)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="viz-root">
  <header>
    <p class="eyebrow">Belay calibration report</p>
    <h1>${escapeHtml(data.task)}</h1>
    <p class="meta" id="meta"></p>
  </header>
  <section class="tiles" id="tiles" aria-label="Summary"></section>
  <p class="callout" id="callout"></p>
  <section class="card">
    <h2>Accuracy and local share by threshold</h2>
    <p class="sub">Runs with local confidence at or above the threshold keep the local answer; the rest go to the cloud. Hover for values.</p>
    <div class="legend" id="curve-legend"></div>
    <div class="chart" id="curve-chart"></div>
  </section>
  <section class="card" id="cost-card" hidden>
    <h2>Cloud cost per 1,000 runs by threshold</h2>
    <div class="chart" id="cost-chart"></div>
  </section>
  <section class="card">
    <h2>Local confidence distribution</h2>
    <p class="sub">Examples per confidence bin, split by whether the local answer was correct. A well-calibrated model has few wrong answers in the high bins.</p>
    <div class="legend" id="hist-legend"></div>
    <div class="chart" id="hist-chart"></div>
  </section>
  <section class="card" id="confusion-card" hidden>
    <h2>Local confusion matrix</h2>
    <p class="sub">Rows are true labels, columns are local predictions (all examples, before escalation). Shade shows the share of the row.</p>
    <div class="table-wrap" id="confusion"></div>
  </section>
  <section class="card">
    <h2>Per option</h2>
    <p class="sub">At the recommended threshold${data.thresholds ? 's' : ''}.</p>
    <div class="table-wrap" id="per-option"></div>
  </section>
  <section class="card" id="mistakes-card" hidden>
    <h2>Confident local mistakes</h2>
    <p class="sub">Wrong local answers that would still be accepted at the recommended threshold, most confident first. Good candidates for better option descriptions.</p>
    <div class="table-wrap" id="mistakes"></div>
  </section>
  <section class="card">
    <details>
      <summary>Curve data (table view)</summary>
      <div class="table-wrap" id="curve-table"></div>
    </details>
  </section>
  <footer>Generated by <code>belay calibrate</code>. Reproduce with the same dataset and output cache.</footer>
</main>
<div class="tooltip" id="tooltip" role="status" hidden></div>
<script id="belay-data" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const CSS = `
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --text-muted: #6f6d68; --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834; --good: #006300; --critical: #d03b3b;
  --seq-0: #f0efec; --seq-1: #cde2fb; --seq-2: #9ec5f4; --seq-3: #5598e7; --seq-4: #256abf; --seq-5: #104281;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --text-muted: #9a988f; --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --good: #0ca30c; --critical: #e66767;
    --seq-0: #383835; --seq-1: #104281; --seq-2: #184f95; --seq-3: #256abf; --seq-4: #3987e5; --seq-5: #86b6ef;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
  --text-muted: #9a988f; --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --series-1: #3987e5; --series-2: #d95926; --good: #0ca30c; --critical: #e66767;
  --seq-0: #383835; --seq-1: #104281; --seq-2: #184f95; --seq-3: #256abf; --seq-4: #3987e5; --seq-5: #86b6ef;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: #f9f9f7; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) body { background: #0d0d0d; } }
:root[data-theme="dark"] body { background: #0d0d0d; }
.viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 1040px; margin: 0 auto; padding: 32px 16px 48px; min-height: 100vh; }
header h1 { font-size: 28px; margin: 2px 0 4px; letter-spacing: -0.01em; }
.eyebrow { margin: 0; color: var(--text-secondary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.meta { margin: 0; color: var(--text-secondary); font-size: 14px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 24px 0 12px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.tile .label { color: var(--text-secondary); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.callout { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; margin: 0 0 16px; color: var(--text-secondary); }
.callout strong { color: var(--text-primary); }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 18px 18px 14px; margin: 16px 0; }
.card h2 { font-size: 17px; margin: 0 0 2px; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0 0 10px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.key-line { width: 16px; height: 2px; border-radius: 1px; display: inline-block; }
.key-box { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.chart { position: relative; width: 100%; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { fill: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart .label-strong { fill: var(--text-secondary); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.confusion td.cell { text-align: center; font-variant-numeric: tabular-nums; min-width: 56px; border: 2px solid var(--surface-1); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); color: var(--text-secondary); }
.status-good { color: var(--good); font-weight: 600; }
.status-bad { color: var(--critical); font-weight: 600; }
details summary { cursor: pointer; font-weight: 600; }
.tooltip { position: fixed; pointer-events: none; z-index: 10; background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); max-width: 260px; }
.tooltip .row { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.tooltip .row b { font-weight: 600; font-variant-numeric: tabular-nums; }
footer { color: var(--text-muted); font-size: 12px; margin-top: 24px; }
code { font-size: 0.95em; }
`;

// The page script: plain ES2020, no dependencies. Builds SVG charts and tables from the embedded data.
const SCRIPT = String.raw`
(function () {
  const data = JSON.parse(document.getElementById('belay-data').textContent);
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const pct = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
  const num = (v, d = 2) => (v == null ? '–' : Number(v).toFixed(d));
  const money = (v) => (v == null ? '–' : new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency || 'USD', maximumFractionDigits: v < 10 ? 2 : 0 }).format(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const tip = $('tooltip');
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  const row = (color, label, value) =>
    '<div class="row"><span>' + (color ? '<span class="key-line" style="background:' + color + '"></span> ' : '') + esc(label) + '</span><b>' + value + '</b></div>';

  // ---- Header, tiles, callout ------------------------------------------------
  const e = data.expected;
  $('meta').textContent = [
    data.datasetSize + ' examples' + (data.datasetPath ? ' from ' + data.datasetPath : ''),
    'local: ' + data.local.runner + (data.local.model ? ' (' + data.local.model + ')' : ''),
    'cloud: ' + (data.cloud ? data.cloud.runner + (data.cloud.model ? ' (' + data.cloud.model + ')' : '') : 'none'),
    new Date(data.createdAt).toISOString().slice(0, 10),
  ].join(' · ');
  const tiles = [
 ['Recommended threshold', String(data.threshold), data.thresholds ? Object.keys(data.thresholds).length + ' per-label override(s)' : 'global'],
    ['Expected accuracy', pct(e.accuracy), '95% CI ' + pct(data.accuracyInterval[0], 0) + '–' + pct(data.accuracyInterval[1], 0) + ' · target ' + pct(data.target, 0)],
    ['Answered locally', pct(e.localShare, 0), 'local accuracy ' + pct(e.localAccuracy)],
    ['Cloud only', pct(data.baseline.cloudOnly), 'local only ' + pct(data.baseline.localOnly)],
  ];
  if (e.costPer1k != null) {
    tiles.push(['Cloud cost / 1k runs', money(e.costPer1k), 'vs ' + money(data.cloudOnlyCostPer1k) + ' cloud only']);
  }
  $('tiles').innerHTML = tiles.map(([l, v, n]) => '<div class="tile"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + '</div><div class="note">' + esc(n) + '</div></div>').join('');
  $('callout').innerHTML = data.targetMet
    ? '<span class="status-good">✓ Target met.</span> At threshold <strong>' + data.threshold + '</strong> the cascade reaches <strong>' + pct(e.accuracy) + '</strong> accuracy while answering <strong>' + pct(e.localShare, 0) + '</strong> of runs on device.'
    : '<span class="status-bad">✕ Target not met.</span> No threshold reaches ' + pct(data.target, 0) + ' on this dataset; the recommended threshold <strong>' + data.threshold + '</strong> maximizes accuracy (' + pct(e.accuracy) + '). Improve the cloud runner or lower the target.';
  if (data.counts.localFailed || data.counts.cloudFailed) {
    $('callout').innerHTML += ' <span class="pill">' + data.counts.localFailed + ' local failure(s), ' + data.counts.cloudFailed + ' cloud failure(s)</span>';
  }

  // ---- Line chart (step curves over threshold) --------------------------------
  const css = (name) => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();

  function lineChart(container, opts) {
    container.innerHTML = '';
    const W = Math.max(320, container.clientWidth), H = Math.round(Math.min(340, Math.max(220, W * 0.42)));
    const m = { l: 48, r: W < 500 ? 72 : 96, t: 12, b: 34 };
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label }, container);
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const x = (v) => m.l + v * iw;
    const y = (v) => m.t + ih - (v / opts.yMax) * ih;
    for (const t of opts.yTicks) {
      el('line', { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t), stroke: css('--grid'), 'stroke-width': 1 }, svg);
      el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = opts.yFormat(t);
    }
    el('line', { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: css('--axis'), 'stroke-width': 1 }, svg);
    const xStep = iw < 420 ? 0.25 : 0.1;
    for (let t = 0; t <= 1.0001; t += xStep) {
      el('text', { x: x(t), y: m.t + ih + 20, 'text-anchor': 'middle' }, svg).textContent = xStep === 0.25 ? t.toFixed(2) : t.toFixed(1);
    }
    el('text', { x: m.l + iw / 2, y: H - 2, 'text-anchor': 'middle' }, svg).textContent = 'threshold';
    // reference lines
    for (const ref of opts.refs || []) {
      if (ref.axis === 'y') {
        el('line', { x1: m.l, x2: m.l + iw, y1: y(ref.value), y2: y(ref.value), stroke: css('--text-muted'), 'stroke-width': 1 }, svg);
        el('text', { x: m.l + 4, y: y(ref.value) - 5, class: 'label-strong' }, svg).textContent = ref.label;
      } else {
        el('line', { x1: x(ref.value), x2: x(ref.value), y1: m.t, y2: m.t + ih, stroke: css('--text-secondary'), 'stroke-width': 1 }, svg);
        const anchorEnd = ref.value > 0.75;
        el('text', { x: x(ref.value) + (anchorEnd ? -6 : 6), y: m.t + 12, 'text-anchor': anchorEnd ? 'end' : 'start', class: 'label-strong' }, svg).textContent = ref.label;
      }
    }
    const pts = data.curve;
    const stepPath = (key) => {
      let d = '';
      pts.forEach((p, i) => {
        const x0 = x(p.threshold), x1 = x(i + 1 < pts.length ? pts[i + 1].threshold : 1);
        d += (i === 0 ? 'M' : 'L') + x0 + ',' + y(p[key]) + 'L' + x1 + ',' + y(p[key]);
      });
      return d;
    };
    const endY = [];
    for (const s of opts.series) {
      el('path', { d: stepPath(s.key), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (opts.series.length > 1 || opts.directLabel) {
        const last = pts[pts.length - 1];
        endY.push({ y: y(last[s.key]), s });
      }
    }
    // direct end labels; leader offset if they collide
    endY.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endY.length; i++) if (endY[i].y - endY[i - 1].y < 16) endY[i].ly = endY[i - 1].y + 16;
    for (const { y: yy, ly, s } of endY) {
      const ty = ly || yy;
      if (ly) el('line', { x1: m.l + iw + 2, x2: m.l + iw + 8, y1: yy, y2: ty, stroke: css('--axis'), 'stroke-width': 1 }, svg);
      el('text', { x: m.l + iw + 10, y: ty + 4, class: 'label-strong' }, svg).textContent = s.name;
    }
    // hover layer: crosshair + markers + tooltip
    const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: css('--axis'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    const dots = opts.series.map((s) => el('circle', { r: 4.5, fill: s.color, stroke: css('--surface-1'), 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
    const move = (evt) => {
      const r = svg.getBoundingClientRect();
      const tv = Math.min(1, Math.max(0, ((evt.clientX - r.left) * (W / r.width) - m.l) / iw));
      let p = pts[0];
      for (const q of pts) if (q.threshold <= tv + 1e-9) p = q;
      cross.setAttribute('x1', x(tv)); cross.setAttribute('x2', x(tv)); cross.setAttribute('visibility', 'visible');
      opts.series.forEach((s, i) => { dots[i].setAttribute('cx', x(tv)); dots[i].setAttribute('cy', y(p[s.key])); dots[i].setAttribute('visibility', 'visible'); });
      showTip(evt, '<div style="margin-bottom:4px;color:var(--text-secondary)">threshold ≥ ' + num(p.threshold, 3) + '</div>' + opts.tooltip(p));
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', leave);
  }

  function histogram(container) {
    container.innerHTML = '';
    const h = data.histogram;
    const W = Math.max(320, container.clientWidth), H = Math.round(Math.min(280, Math.max(200, W * 0.32)));
    const m = { l: 44, r: 16, t: 12, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Histogram of local confidence' }, container);
    const maxC = Math.max(1, ...h.correct.map((c, i) => c + h.wrong[i]));
    const step = Math.pow(10, Math.floor(Math.log10(maxC))) * (maxC / Math.pow(10, Math.floor(Math.log10(maxC))) > 5 ? 2 : 1);
    const yMax = Math.ceil(maxC / step) * step;
    const y = (v) => m.t + ih - (v / yMax) * ih;
    for (let t = 0; t <= yMax; t += step) {
      el('line', { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t), stroke: css('--grid'), 'stroke-width': 1 }, svg);
      el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = t.toLocaleString();
    }
    const n = h.correct.length, band = iw / n, bw = Math.min(24, band * 0.6);
    const radius = 4;
    const rounded = (x0, y0, w, hh) => {
      const r = Math.min(radius, hh, w / 2);
      return 'M' + x0 + ',' + (y0 + hh) + 'V' + (y0 + r) + 'Q' + x0 + ',' + y0 + ' ' + (x0 + r) + ',' + y0 + 'H' + (x0 + w - r) + 'Q' + (x0 + w) + ',' + y0 + ' ' + (x0 + w) + ',' + (y0 + r) + 'V' + (y0 + hh) + 'Z';
    };
    for (let i = 0; i < n; i++) {
      const cx = m.l + band * i + band / 2, x0 = cx - bw / 2;
      const c = h.correct[i], w = h.wrong[i];
      const yc = y(c), yw = y(c + w);
      if (c) {
        const hh = y(0) - yc;
        el('path', { d: w ? 'M' + x0 + ',' + y(0) + 'V' + yc + 'H' + (x0 + bw) + 'V' + y(0) + 'Z' : rounded(x0, yc, bw, hh), fill: css('--series-1') }, svg);
      }
      if (w) {
        const top = yw, hh = (c ? yc - 2 : y(0)) - top;
        if (hh > 0) el('path', { d: rounded(x0, top, bw, hh), fill: css('--series-2') }, svg);
      }
      const hit = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (evt) => showTip(evt,
        '<div style="margin-bottom:4px;color:var(--text-secondary)">confidence ' + h.edges[i].toFixed(1) + '–' + h.edges[i + 1].toFixed(1) + '</div>' +
        row(css('--series-1'), 'Correct', c) + row(css('--series-2'), 'Wrong', w) +
        row(null, 'Local accuracy', c + w ? pct(c / (c + w), 0) : '–')));
      hit.addEventListener('pointerleave', hideTip);
    }
    const every = band < 36 ? 2 : 1;
    for (let i = 0; i <= n; i += every) {
      el('text', { x: m.l + band * i, y: m.t + ih + 20, 'text-anchor': 'middle' }, svg).textContent = h.edges[i].toFixed(1);
    }
    el('line', { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: css('--axis'), 'stroke-width': 1 }, svg);
    const tx = m.l + data.threshold * iw;
    el('line', { x1: tx, x2: tx, y1: m.t, y2: m.t + ih, stroke: css('--text-secondary'), 'stroke-width': 1 }, svg);
    el('text', { x: tx + (data.threshold > 0.75 ? -6 : 6), y: m.t + 12, 'text-anchor': data.threshold > 0.75 ? 'end' : 'start', class: 'label-strong' }, svg).textContent = 'threshold ' + data.threshold;
    el('text', { x: m.l + iw / 2, y: H - 2, 'text-anchor': 'middle' }, svg).textContent = 'local confidence';
  }

  function render() {
    lineChart($('curve-chart'), {
      label: 'Cascade accuracy and local share by threshold',
      yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1], yFormat: (v) => Math.round(v * 100) + '%',
      series: [
        { key: 'accuracy', name: 'Accuracy', color: css('--series-1') },
        { key: 'localShare', name: 'Local share', color: css('--series-2') },
      ],
      refs: [
        { axis: 'y', value: data.target, label: 'target ' + pct(data.target, 0) },
        { axis: 'x', value: data.threshold, label: 'recommended ' + data.threshold },
      ],
      tooltip: (p) => row(css('--series-1'), 'Accuracy', pct(p.accuracy)) + row(css('--series-2'), 'Local share', pct(p.localShare)) +
        row(null, 'Local accuracy', pct(p.localAccuracy)) + (p.costPer1k != null ? row(null, 'Cost / 1k', money(p.costPer1k)) : ''),
    });
    if (data.currency) {
      $('cost-card').hidden = false;
      const maxCost = Math.max(...data.curve.map((p) => p.costPer1k || 0)) || 1;
      const step = Math.pow(10, Math.floor(Math.log10(maxCost)));
      const yMax = Math.ceil(maxCost / step) * step;
      const ticks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax];
      lineChart($('cost-chart'), {
        label: 'Cloud cost per 1,000 runs by threshold',
        yMax, yTicks: ticks, yFormat: money,
        series: [{ key: 'costPer1k', name: 'Cost', color: css('--series-1') }],
        refs: [{ axis: 'x', value: data.threshold, label: 'recommended ' + data.threshold }],
        tooltip: (p) => row(null, 'Cost / 1k', money(p.costPer1k)) + row(null, 'Accuracy', pct(p.accuracy)),
      });
    }
    histogram($('hist-chart'));
  }

  $('curve-legend').innerHTML = '<span><span class="key-line" style="background:var(--series-1)"></span>Accuracy (cascade)</span><span><span class="key-line" style="background:var(--series-2)"></span>Local share</span>';
  $('hist-legend').innerHTML = '<span><span class="key-box" style="background:var(--series-1)"></span>Local answer correct</span><span><span class="key-box" style="background:var(--series-2)"></span>Local answer wrong</span>';

  // ---- Tables ------------------------------------------------------------------
  // White or near-black text, whichever contrasts more with a hex fill.
  const inkOn = (hex) => {
    const c = hex.replace('#', '');
    const lin = (i) => { const v = parseInt(c.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    return (1.05) / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#0b0b0b';
  };
  const table = (head, rows) => '<table><thead><tr>' + head.map((h) => '<th' + (h.num ? ' class="num"' : '') + '>' + esc(h.label) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c, i) => '<td' + (head[i].num ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

  if (data.confusion) {
    $('confusion-card').hidden = false;
    const L = data.confusion.labels, M = data.confusion.local;
    const steps = ['--seq-0', '--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'];
    let html = '<table class="confusion"><thead><tr><th>true ↓ / predicted →</th>' + L.map((l) => '<th class="num">' + esc(l) + '</th>').join('') + '<th class="num">n</th></tr></thead><tbody>';
    M.forEach((r, i) => {
      const total = r.reduce((a, b) => a + b, 0);
      html += '<tr><th>' + esc(L[i]) + '</th>' + r.map((v, j) => {
        const share = total ? v / total : 0;
        const s = v === 0 ? 0 : Math.min(5, 1 + Math.floor(share * 5));
        return '<td class="cell" title="' + esc(L[i]) + ' → ' + esc(L[j]) + ': ' + v + ' (' + pct(share, 0) + ' of row)" style="background:var(' + steps[s] + ');color:' + inkOn(css(steps[s])) + (i === j ? ';font-weight:600' : '') + '">' + v + '</td>';
      }).join('') + '<td class="num">' + total + '</td></tr>';
    });
    $('confusion').innerHTML = html + '</tbody></table>';
  }

  $('per-option').innerHTML = table(
    [{ label: 'label' }, { label: 'examples', num: 1 }, { label: 'threshold', num: 1 }, { label: 'local accuracy', num: 1 }, { label: 'cloud accuracy', num: 1 }, { label: 'answered locally', num: 1 }, { label: 'cascade accuracy', num: 1 }],
    data.perOption.map((o) => [esc(o.label), o.count, num(o.threshold, 3), pct(o.localAccuracy), pct(o.cloudAccuracy), pct(o.localShare, 0), pct(o.cascadeAccuracy)]),
  );

  if (data.mistakes.length) {
    $('mistakes-card').hidden = false;
    $('mistakes').innerHTML = table(
      [{ label: 'id' }, { label: 'input' }, { label: 'true' }, { label: 'local' }, { label: 'confidence', num: 1 }],
      data.mistakes.map((m) => [esc(m.id), esc(m.input), esc(m.truth), esc(m.predicted), num(m.confidence, 3)]),
    );
  }

  $('curve-table').innerHTML = table(
    [{ label: 'threshold', num: 1 }, { label: 'accuracy', num: 1 }, { label: 'local share', num: 1 }, { label: 'local accuracy', num: 1 }].concat(data.currency ? [{ label: 'cost / 1k', num: 1 }] : []),
    data.curve.map((p) => [num(p.threshold, 4), pct(p.accuracy), pct(p.localShare), pct(p.localAccuracy)].concat(data.currency ? [money(p.costPer1k)] : [])),
  );

  render();
  let frame;
  addEventListener('resize', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
})();
`;
