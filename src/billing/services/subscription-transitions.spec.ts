import { SubscriptionStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_EVENTS, LifecycleEvent, transitionFor, UNCHANGED } from './subscription-transitions';

const STATUSES = Object.values(SubscriptionStatus);
const EVENTS = Object.values(LIFECYCLE_EVENTS);

function edgeOf(from: SubscriptionStatus, event: LifecycleEvent): string {
  const transition = transitionFor(from, event);

  return transition === UNCHANGED ? UNCHANGED : `${transition.to} records ${transition.records}`;
}

function wholeTable(): Record<string, string> {
  return Object.fromEntries(
    STATUSES.flatMap((from) => EVENTS.map((event) => [`${from} + ${event}`, edgeOf(from, event)])),
  );
}

describe('the subscription transition table', () => {
  it('carries these edges and answers unchanged for every other pair', () => {
    expect(wholeTable()).toEqual({
      'PENDING + activate': 'ACTIVE records CREATED',
      'PENDING + renew': 'ACTIVE records CREATED',
      'PENDING + resume': UNCHANGED,
      'PENDING + cancel': UNCHANGED,
      'PENDING + pastDue': UNCHANGED,
      'PENDING + expire': 'EXPIRED records EXPIRED',

      'ACTIVE + activate': UNCHANGED,
      'ACTIVE + renew': 'ACTIVE records RENEWED',
      'ACTIVE + resume': UNCHANGED,
      'ACTIVE + cancel': 'CANCELED records CANCELED',
      'ACTIVE + pastDue': 'PAST_DUE records PAST_DUE',
      'ACTIVE + expire': 'EXPIRED records EXPIRED',

      'CANCELED + activate': UNCHANGED,
      'CANCELED + renew': UNCHANGED,
      'CANCELED + resume': 'ACTIVE records RESUMED',
      'CANCELED + cancel': UNCHANGED,
      'CANCELED + pastDue': UNCHANGED,
      'CANCELED + expire': 'EXPIRED records EXPIRED',

      'PAST_DUE + activate': UNCHANGED,
      'PAST_DUE + renew': 'ACTIVE records RENEWED',
      'PAST_DUE + resume': UNCHANGED,
      'PAST_DUE + cancel': 'CANCELED records CANCELED',
      'PAST_DUE + pastDue': UNCHANGED,
      'PAST_DUE + expire': 'EXPIRED records EXPIRED',

      'EXPIRED + activate': UNCHANGED,
      'EXPIRED + renew': UNCHANGED,
      'EXPIRED + resume': UNCHANGED,
      'EXPIRED + cancel': UNCHANGED,
      'EXPIRED + pastDue': UNCHANGED,
      'EXPIRED + expire': UNCHANGED,
    });
  });
});
