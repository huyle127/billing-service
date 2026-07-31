import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode } from './error-code';

/**
 * The one shape every handled error is returned in, declared for Swagger.
 *
 * It mirrors `ErrorResponseBody` in the global exception filter — the filter
 * builds the response, this documents it — so an endpoint's error responses can
 * name a type rather than describing the shape again per route.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ enum: ErrorCode, enumName: 'ErrorCode' })
  code!: ErrorCode;

  @ApiProperty({ description: 'Human-readable, safe to show a caller.' })
  message!: string;

  @ApiProperty({
    required: false,
    description:
      'Structured context for the code — per-field validation failures, the ' +
      'requested and available credit amounts, and the like.',
  })
  details?: unknown;

  @ApiProperty()
  path!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}
