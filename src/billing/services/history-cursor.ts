import { ValidationError } from '@/common/errors/domain.exception';
import { HISTORY_SOURCES, HistorySource, SOURCE_RANK } from '../billing.constants';

export interface HistoryPosition {
  occurredAt: Date;
  source: HistorySource;
  id: string;
}

const SEPARATOR = '|';

function isSource(value: string): value is HistorySource {
  return HISTORY_SOURCES.some((source) => source === value);
}

export function encodeCursor(position: HistoryPosition): string {
  const parts = [position.occurredAt.toISOString(), position.source, position.id];

  return Buffer.from(parts.join(SEPARATOR), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): HistoryPosition {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [occurredAt, source, ...rest] = decoded.split(SEPARATOR);
  const id = rest.join(SEPARATOR);
  const at = occurredAt ? new Date(occurredAt) : new Date(Number.NaN);

  if (!source || !isSource(source) || !id || Number.isNaN(at.getTime())) {
    throw new ValidationError('This history cursor cannot be read', { cursor });
  }

  return { occurredAt: at, source, id };
}

export function comparePositions(a: HistoryPosition, b: HistoryPosition): number {
  const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();

  if (byTime !== 0) return byTime;

  const bySource = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];

  if (bySource !== 0) return bySource;

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
