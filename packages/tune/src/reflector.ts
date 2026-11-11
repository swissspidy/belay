/**
 * The reflecting model: reads failures and successes of the local side and proposes candidates.
 * It returns JSON and writes nothing. See ADR 0007 §7.
 */
import { labelOf, normalizeOptions, usageParts, type CloudUsage, type TaskSchema } from '@swissspidy/belay-core';
import type { ReflectRequest, Reflector } from '@swissspidy/belay-calibrate';
import type { LedgerEntry } from './ledger.js';
import type { ConfigPatchOp, LocalConfig } from './local-config.js';

export type ReflectFn = (
  request: ReflectRequest,
  options: { signal?: AbortSignal; reportUsage: (usage: CloudUsage | CloudUsage[]) => void },
) => Promise<unknown>;

/**
 * Builds a reflector from a function that calls your model, like `cloudAdapter()` does for the
 * cloud runner. Return an object matching `jsonSchema`, or its JSON. Report the token usage, or
 * every call is charged the flat `costPerCall`.
 */
export function reflectorAdapter(fn: ReflectFn, id = 'reflector'): Reflector {
  return {
    id,
    async reflect(request, options) {
      const usage: CloudUsage[] = [];
      const output = await fn(request, { ...options, reportUsage: (u) => void usage.push(...usageParts(u)) });
      return { output, ...(usage.length ? { usage } : {}) };
    },
  };
}

/** One example the reflecting model is shown: always from the training split. */
export interface ReflectExample {
  id: string;
  input: string;
  label: string;
  /** What the local model answered, and how sure it was. */
  local: string | null;
  confidence: number | null;
}

export type ProposalRung = 'examples' | 'rules' | 'wording';

/** The order the loop climbs in: each rung is tried when the one before has stopped helping. */
export const PROPOSAL_RUNGS: readonly ProposalRung[] = ['examples', 'rules', 'wording'];

export interface ReflectContext {
  task: string;
  schema: TaskSchema;
  taskContext?: string;
  /** The human-written instructions (`belay.tune.md`). */
  instructions?: string;
  rung: ProposalRung;
  /** The config the candidates start from. */
  parent: LocalConfig;
  parentScore: { localShare: number; accuracy: number; threshold: number | null };
  target: number;
  /** Local answers that were wrong. */
  wrong: ReflectExample[];
  /** Right, but below the threshold: escalated for nothing. */
  unsure: ReflectExample[];
  /** Right and confident. */
  confident: ReflectExample[];
  /** Earlier experiments of this task, so that failed ideas are not tried again. */
  history: LedgerEntry[];
  /** How many candidates to propose. */
  count: number;
  /** The most characters the context, rules and examples may take together. */
  maxContextChars: number;
}

const SYSTEM = `You improve a small on-device classifier that sits in front of a large cloud model.
The small model answers an input itself when it is confident enough, and passes the input to the cloud model otherwise.
Your goal: make the small model answer more inputs itself (a higher "local share") without the combined accuracy falling below the target.
You do this only by changing what the small model is given: a few examples, short rules, or how the question and the labels are worded for it. You cannot rename or remove a label, change its weights, or change the cloud model.

The small model has a short context and reads it literally. What helps:
- examples that show a pattern it gets wrong or is unsure about, with the correct label;
- rules that name a pattern and the label it means, in one plain sentence each;
- a question and label descriptions that say, in the words of the inputs, what separates the labels it confuses.
What hurts: long text, vague advice, rules that restate the task, and anything that only fits a single input.

Propose distinct candidates. Each has one hypothesis: one sentence saying which mistakes it should fix and why.
Do not repeat an experiment from the history that was discarded, unless you change it in a way the hypothesis names.`;

const line = (e: ReflectExample): string =>
  `[${e.id}] ${JSON.stringify(e.input.replace(/\s+/g, ' ').slice(0, 300))} | correct: ${e.label} | small model: ${e.local ?? '(no answer)'}${e.confidence === null ? '' : ` (confidence ${e.confidence.toFixed(2)})`}`;

/** The JSON Schema of the reflecting model's answer for a rung. */
export function proposalSchema(rung: ProposalRung, count: number): Record<string, unknown> {
  const change =
    rung === 'examples'
      ? { examples: { type: 'array', items: { type: 'string' }, description: 'Ids of training examples to give the small model as examples, in order. This list replaces the current examples.' } }
      : rung === 'rules'
        ? { rules: { type: 'array', items: { type: 'string' }, description: 'The complete list of rules for the small model. This list replaces the current rules.' } }
        : {
            prompt: { type: 'string', description: 'The question the small model is asked. An empty string means the task\'s own question.' },
            options: {
              type: 'array',
              description: 'A description for each label you want to describe differently. This replaces the current wording: a label left out gets the description from the task, listed under Labels.',
              items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: { type: 'string' }, description: { type: 'string' } } },
            },
          };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        description: `Exactly ${count} distinct candidates.`,
        items: { type: 'object', additionalProperties: false, required: ['hypothesis', ...Object.keys(change)], properties: { hypothesis: { type: 'string' }, ...change } },
      },
    },
  };
}

export function buildReflectRequest(ctx: ReflectContext): ReflectRequest {
  const { schema } = ctx;
  const options = schema.type === 'categorical' || schema.type === 'ordinal' ? normalizeOptions(schema.options) : [{ label: 'true' }, { label: 'false' }];
  const parts: string[] = [];
  parts.push(`# Task "${ctx.task}"`);
  if (ctx.taskContext) parts.push(`Context: ${ctx.taskContext}`);
  if ((schema as { prompt?: string }).prompt) parts.push(`Question: ${(schema as { prompt?: string }).prompt}`);
  parts.push(['Labels:', ...options.map((o) => `- ${o.label}${'description' in o && o.description ? `: ${o.description}` : ''}`)].join('\n'));
  if (ctx.instructions?.trim()) parts.push(`# Instructions from the task's owner\n${ctx.instructions.trim()}`);

  parts.push(
    `# Where it stands\nTarget accuracy: ${(ctx.target * 100).toFixed(1)}%. With the current context the small model answers ${(ctx.parentScore.localShare * 100).toFixed(1)}% of inputs itself` +
      ` (confidence threshold ${ctx.parentScore.threshold === null ? 'none: everything goes to the cloud' : ctx.parentScore.threshold.toFixed(3)}), at ${(ctx.parentScore.accuracy * 100).toFixed(1)}% combined accuracy.`,
  );
  parts.push(
    [
      '# Current context given to the small model',
      `Rules: ${ctx.parent.rules?.length ? '' : '(none)'}`,
      ...(ctx.parent.rules ?? []).map((r) => `- ${r}`),
      ...(ctx.parent.wording?.prompt ? [`Question as worded for it: ${ctx.parent.wording.prompt}`] : []),
      ...Object.entries(ctx.parent.wording?.options ?? {}).map(([label, description]) => `Label "${label}" as described to it: ${description}`),
      `Examples: ${ctx.parent.examples?.length ? '' : '(none)'}`,
      ...(ctx.parent.examples ?? []).map((e) => `- ${JSON.stringify(e.input.slice(0, 160))} -> ${labelOf(schema, e.label) ?? JSON.stringify(e.label)}`),
    ].join('\n'),
  );

  parts.push(`# Training inputs the small model got wrong (${ctx.wrong.length})\n${ctx.wrong.map(line).join('\n') || '(none)'}`);
  parts.push(`# Training inputs it got right but was not sure about, so they went to the cloud (${ctx.unsure.length})\n${ctx.unsure.map(line).join('\n') || '(none)'}`);
  parts.push(`# Training inputs it got right and was sure about (${ctx.confident.length})\n${ctx.confident.map(line).join('\n') || '(none)'}`);

  const history = ctx.history.filter((e) => (PROPOSAL_RUNGS as readonly string[]).includes(e.rung)).slice(-30);
  if (history.length) {
    parts.push(
      [
        '# Experiments so far',
        ...history.map((e) => `- [${e.verdict}] (${e.rung}) ${e.hypothesis}${e.scores ? ` -> local share ${(e.scores.localShare * 100).toFixed(1)}%` : ''}: ${e.reason} | change: ${JSON.stringify(e.patch).slice(0, 400)}`),
      ].join('\n'),
    );
  }

  parts.push(
    ctx.rung === 'examples'
      ? `# Your turn\nPropose ${ctx.count} candidates. Each is a list of training example ids (from the lists above, in brackets) to give the small model as examples. Choose few (3 to 8) and order them. Prefer inputs it got wrong or was unsure about, and cover the labels it confuses.`
      : ctx.rung === 'rules'
        ? `# Your turn\nPropose ${ctx.count} candidates. Each is the complete list of rules for the small model (at most 6, one sentence each). Contrast the inputs it got wrong or was unsure about with the ones it got right: a rule names a pattern in the input and the label it means.`
        : `# Your turn\nPropose ${ctx.count} candidates. Each rewords what the small model is asked: the question, the descriptions of labels, or both. Keep every label's name. Describe a label by what its inputs say, and make the labels it confuses tell apart in their descriptions. Keep each description to one short sentence.`,
  );
  parts.push(`Everything given to the small model (context, rules and examples together) must stay under ${ctx.maxContextChars} characters.`);
  return { system: SYSTEM, prompt: parts.join('\n\n'), jsonSchema: proposalSchema(ctx.rung, ctx.count) };
}

export interface Proposal {
  rung: ProposalRung;
  hypothesis: string;
  patch: ConfigPatchOp[];
}

/**
 * Checks the reflecting model's answer and turns it into patches. Anything malformed is dropped
 * and named in `rejected`: the model's output is never trusted to be well-formed.
 */
export function parseProposals(
  output: unknown,
  rung: ProposalRung,
  train: ReadonlyMap<string, { input: string; label: unknown }>,
  count: number,
  /** The task's schema: needed for the `wording` rung, to refuse a label the task does not have. */
  schema?: TaskSchema,
): { proposals: Proposal[]; rejected: string[] } {
  let value = output;
  const rejected: string[] = [];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    } catch {
      return { proposals: [], rejected: ['the answer is not JSON'] };
    }
  }
  const candidates = (value as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return { proposals: [], rejected: ['the answer has no "candidates" array'] };
  const proposals: Proposal[] = [];
  for (const [i, candidate] of candidates.entries()) {
    if (proposals.length >= count) break;
    const c = candidate as { hypothesis?: unknown; examples?: unknown; rules?: unknown; prompt?: unknown; options?: unknown } | null;
    const hypothesis = typeof c?.hypothesis === 'string' ? c.hypothesis.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    if (!hypothesis) {
      rejected.push(`candidate ${i + 1} has no hypothesis`);
      continue;
    }
    if (rung === 'examples') {
      const ids = Array.isArray(c!.examples) ? c!.examples.map((id) => String(id).replace(/^\[|\]$/g, '')) : [];
      const unknown = ids.filter((id) => !train.has(id));
      if (!ids.length || unknown.length) {
        rejected.push(`candidate ${i + 1}: ${ids.length ? `unknown training ids ${unknown.slice(0, 3).join(', ')}` : 'no examples'}`);
        continue;
      }
      const unique = [...new Set(ids)];
      proposals.push({ rung, hypothesis, patch: [{ op: 'add', path: '/examples', value: unique.map((id) => ({ input: train.get(id)!.input, label: train.get(id)!.label })) }] });
    } else if (rung === 'wording') {
      const labels = new Set(schema && (schema.type === 'categorical' || schema.type === 'ordinal') ? normalizeOptions(schema.options).map((o) => o.label) : []);
      const prompt = typeof c!.prompt === 'string' ? c!.prompt.replace(/\s+/g, ' ').trim() : '';
      const described = (Array.isArray(c!.options) ? c!.options : []).filter((o): o is { label: string; description: string } => typeof o?.label === 'string' && typeof o?.description === 'string' && !!o.description.trim());
      const unknown = described.filter((o) => !labels.has(o.label)).map((o) => o.label);
      if (unknown.length) {
        rejected.push(`candidate ${i + 1}: describes labels the task does not have (${unknown.slice(0, 3).join(', ')})`);
        continue;
      }
      if (!prompt && !described.length) {
        rejected.push(`candidate ${i + 1}: no wording`);
        continue;
      }
      const wording = { ...(prompt ? { prompt } : {}), ...(described.length ? { options: Object.fromEntries(described.map((o) => [o.label, o.description.replace(/\s+/g, ' ').trim()])) } : {}) };
      proposals.push({ rung, hypothesis, patch: [{ op: 'add', path: '/wording', value: wording }] });
    } else {
      const rules = Array.isArray(c!.rules) ? c!.rules.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.replace(/\s+/g, ' ').trim()) : [];
      if (!rules.length) {
        rejected.push(`candidate ${i + 1}: no rules`);
        continue;
      }
      proposals.push({ rung, hypothesis, patch: [{ op: 'add', path: '/rules', value: [...new Set(rules)] }] });
    }
  }
  return { proposals, rejected };
}
