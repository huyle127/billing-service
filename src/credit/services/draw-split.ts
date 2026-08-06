export interface LedgerBalances {
  subscription: number;
  addon: number;
}

export type DrawSplit = { sufficient: false } | ({ sufficient: true } & LedgerBalances);

export function splitDraw(amount: number, balances: LedgerBalances): DrawSplit {
  if (amount > balances.subscription + balances.addon) return { sufficient: false };

  const subscription = Math.min(amount, balances.subscription);

  return { sufficient: true, subscription, addon: amount - subscription };
}
