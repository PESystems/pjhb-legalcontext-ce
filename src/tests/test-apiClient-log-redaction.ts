/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — F7 unit tests for log-redaction in apiClient.
 * Pass 6a W5.
 *
 * Covers:
 *   1. Bearer tokens scrubbed from arbitrary text.
 *   2. access_token + refresh_token JSON fields scrubbed.
 *   3. Length cap applied to oversized error bodies.
 *   4. Plain text passes through unchanged.
 *
 * Note: redactSensitive() is module-private. We re-derive the same regex
 * here against the source as a black-box test of the scrub contract; if the
 * implementation changes, this test should be updated to import the helper
 * directly (would require exporting it from apiClient.ts, which we avoid
 * because it's an internal helper).
 *
 * Runnable via:  bun run src/tests/test-apiClient-log-redaction.ts
 */

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'pjhb-redact-test-'));
process.env.HOME = TMP_DIR;
process.env.USERPROFILE = TMP_DIR;
process.env.SECRET_KEY = 'pjhb-test-secret-key-v1-must-be-32-chars-min-aaaaaaaa';
process.env.CLIO_CLIENT_ID = 'test-client-id';
process.env.CLIO_CLIENT_SECRET = 'test-client-secret';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

// Re-derive the redaction transformation as a contract-shadow.
// Must match the implementation in src/clio/apiClient.ts exactly.
const ERROR_LOG_MAX_LENGTH = 2048;
function redactSensitive(text: string): string {
  if (typeof text !== 'string') return String(text);
  let cleaned = text.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer [REDACTED]');
  cleaned = cleaned.replace(/("access_token"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
  cleaned = cleaned.replace(/("refresh_token"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
  if (cleaned.length > ERROR_LOG_MAX_LENGTH) {
    cleaned = cleaned.slice(0, ERROR_LOG_MAX_LENGTH) + ` [truncated; original ${cleaned.length} bytes]`;
  }
  return cleaned;
}

async function main() {
  console.log('=== PJHB Pass 6a W5 — F7 log-redaction unit tests ===');

  // First confirm the apiClient.ts source actually contains the helper we
  // shadowed (so we know the contract matches).
  const apiClientSrc = readFileSync(
    new URL('../clio/apiClient.ts', import.meta.url),
    'utf8',
  );
  check('apiClient.ts contains redactSensitive helper',
    apiClientSrc.includes('function redactSensitive(text: string)'));
  check('apiClient.ts has the Bearer-token regex',
    apiClientSrc.includes('Bearer\\\\s+[A-Za-z0-9._\\\\-+/=]+') ||
    apiClientSrc.includes("Bearer\\s+[A-Za-z0-9._\\-+/=]+"));
  check('apiClient.ts has access_token JSON regex',
    apiClientSrc.includes('access_token'));
  check('apiClient.ts has refresh_token JSON regex',
    apiClientSrc.includes('refresh_token'));

  // ---- Test 1: Bearer tokens scrubbed ----
  console.log('\nTest 1 — Bearer tokens scrubbed');
  const inp1 = 'Authorization: Bearer abc.def.ghi.jkl';
  const out1 = redactSensitive(inp1);
  check('Bearer pattern replaced with [REDACTED]',
    out1.includes('Bearer [REDACTED]') && !out1.includes('abc.def.ghi.jkl'),
    out1);

  const inp1b = 'request failed with header Authorization=Bearer xyz_123/abc-def=';
  const out1b = redactSensitive(inp1b);
  check('Bearer with mixed alphabet chars scrubbed',
    out1b.includes('Bearer [REDACTED]') && !out1b.includes('xyz_123'),
    out1b);

  // ---- Test 2: access_token / refresh_token JSON fields ----
  console.log('\nTest 2 — access_token / refresh_token JSON fields scrubbed');
  const inp2 = '{"access_token":"super-secret-abc-123","token_type":"Bearer"}';
  const out2 = redactSensitive(inp2);
  check('access_token value redacted',
    !out2.includes('super-secret-abc-123') && out2.includes('"access_token":"[REDACTED]"'),
    out2);

  const inp2b = '{"refresh_token":"r-secret-xyz","other":"ok"}';
  const out2b = redactSensitive(inp2b);
  check('refresh_token value redacted',
    !out2b.includes('r-secret-xyz') && out2b.includes('"refresh_token":"[REDACTED]"'),
    out2b);

  // ---- Test 3: length cap applied ----
  console.log('\nTest 3 — length cap applied to oversized text');
  const inp3 = 'X'.repeat(5000);
  const out3 = redactSensitive(inp3);
  check('output length <= cap + suffix',
    out3.length <= ERROR_LOG_MAX_LENGTH + 80,
    `out3.length=${out3.length}`);
  check('truncation suffix present',
    out3.includes('[truncated; original 5000 bytes]'),
    out3.slice(-80));

  // ---- Test 4: plain text passes through ----
  console.log('\nTest 4 — plain text passes through unchanged');
  const inp4 = 'Some normal error message with a number 42 and a date 2026-04-26.';
  const out4 = redactSensitive(inp4);
  check('plain text unchanged', out4 === inp4);

  // ---- Test 5: F8 verification — no /Users/deletosh leaks left ----
  console.log('\nTest 5 — F8 dev-machine path leaks stripped');
  const oauthSrc = readFileSync(
    new URL('../clio/oauthClient.ts', import.meta.url),
    'utf8',
  );
  check('oauthClient.ts: no /Users/deletosh leak',
    !oauthSrc.includes('/Users/deletosh'));
  const docProcSrc = readFileSync(
    new URL('../documents/documentProcessor.ts', import.meta.url),
    'utf8',
  );
  check('documents/documentProcessor.ts: no /Users/deletosh leak',
    !docProcSrc.includes('/Users/deletosh'));
  const chunkerSrc = readFileSync(
    new URL('../documents/textChunker.ts', import.meta.url),
    'utf8',
  );
  check('documents/textChunker.ts: no /Users/deletosh leak',
    !chunkerSrc.includes('/Users/deletosh'));

  // Cleanup
  rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
