/**
 * Typed wrappers over Jest's asymmetric matchers.
 *
 * `expect.any`, `expect.stringMatching`, and friends are typed `any`, so using
 * them inside a typed object literal trips `no-unsafe-assignment`. These give
 * each matcher the type of the value it stands in for, confining the `any` to
 * one file instead of every assertion that uses one.
 *
 * They change nothing about what is matched — the same matcher object reaches
 * `toMatchObject`, only with a type attached on the way.
 */

/* eslint-disable @typescript-eslint/no-unsafe-return */

export const anyString = (): string => expect.any(String);

export const stringMatching = (pattern: RegExp): string =>
  expect.stringMatching(pattern);

export const stringContaining = (value: string): string =>
  expect.stringContaining(value);

export const arrayContaining = <T>(values: T[]): T[] =>
  expect.arrayContaining(values);
