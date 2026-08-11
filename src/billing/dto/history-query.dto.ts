import { Transform, Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { HISTORY_PAGE, HISTORY_SOURCES, HistorySource } from '../billing.constants';

export class HistoryQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsIn(HISTORY_SOURCES, { each: true })
  type?: HistorySource[];

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HISTORY_PAGE.maxLimit)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}
