import { describe, expect, it } from 'vitest';
import { HistoryPosition } from './history-cursor';
import { comparePositions, decodeCursor, encodeCursor } from './history-cursor';

const AT = new Date('2026-08-11T10:00:00.000Z');

describe('history-cursor', () => {
  it('round-trips a position and refuses one naming a source that does not exist', () => {
    const position: HistoryPosition = { occurredAt: AT, source: 'credit', id: 'a|b' };
    const forged = Buffer.from(`${AT.toISOString()}|invoice|abc`, 'utf8').toString('base64url');

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(() => decodeCursor(forged)).toThrow(/cannot be read/);
    expect(() => decodeCursor('not a cursor')).toThrow(/cannot be read/);
  });

  it('orders rows sharing one timestamp by source then id, never arbitrarily', () => {
    const tied: HistoryPosition[] = [
      { occurredAt: AT, source: 'payment', id: 'bbb' },
      { occurredAt: AT, source: 'subscription', id: 'zzz' },
      { occurredAt: AT, source: 'payment', id: 'aaa' },
      { occurredAt: AT, source: 'credit', id: 'mmm' },
    ];

    expect(tied.sort(comparePositions).map((position) => `${position.source}:${position.id}`))
      .toEqual(['subscription:zzz', 'credit:mmm', 'payment:bbb', 'payment:aaa']);
  });
});
