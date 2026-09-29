import { task } from '@belay/core';
import { classifierApi } from '@belay/web';

export const context = 'Reader comments posted under news articles.';

export const moderationSchema = {
  type: 'binary',
  prompt: 'Is this comment toxic, meaning rude, disrespectful or unreasonable enough to make someone leave the discussion?',
};

/**
 * Moderation keeps drafts private: escalation needs the user's consent, and "never" is used for
 * drafts that are still being typed.
 */
export function createModeration({ cloud, calibration = '/belay.calibration.json', consent }) {
  return task({
    name: 'content-moderation',
    schema: moderationSchema,
    context,
    local: classifierApi(),
    cloud,
    calibration,
    threshold: 0.9,
    privacy: { escalation: 'consent', consent },
  });
}
