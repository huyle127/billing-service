import Stripe from 'stripe';
import { STRIPE_ERROR_TYPES } from './stripe.constants';
import { StripeAdapterError } from './stripe.error';
import { StripeWebhookEvent } from './types/stripe.types';

const TOLERANCE_SECONDS = 300;

export function signTestPayload(payload: string, secret: string, receivedAt: Date): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: Math.floor(receivedAt.getTime() / 1000),
  });
}

export function constructEventFromSecrets(
  rawBody: Buffer,
  signature: string,
  secrets: string[],
  receivedAt: Date,
): StripeWebhookEvent {
  const event = firstVerifiedEvent(rawBody, signature, secrets, receivedAt);

  if (!event) {
    throw new StripeAdapterError(
      'Webhook signature does not match any configured signing secret',
      'permanent',
      STRIPE_ERROR_TYPES.signatureVerification,
      null,
    );
  }

  return toDomainEvent(event);
}

function firstVerifiedEvent(
  rawBody: Buffer,
  signature: string,
  secrets: string[],
  receivedAt: Date,
): Stripe.Event | null {
  for (const secret of secrets) {
    try {
      return Stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
        TOLERANCE_SECONDS,
        undefined,
        receivedAt.getTime(),
      );
    } catch {
      continue;
    }
  }

  return null;
}

function toDomainEvent(event: Stripe.Event): StripeWebhookEvent {
  const object = event.data.object as { id?: string };

  return {
    id: event.id,
    type: event.type,
    createdAt: new Date(event.created * 1000),
    apiVersion: event.api_version ?? null,
    objectId: object.id ?? null,
    payload: event as unknown as Record<string, unknown>,
  };
}
