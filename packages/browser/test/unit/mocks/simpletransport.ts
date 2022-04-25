import { createTransport } from '@sentry/core';
import { resolvedSyncPromise } from '@sentry/utils';

export function makeSimpleTransport() {
  return createTransport({}, () => resolvedSyncPromise({ statusCode: 200 }));
}
