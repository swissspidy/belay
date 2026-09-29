import { task } from '@belay/core';
import { classifierApi } from '@belay/web';

export const context = 'Customer support messages sent to an online store.';

export const triageSchema = {
  type: 'categorical',
  prompt: 'Which team should handle this customer message?',
  options: [
    { label: 'account', description: 'Creating, editing, recovering or deleting a customer account; passwords and sign-in' },
    { label: 'billing', description: 'Invoices, payments, payment methods and refunds' },
    { label: 'order', description: 'Placing, changing, checking or cancelling an order' },
    { label: 'shipping', description: 'Delivery options, delivery times, shipping addresses and tracking a parcel' },
    { label: 'feedback', description: 'Complaints, claims against the company, reviews and feedback about the store or its service' },
  ],
};

/**
 * The app side: create the task once and call `run()` per message.
 *
 * @param {{ cloud: import('@belay/core').CloudRunner, calibration?: string | object, onEvent?: (e: unknown) => void }} options
 */
export function createTriage({ cloud, calibration = '/belay.calibration.json', onEvent }) {
  return task({
    name: 'ticket-triage',
    schema: triageSchema,
    context,
    local: classifierApi(),
    cloud,
    calibration,
    threshold: 0.9, // fallback if the calibration file cannot be loaded
    privacy: { redact: (text) => text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]') },
    ...(onEvent ? { onEvent } : {}),
  });
}
