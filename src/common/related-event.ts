/**
 * The provider event a state change is attributable to.
 *
 * Carried on ledger movements and payment records so that "why does this row
 * exist" is answerable from the row itself rather than by correlating
 * timestamps. Lives here rather than in any one domain because credit,
 * subscription, and add-on writes all record the same thing — the event that
 * caused them.
 */
export interface RelatedEvent {
  /** The provider's event type, e.g. `invoice.paid`. */
  type: string;
  /** The provider's identifier for the object or event. */
  id: string;
}
