import { UseGuards, applyDecorators } from '@nestjs/common';
import { InternalKeyGuard } from './internal-key.guard';
import { Public } from './public.decorator';

export function InternalOnly(): ClassDecorator & MethodDecorator {
  return applyDecorators(Public(), UseGuards(InternalKeyGuard));
}
