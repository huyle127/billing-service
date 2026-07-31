import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { STRIPE_WEBHOOK_PATH } from './common/constants';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Nest's own body parsing is disabled so that the webhook route can be given a
 * raw `Buffer` body before anything parses it. Every instance of the app —
 * including the ones tests create — must be constructed with these options for
 * {@link configureApp} to behave the same way.
 */
export const APP_OPTIONS = { bodyParser: false } as const;

/**
 * Comma-separated origins permitted to make cross-origin requests.
 *
 * Absent means *no* origin is permitted, not every origin. An API that browsers
 * are not expected to call directly is the normal case here, and a wildcard
 * default would hand that decision to whoever forgets to set the variable.
 */
export const CORS_ORIGINS = 'CORS_ORIGINS';

/**
 * Applies the cross-cutting HTTP configuration: security headers, the
 * cross-origin policy, raw body on the webhook route only, validation
 * everywhere, and the standard error shape.
 *
 * The rate limit is *not* here — it is a guard bound by `ThrottlingModule`, so
 * it applies to anything that builds `AppModule` whether or not this ran.
 */
export function configureApp(app: NestExpressApplication): void {
  // Applied to every route, ahead of everything else, so that a response
  // carries the headers even when it is produced by a middleware failure rather
  // than by a controller. No route opts out.
  app.use(helmet());

  app.enableCors({
    origin: corsOrigins(app.get(ConfigService)),
    credentials: true,
  });

  // `express.raw` marks the body as parsed, so the JSON parser registered after
  // it skips the webhook route and leaves the exact received bytes in place.
  app.use(STRIPE_WEBHOOK_PATH, express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}

/**
 * The allowlist, as `cors` wants it. An empty array permits nothing: no
 * `Access-Control-Allow-Origin` header is sent, so a browser refuses the
 * response for every origin.
 */
function corsOrigins(config: ConfigService): string[] {
  return (config.get<string>(CORS_ORIGINS) ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
