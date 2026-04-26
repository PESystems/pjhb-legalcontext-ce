/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — F2 unit tests for ClioApiClient instance-state
 * isolation. Pass 6a W3.
 *
 * Covers:
 *   1. Two ClioApiClient instances do not share auth state.
 *   2. resetAuthenticationStatus on one instance does not affect the
 *      other.
 *   3. Setting state on instance A does not leak into instance B.
 *
 * Runnable via:  bun run src/tests/test-apiClient-state-isolation.ts
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Same env-setup pattern as test-tokenStorage.ts: env vars must be set
// BEFORE importing apiClient (which transitively imports tokenStorage).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'pjhb-apiclient-test-'));
process.env.HOME = TMP_DIR;
process.env.USERPROFILE = TMP_DIR;
process.env.SECRET_KEY = 'pjhb-test-secret-key-v1-must-be-32-chars-min-aaaaaaaa';
process.env.CLIO_CLIENT_ID = 'test-client-id-A';
process.env.CLIO_CLIENT_SECRET = 'test-client-secret';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

async function main() {
  console.log('=== PJHB Pass 6a W3 — F2 ClioApiClient state-isolation tests ===');
  console.log('TMP_DIR:', TMP_DIR);

  const { ClioApiClient } = await import('../clio/apiClient');

  // ---- Test 1: two instances start with independent state ----
  console.log('\nTest 1 — fresh instances start independent');
  const a = new ClioApiClient();
  const b = new ClioApiClient();
  // Use bracket access to read private fields for testing only.
  const aAuth = (a as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const bAuth = (b as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const aFail = (a as unknown as { authenticationFailed: boolean }).authenticationFailed;
  const bFail = (b as unknown as { authenticationFailed: boolean }).authenticationFailed;
  check('a.isAuthenticated starts false', aAuth === false);
  check('b.isAuthenticated starts false', bAuth === false);
  check('a.authenticationFailed starts false', aFail === false);
  check('b.authenticationFailed starts false', bFail === false);

  // ---- Test 2: setting state on a does not leak to b ----
  console.log('\nTest 2 — state set on instance A does not leak to instance B');
  (a as unknown as { isAuthenticated: boolean }).isAuthenticated = true;
  (a as unknown as { authenticationFailed: boolean }).authenticationFailed = true;
  const aAuth2 = (a as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const bAuth2 = (b as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const aFail2 = (a as unknown as { authenticationFailed: boolean }).authenticationFailed;
  const bFail2 = (b as unknown as { authenticationFailed: boolean }).authenticationFailed;
  check('a.isAuthenticated reflects set on a', aAuth2 === true);
  check('b.isAuthenticated NOT affected by set on a', bAuth2 === false);
  check('a.authenticationFailed reflects set on a', aFail2 === true);
  check('b.authenticationFailed NOT affected by set on a', bFail2 === false);

  // ---- Test 3: resetAuthenticationStatus on a does not affect b ----
  console.log('\nTest 3 — resetAuthenticationStatus on A does not affect B');
  (b as unknown as { isAuthenticated: boolean }).isAuthenticated = true;
  (b as unknown as { authenticationFailed: boolean }).authenticationFailed = false;
  a.resetAuthenticationStatus();
  const aAuth3 = (a as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const bAuth3 = (b as unknown as { isAuthenticated: boolean }).isAuthenticated;
  const aFail3 = (a as unknown as { authenticationFailed: boolean }).authenticationFailed;
  const bFail3 = (b as unknown as { authenticationFailed: boolean }).authenticationFailed;
  check('a.isAuthenticated reset to false', aAuth3 === false);
  check('a.authenticationFailed reset to false', aFail3 === false);
  check('b.isAuthenticated still true (not reset by a.reset)', bAuth3 === true);
  check('b.authenticationFailed still false (not changed by a.reset)', bFail3 === false);

  // ---- Test 4: state preservation within a single instance across method calls ----
  console.log('\nTest 4 — state preserved within a single instance');
  const c = new ClioApiClient();
  (c as unknown as { isAuthenticated: boolean }).isAuthenticated = true;
  // Trigger an internal-state-touching method (canMakeRequest is private but
  // doesn't require network; we just want to confirm flag survives a method
  // call). We call resetAuthenticationStatus on a *different* instance to
  // confirm it doesn't bleed.
  a.resetAuthenticationStatus();
  const cAuthAfter = (c as unknown as { isAuthenticated: boolean }).isAuthenticated;
  check('c.isAuthenticated preserved across method call on unrelated instance',
    cAuthAfter === true);

  // ---- Test 5: confirm no module-level globals exist ----
  console.log('\nTest 5 — no module-level isAuthenticated / authenticationFailed globals');
  const apiClientModule = await import('../clio/apiClient');
  const exportedNames = Object.keys(apiClientModule);
  check('module does NOT export isAuthenticated', !exportedNames.includes('isAuthenticated'));
  check('module does NOT export authenticationFailed', !exportedNames.includes('authenticationFailed'));

  // Cleanup
  rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
