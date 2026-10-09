import { task } from '@swissspidy/belay-core';
import { classifierJudge, promptApi } from '@swissspidy/belay-web';

export const context = 'Requests spoken to a home voice assistant to add something to a calendar.';

export const FIELDS = ['event_name', 'date', 'time', 'person', 'place_name'];

const field = (description) => ({ type: ['string', 'null'], description });

export const extractionSchema = {
  type: 'structured',
  prompt:
    'Extract the calendar event from the request. Copy each value word for word from the request, ' +
    'without adding or rephrasing words. Use null for anything the request does not mention.',
  jsonSchema: {
    type: 'object',
    properties: {
      event_name: field('What the event is, e.g. "team meeting" or "dentist appointment"'),
      date: field('The day, e.g. "tomorrow", "friday" or "march fifth"'),
      time: field('The time of day, e.g. "three pm" or "noon"'),
      person: field('Who the event is with'),
      place_name: field('Where the event is'),
    },
    required: FIELDS,
    additionalProperties: false,
  },
  /** @returns {value is Record<string, string | null>} */
  validate: (value) =>
    !!value &&
    typeof value === 'object' &&
    Object.keys(value).length === FIELDS.length &&
    FIELDS.every((f) => value[f] === null || typeof value[f] === 'string'),
};

const IGNORED = new Set(['a', 'an', 'the', 'my', 'on', 'at', 'for', 'in', 'with', 'to', 'of']);

/**
 * Lowercase words without punctuation or articles and prepositions: "at 3 PM." and "3 pm" match.
 * A literal "null" counts as absent: small models sometimes write the string instead of JSON null.
 */
export function normalize(text) {
  if (text === null || text === undefined || /^\s*null\s*$/i.test(String(text))) return '';
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/);
  return words.filter((w) => w && !IGNORED.has(w)).join(' ');
}

/** Correct when every field matches the annotation after `normalize()`; "" and null both mean absent. */
export function sameEvent(value, expected) {
  return FIELDS.every((f) => normalize(value?.[f]) === normalize(expected?.[f]));
}

/**
 * The app side. The Prompt API writes the extraction on device; a Classifier API judge scores it.
 *
 * @param {{ cloud: import('@swissspidy/belay-core').CloudRunner, calibration?: string | object }} options
 */
export function createExtraction({ cloud, calibration = '/belay.calibration.json' }) {
  return task({
    name: 'event-extraction',
    schema: extractionSchema,
    context,
    local: promptApi(),
    judge: classifierJudge({ question: JUDGE_QUESTION }),
    cloud,
    calibration,
    threshold: 0.9,
  });
}

export const JUDGE_QUESTION =
  'Does the proposed answer contain exactly the event details stated in the input, copied correctly, with nothing invented and nothing missing?';
