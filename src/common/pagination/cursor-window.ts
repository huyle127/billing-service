export type CursorBound =
  | { at: Date; ties: 'all' }
  | { at: Date; ties: 'none' }
  | { at: Date; ties: 'below'; id: string };

export interface CursorWindow {
  limit: number;
  from?: Date;
  before?: CursorBound;
}
