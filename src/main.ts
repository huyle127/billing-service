import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './app.setup';
import { configureSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    APP_OPTIONS,
  );
  configureApp(app);
  // Served at /api/docs. Left out of `configureApp` so the tests that build the
  // app get the HTTP contract without paying to generate the document.
  configureSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
