/**
 * PJHB Pass 7 — wrapper: load user-level Clio env vars, then run the
 * Pass 6c token verification unchanged.
 *
 * Run via:  bun run scripts/run-verify-with-user-env.ts
 */

import './load-user-env';

await import('./verify-clio-token');
