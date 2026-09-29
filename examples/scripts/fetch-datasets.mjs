#!/usr/bin/env node
/**
 * Builds the example datasets from public, openly licensed Hugging Face datasets. The sampling is
 * deterministic (FNV-1a hash order), so re-running produces the same files.
 *
 *   node examples/scripts/fetch-datasets.mjs
 *
 * Pass dataset names (triage, moderation, intent, extraction) to fetch only those.
 * Behind a proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const API = 'https://datasets-server.huggingface.co';
const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.includes(name);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * GET with retries on network errors, timeouts and non-2xx responses (honoring Retry-After).
 * Throws after the last attempt, so a failed download never replaces a dataset file.
 */
async function request(url, { timeoutMs = 60_000, attempts = 6 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    let wait = 1000 * 2 ** attempt;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      failure = new Error(`HTTP ${res.status} for ${url}`);
      wait = Number(res.headers.get('retry-after')) * 1000 || wait;
    } catch (err) {
      failure = err;
    }
    if (attempt === attempts) throw failure;
    console.error(`${failure.message}; retrying in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const get = async (path) => (await request(`${API}${path}`)).json();

/** All rows of a split through the (fast, cached) /rows endpoint, optionally stopping early. */
async function allRows(dataset, split, { until } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const q = new URLSearchParams({ dataset, config: 'default', split, offset: String(offset), length: '100' });
    const page = await get(`/rows?${q}`);
    rows.push(...page.rows.map((r) => r.row));
    if (offset % 2000 === 0) console.error(`${dataset}/${split}: ${rows.length} of ${page.num_rows_total}`);
    if (page.rows.length < 100 || rows.length >= page.num_rows_total || until?.(rows)) return rows;
    await new Promise((r) => setTimeout(r, 250)); // be gentle with the public API
  }
}

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes and newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** Deterministic pick of `n` rows: sort by hash of the text, dedupe, take the first n. */
function pick(rows, n, text, seed) {
  const seen = new Set();
  return rows
    .map((row) => ({ row, h: fnv1a(`${seed}:${text(row)}`) }))
    .sort((a, b) => a.h - b.h)
    .map((x) => x.row)
    .filter((row) => {
      const key = text(row).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, n);
}

/** Interleave groups so the file is not sorted by label. */
function interleave(groups) {
  const out = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const g of groups) if (i < g.length) out.push(g[i]);
  return out;
}

async function write(path, examples) {
  await writeFile(path, examples.map((e, i) => JSON.stringify({ id: `${i + 1}`, ...e })).join('\n') + '\n');
  console.log(`wrote ${examples.length} examples to ${path}`);
}

// ---- Ticket triage: Bitext customer support (CDLA-Sharing-1.0) ---------------------------------
if (want('triage')) {
  const dataset = 'bitext/Bitext-customer-support-llm-chatbot-training-dataset';
  const mapping = {
    account: ['ACCOUNT'],
    billing: ['INVOICE', 'PAYMENT', 'REFUND'],
    order: ['ORDER', 'CANCEL'],
    shipping: ['DELIVERY', 'SHIPPING'],
    feedback: ['FEEDBACK'],
  };
  const csv = await (
    await request(
      `https://huggingface.co/datasets/${dataset}/resolve/main/Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv`,
      { timeoutMs: 300_000 },
    )
  ).text();
  const all = parseCsv(csv);
  if (all.length < 1000) throw new Error(`${dataset}: expected a full CSV, got ${all.length} rows`);
  console.error(`${dataset}: ${all.length} rows`);
  const groups = [];
  for (const [label, categories] of Object.entries(mapping)) {
    const rows = all.filter((r) => categories.includes(r.category));
    groups.push(pick(rows, 60, (r) => r.instruction, 'triage').map((r) => ({ input: r.instruction, label, source: r.intent })));
  }
  await write(new URL('../ticket-triage/examples.jsonl', import.meta.url), interleave(groups));
}

// ---- Content moderation: Civil Comments (CC0-1.0) ----------------------------------------------
if (want('moderation')) {
  const dataset = 'google/civil_comments';
  // "toxic" = at least half of the annotators marked it toxic; "ok" = at most 10% did.
  const short = (r) => r.text.length >= 20 && r.text.length <= 400;
  const rows = await allRows(dataset, 'test', {
    until: (rs) => rs.filter((r) => r.toxicity >= 0.5 && short(r)).length >= 600,
  });
  const toxic = rows.filter((r) => r.toxicity >= 0.5);
  const ok = rows.filter((r) => r.toxicity <= 0.1);
  const groups = [
    pick(toxic.filter(short), 150, (r) => r.text, 'moderation').map((r) => ({ input: r.text, label: true, toxicity: Math.round(r.toxicity * 1000) / 1000 })),
    pick(ok.filter(short), 150, (r) => r.text, 'moderation').map((r) => ({ input: r.text, label: false, toxicity: Math.round(r.toxicity * 1000) / 1000 })),
  ];
  await write(new URL('../content-moderation/examples.jsonl', import.meta.url), interleave(groups));
}

// ---- Intent detection: MASSIVE en-US (CC BY 4.0) -----------------------------------------------
if (want('intent')) {
  const dataset = 'SetFit/amazon_massive_intent_en-US';
  const intents = ['alarm_set', 'weather_query', 'play_music', 'calendar_set', 'iot_hue_lightoff', 'takeaway_order', 'news_query', 'email_sendemail'];
  // Source rows whose label is unrelated to the text (label noise in MASSIVE). Ambiguous rows stay.
  const mislabeled = new Set(['open the internet', 'open the folder app please', 'by get marks', 'user friendly']);
  const rows = [...(await allRows(dataset, 'test')), ...(await allRows(dataset, 'validation'))].filter(
    (r) => !mislabeled.has(r.text.trim().toLowerCase()),
  );
  const groups = intents.map((intent, i) =>
    pick(rows.filter((r) => r.label_text === intent), i < 4 ? 38 : 37, (r) => r.text, 'intent').map((r) => ({ input: r.text, label: intent })),
  );
  await write(new URL('../intent-detection/examples.jsonl', import.meta.url), interleave(groups));
}

// ---- Event extraction: MASSIVE en-US slot annotations (CC BY 4.0) -------------------------------
if (want('extraction')) {
  // The annotated utterances (`annot_utt`) are only in the release archive, not on the datasets server.
  const archive = gunzipSync(Buffer.from(await (await request('https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz', { timeoutMs: 300_000 })).arrayBuffer()));
  const rows = untarFile(archive, '1.1/data/en-US.jsonl').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const FIELDS = ['event_name', 'date', 'time', 'person', 'place_name'];
  const examples = [];
  for (const r of rows) {
    if (r.intent !== 'calendar_set') continue;
    const slots = [...r.annot_utt.matchAll(/\[(\w+) : ([^\]]+)\]/g)].map((m) => [m[1], m[2].trim()]);
    const kinds = slots.map(([k]) => k);
    // Only utterances whose annotations the schema covers completely, one value per field.
    if (!slots.length || kinds.some((k) => !FIELDS.includes(k)) || new Set(kinds).size !== kinds.length) continue;
    const label = Object.fromEntries(FIELDS.map((f) => [f, null]));
    for (const [k, v] of slots) label[k] = v;
    examples.push({ input: r.utt, label, source: r.annot_utt });
  }
  await write(new URL('../event-extraction/examples.jsonl', import.meta.url), pick(examples, 300, (e) => e.input, 'extraction'));
}

/** Reads one file from an uncompressed tar archive (ustar headers, 512-byte blocks). */
function untarFile(tar, name) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!entry) break;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const path = prefix ? `${prefix}/${entry}` : entry;
    if (path === name || path === `./${name}`) return tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not found in the archive`);
}
