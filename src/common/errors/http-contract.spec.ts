import { Body, Controller, Get, INestApplication, Module, Post, RawBody, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt } from 'class-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainExceptionFilter } from './domain-exception.filter';
import { NotFoundError } from './domain.exception';

class ConsumeDto {
  @IsInt()
  amount!: number;
}

@Controller()
class ProbeController {
  @Get('missing')
  missing(): never {
    throw new NotFoundError("No active plan with code 'pro_weekly'", { code: 'pro_weekly' });
  }

  @Get('unhandled')
  unhandled(): never {
    throw new Error('connection string postgres://user:hunter2@host/db');
  }

  @Post('consume')
  consume(@Body() body: ConsumeDto): ConsumeDto {
    return body;
  }

  @Post('webhooks/stripe')
  webhook(@RawBody() raw: Buffer | undefined): { raw: string | null } {
    return { raw: raw ? raw.toString('utf8') : null };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('the HTTP contract', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a domain exception as the envelope with the fault kind as its status', async () => {
    const response = await fetch(`${baseUrl}/v1/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: "No active plan with code 'pro_weekly'",
        details: { code: 'pro_weekly' },
      },
    });
  });

  it('reports a malformed body as a client fault in the same envelope', async () => {
    const response = await fetch(`${baseUrl}/v1/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 'ten' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.violations).toBeInstanceOf(Array);
  });

  it('never leaks the detail of an unhandled fault to the caller', async () => {
    const response = await fetch(`${baseUrl}/v1/unhandled`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('gives the webhook handler the exact bytes that were sent', async () => {
    const payload = '{"id":"evt_1","type":"invoice.paid"}';
    const response = await fetch(`${baseUrl}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect((await response.json()).raw).toBe(payload);
  });

  it('does not resolve a route without the version prefix', async () => {
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
  });
});
