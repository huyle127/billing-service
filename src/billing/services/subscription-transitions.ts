import { SubscriptionEventType, SubscriptionStatus } from '@prisma/client';

export const LIFECYCLE_EVENTS = {
  activate: 'activate',
  renew: 'renew',
  cancel: 'cancel',
  pastDue: 'pastDue',
  expire: 'expire',
} as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[keyof typeof LIFECYCLE_EVENTS];

export const UNCHANGED = 'unchanged';

export interface AppliedTransition {
  to: SubscriptionStatus;
  records: SubscriptionEventType;
}

export type Transition = typeof UNCHANGED | AppliedTransition;

const EXPIRES: AppliedTransition = {
  to: SubscriptionStatus.EXPIRED,
  records: SubscriptionEventType.EXPIRED,
};

const CANCELS: AppliedTransition = {
  to: SubscriptionStatus.CANCELED,
  records: SubscriptionEventType.CANCELED,
};

const RENEWS: AppliedTransition = {
  to: SubscriptionStatus.ACTIVE,
  records: SubscriptionEventType.RENEWED,
};

const ACTIVATES: AppliedTransition = {
  to: SubscriptionStatus.ACTIVE,
  records: SubscriptionEventType.CREATED,
};

const TRANSITIONS: Record<
  SubscriptionStatus,
  Partial<Record<LifecycleEvent, AppliedTransition>>
> = {
  [SubscriptionStatus.PENDING]: {
    activate: ACTIVATES,
    renew: ACTIVATES,
    expire: EXPIRES,
  },
  [SubscriptionStatus.ACTIVE]: {
    renew: RENEWS,
    cancel: CANCELS,
    pastDue: { to: SubscriptionStatus.PAST_DUE, records: SubscriptionEventType.PAST_DUE },
    expire: EXPIRES,
  },
  [SubscriptionStatus.CANCELED]: {
    expire: EXPIRES,
  },
  [SubscriptionStatus.PAST_DUE]: {
    renew: RENEWS,
    cancel: CANCELS,
    expire: EXPIRES,
  },
  [SubscriptionStatus.EXPIRED]: {},
};

export function transitionFor(from: SubscriptionStatus, event: LifecycleEvent): Transition {
  return TRANSITIONS[from][event] ?? UNCHANGED;
}
