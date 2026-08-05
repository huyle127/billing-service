import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Clock } from './clock';
import { FixedClock } from './fixed-clock';

@Injectable()
class DueDateService {
  constructor(private readonly clock: Clock) {}

  today(): Date {
    return this.clock.now();
  }
}

describe('Clock', () => {
  it('gives domain code the time a test chose, not the machine clock', async () => {
    const instant = new Date('2026-03-01T00:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      providers: [DueDateService, { provide: Clock, useValue: new FixedClock(instant) }],
    }).compile();

    expect(moduleRef.get(DueDateService).today()).toEqual(instant);
  });

  it('advances only when a test advances it', () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00.000Z'));

    clock.advance(31 * 24 * 60 * 60 * 1000);

    expect(clock.now().toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('hands out copies, so a caller cannot mutate the clock through the value it returned', () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00.000Z'));

    clock.now().setFullYear(2030);

    expect(clock.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});
