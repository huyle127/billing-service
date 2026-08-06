import { describe, expect, it } from 'vitest';
import { splitDraw } from './draw-split';

describe('splitting a consumption across the two ledgers', () => {
  it('draws from subscription credits alone while they cover the amount', () => {
    expect(splitDraw(40, { subscription: 100, addon: 50 })).toEqual({
      sufficient: true,
      subscription: 40,
      addon: 0,
    });
  });

  it('exhausts subscription credits before touching add-on credits', () => {
    expect(splitDraw(120, { subscription: 100, addon: 50 })).toEqual({
      sufficient: true,
      subscription: 100,
      addon: 20,
    });
  });

  it('draws from add-on credits when the subscription ledger is empty', () => {
    expect(splitDraw(20, { subscription: 0, addon: 50 })).toEqual({
      sufficient: true,
      subscription: 0,
      addon: 20,
    });
  });

  it('takes exactly what both ledgers hold when the amount matches the total', () => {
    expect(splitDraw(150, { subscription: 100, addon: 50 })).toEqual({
      sufficient: true,
      subscription: 100,
      addon: 50,
    });
  });

  it('reports insufficiency without a partial split', () => {
    expect(splitDraw(20, { subscription: 10, addon: 5 })).toEqual({ sufficient: false });
  });

  it('reports insufficiency against two empty ledgers', () => {
    expect(splitDraw(1, { subscription: 0, addon: 0 })).toEqual({ sufficient: false });
  });
});
