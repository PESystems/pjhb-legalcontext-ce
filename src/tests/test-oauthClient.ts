/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — oauthClient unit tests (Pass 7).
 *
 * Covers the refresh-token merge fix: Clio does not reissue refresh_token on
 * refresh (RFC 6749 §6). refreshAccessToken() must return a complete
 * ClioTokens with the original refresh_token merged in when the response
 * omits it, and must prefer a server-issued refresh_token when one IS
 * present (rotation-compatible).
 *
 * Runnable via:  bun run src/tests/test-oauthClient.ts
 */

// Dummy Clio config so validateClioConfig() passes without real secrets.
// Must be set before oauthClient/config are imported (dynamic import below).
process.env.CLIO_CLIENT_ID = process.env.CLIO_CLIENT_ID || 'test_client_id';
process.env.CLIO_CLIENT_SECRET = 'test_client_secret';
process.env.CLIO_REDIRECT_URI = 'http://127.0.0.1:3789/clio/auth/callback';
process.env.CLIO_API_REGION = 'us';

const { refreshAccessToken, isTokenExpired } = await import('../clio/oauthClient');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

const realFetch = globalThis.fetch;
function mockTokenResponse(payload: Record<string, unknown>): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

console.log('Test 1 — refresh response WITHOUT refresh_token (Clio production behavior)');
mockTokenResponse({
  access_token: 'new_access_token_aaaaaaaaaaaaaaaaaaaaaaaa',
  token_type: 'bearer',
  expires_in: 2592000,
});
{
  const result = await refreshAccessToken('original_refresh_token_bbbbbbbbbbbb');
  check(
    'original refresh_token merged into result',
    result.refresh_token === 'original_refresh_token_bbbbbbbbbbbb',
    `got: ${result.refresh_token}`,
  );
  check('new access_token preserved', result.access_token === 'new_access_token_aaaaaaaaaaaaaaaaaaaaaaaa');
  check('created_at stamped', typeof result.created_at === 'number' && result.created_at > 0);
  check('result is not expired immediately after refresh', !isTokenExpired(result));
}

console.log('Test 2 — refresh response WITH rotated refresh_token (RFC 6749 §6 MAY-issue path)');
mockTokenResponse({
  access_token: 'new_access_token_cccccccccccccccccccccccc',
  refresh_token: 'rotated_refresh_token_dddddddddddd',
  token_type: 'bearer',
  expires_in: 2592000,
});
{
  const result = await refreshAccessToken('original_refresh_token_bbbbbbbbbbbb');
  check(
    'server-issued refresh_token wins over original',
    result.refresh_token === 'rotated_refresh_token_dddddddddddd',
    `got: ${result.refresh_token}`,
  );
}

console.log('Test 3 — refresh response preserves server-supplied created_at');
mockTokenResponse({
  access_token: 'new_access_token_eeeeeeeeeeeeeeeeeeeeeeee',
  token_type: 'bearer',
  expires_in: 2592000,
  created_at: 1750000000,
});
{
  const result = await refreshAccessToken('original_refresh_token_bbbbbbbbbbbb');
  check('server created_at preserved (not overwritten)', result.created_at === 1750000000);
}

console.log('Test 4 — HTTP error surfaces as thrown error (no partial token object)');
globalThis.fetch = (async () =>
  new Response('{"error":"invalid_grant"}', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
{
  let threw = false;
  try {
    await refreshAccessToken('revoked_refresh_token');
  } catch {
    threw = true;
  }
  check('401 refresh throws instead of returning tokens', threw);
}

globalThis.fetch = realFetch;

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
