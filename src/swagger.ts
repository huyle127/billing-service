import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Where the interactive documentation is served. */
export const SWAGGER_PATH = 'api/docs';

/**
 * The OpenAPI document, built from the decorators on the controllers and DTOs.
 *
 * Exposed separately from {@link configureSwagger} so a test can assert what the
 * document contains without starting a server — "every implemented endpoint is
 * documented" is then a checkable property rather than something to eyeball in
 * the browser (`api-endpoints` → "Swagger Documentation").
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Billing Service')
    .setDescription(
      'Subscriptions, credits, payment methods, and billing history for the ' +
        'AI product. Every endpoint except registration, login, the health ' +
        'check, and the provider webhook requires a bearer token.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function configureSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, buildOpenApiDocument(app));
}
