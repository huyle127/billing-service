import { Clock } from './clock';

export class FixedClock extends Clock {
  private current: Date;

  constructor(current: Date) {
    super();
    this.current = new Date(current.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(current: Date): void {
    this.current = new Date(current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
