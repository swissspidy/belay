import type { BelayEvent, CloudUsage, PriceTable, TokenPrices } from './types.js';

/** Normalizes a runner's usage report to a list of per-model parts. */
export function usageParts(usage: CloudUsage | readonly CloudUsage[] | undefined): CloudUsage[] {
  if (!usage) return [];
  return Array.isArray(usage) ? [...usage] : [usage as CloudUsage];
}

function pricesFor(prices: PriceTable | TokenPrices, model: string | undefined): TokenPrices {
  if (typeof (prices as TokenPrices).input === 'number') return prices as TokenPrices;
  const table = prices as PriceTable;
  if (model !== undefined && Object.hasOwn(table, model)) return table[model]!;
  const known = Object.keys(table).join(', ') || 'none';
  throw new Error(model === undefined ? `usage names no model and the price table has several (${known})` : `no price for model "${model}" (prices for: ${known})`);
}

/**
 * Cost of one cloud call from its token usage. Prices are per million tokens. A price table is
 * keyed by the model id the provider reports, so a call that a fallback model served is priced
 * at that model's rates. Throws when a model has no price: guessing would make every saving wrong.
 */
export function costOf(usage: CloudUsage | readonly CloudUsage[], prices: PriceTable | TokenPrices): number {
  let total = 0;
  for (const part of usageParts(usage)) {
    const p = pricesFor(prices, part.model);
    total +=
      part.inputTokens * p.input +
      part.outputTokens * p.output +
      (part.cacheReadInputTokens ?? 0) * (p.cacheRead ?? p.input) +
      (part.cacheWriteInputTokens ?? 0) * (p.cacheWrite ?? p.input);
  }
  return total / 1e6;
}

export interface SavingsMeterOptions {
  /** Per-token prices, to measure the cost of each cloud call from the usage its runner reports. */
  prices?: PriceTable | TokenPrices;
  /**
   * Cost of one cloud call, used when calls report no usage, and to value the calls the cascade
   * avoided before any cloud call has been measured. A calibration file's `cost.cloudPerRun` fits.
   */
  cloudPerRun?: number;
  currency?: string;
}

export interface SavingsSummary {
  currency: string | null;
  runs: number;
  /** Answered on device because the local confidence met the threshold. */
  local: number;
  /** Answered by the cloud runner. */
  cloud: number;
  /** Answered on device only because escalation was blocked (policy, consent, cloud error). */
  blocked: number;
  /** Spent on cloud calls: measured where usage was reported, otherwise `cloudPerRun` each. */
  cloudSpend: number | null;
  /** Mean cost of one cloud call (measured when possible). */
  costPerCloudRun: number | null;
  /** What the `local` runs would have cost in the cloud: `local × costPerCloudRun`. */
  saved: number | null;
  /** `saved / (saved + cloudSpend)`: the share of the cloud-only bill the cascade avoided. */
  savedShare: number | null;
  /** How many cloud calls were priced from reported usage. */
  measuredCalls: number;
}

export interface SavingsMeter {
  /** Pass as the task's `onEvent` (or call it from yours). */
  readonly onEvent: (event: BelayEvent) => void;
  /** Totals so far, for all tasks or one. */
  summary(task?: string): SavingsSummary;
  reset(): void;
}

interface Tally {
  runs: number;
  local: number;
  cloud: number;
  blocked: number;
  measuredCalls: number;
  measuredSpend: number;
}

/**
 * Counts what the cascade saves in production. Only runs that stayed on device because the
 * local answer was confident count as saved; runs kept local because escalation was blocked
 * are reported separately. Unmeasured calls, and the value of avoided ones, use the mean
 * measured cost per call, falling back to `cloudPerRun`.
 *
 * ```ts
 * const meter = savingsMeter({ prices, cloudPerRun: calibration.cost?.cloudPerRun });
 * const triage = task({ ..., onEvent: meter.onEvent });
 * meter.summary(); // { runs, local, cloud, cloudSpend, saved, savedShare, ... }
 * ```
 */
export function savingsMeter(options: SavingsMeterOptions = {}): SavingsMeter {
  const tallies = new Map<string, Tally>();
  const tallyFor = (task: string): Tally => {
    let t = tallies.get(task);
    if (!t) tallies.set(task, (t = { runs: 0, local: 0, cloud: 0, blocked: 0, measuredCalls: 0, measuredSpend: 0 }));
    return t;
  };

  const onEvent = (event: BelayEvent): void => {
    if (event.type !== 'run') return;
    const t = tallyFor(event.task);
    t.runs++;
    if (event.source === 'cloud') {
      t.cloud++;
      if (options.prices && event.cloudUsage?.length) {
        t.measuredSpend += costOf(event.cloudUsage, options.prices);
        t.measuredCalls++;
      }
    } else if (event.escalationBlocked) {
      t.blocked++;
    } else if (event.escalationReason === null) {
      t.local++;
    }
  };

  const summary = (task?: string): SavingsSummary => {
    const parts = task === undefined ? [...tallies.values()] : tallies.has(task) ? [tallies.get(task)!] : [];
    const sum = (key: keyof Tally) => parts.reduce((a, t) => a + t[key], 0);
    const runs = sum('runs');
    const local = sum('local');
    const cloud = sum('cloud');
    const measuredCalls = sum('measuredCalls');
    const measuredSpend = sum('measuredSpend');
    const costPerCloudRun = measuredCalls ? measuredSpend / measuredCalls : (options.cloudPerRun ?? null);
    const cloudSpend = costPerCloudRun === null ? null : measuredSpend + (cloud - measuredCalls) * costPerCloudRun;
    const saved = costPerCloudRun === null ? null : local * costPerCloudRun;
    const denominator = saved === null || cloudSpend === null ? 0 : saved + cloudSpend;
    return {
      currency: options.currency ?? null,
      runs,
      local,
      cloud,
      blocked: sum('blocked'),
      cloudSpend,
      costPerCloudRun,
      saved,
      savedShare: denominator > 0 ? saved! / denominator : null,
      measuredCalls,
    };
  };

  return { onEvent, summary, reset: () => tallies.clear() };
}
