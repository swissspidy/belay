import { task } from '@swissspidy/belay-core';
import { classifierApi } from '@swissspidy/belay-web';

export const context = 'Requests spoken to a home voice assistant.';

export const intentSchema = {
  type: 'categorical',
  prompt: 'Which action does the user want the assistant to take?',
  options: [
    { label: 'alarm_set', description: 'Set an alarm or wake-up call' },
    { label: 'weather_query', description: 'Ask about the weather or temperature' },
    { label: 'play_music', description: 'Play a song, artist, album or playlist' },
    { label: 'calendar_set', description: 'Add an event, meeting or reminder to the calendar' },
    { label: 'iot_hue_lightoff', description: 'Turn off or dim the lights' },
    { label: 'takeaway_order', description: 'Order food for delivery or takeaway' },
    { label: 'news_query', description: 'Ask for news or headlines' },
    { label: 'email_sendemail', description: 'Write or send an email' },
  ],
};

export function createIntent({ cloud, calibration = '/belay.calibration.json' }) {
  return task({ name: 'intent-detection', schema: intentSchema, context, local: classifierApi(), cloud, calibration, threshold: 0.9 });
}
