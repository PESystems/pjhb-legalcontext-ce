/**
 * PJHB Pass 6c W3 — Clio token verification.
 *
 * Two checks, both read-only and minimal:
 *
 *   (1) GET /api/v4/users/who_am_i with the stored access token.
 *       Returns ONLY the authenticated user's own user record. No client
 *       data, no matters, no contacts, no fields beyond the operator's
 *       own identity. Confirms the token is valid + scoped correctly.
 *
 *   (2) Force a refresh-on-expiry path: load tokens, call
 *       refreshAccessToken() with the stored refresh_token, save the
 *       new tokens. Confirms the refresh path works so the connection
 *       survives access-token expiry without operator intervention.
 *
 * NO other Clio endpoints are called. Pass 6c is read-only AND
 * narrowly scoped to identity verification + refresh confirmation.
 * Matter / contact / custom_field reads belong to Pass 7.
 *
 * Run via:
 *   cmd /c bun run scripts/verify-clio-token.ts
 */

import { config } from '../src/config';
import { secureTokenStorage } from '../src/clio/tokenStorage';
import { refreshAccessToken, getClioBaseUrl, isTokenExpired } from '../src/clio/oauthClient';

interface WhoAmIResponse {
  data: {
    id: number | string;
    name?: string;
    email?: string;
    type?: string;
    [k: string]: unknown;
  };
}

async function callWhoAmI(accessToken: string): Promise<{ ok: boolean; status: number; body: WhoAmIResponse | string }> {
  const url = `${getClioBaseUrl()}/api/v4/users/who_am_i`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, body: text };
  }
  const json = (await res.json()) as WhoAmIResponse;
  return { ok: true, status: res.status, body: json };
}

function redactEmail(email: string | undefined): string {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '<no-email>';
  const [local, domain] = email.split('@', 2);
  if (local.length <= 2) return `${local[0] ?? ''}*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

async function main() {
  console.log('=' .repeat(72));
  console.log('PJHB Pass 6c W3 — Clio token verification');
  console.log('=' .repeat(72));
  console.log();

  // ---- Step 1: load stored tokens ----
  console.log('[1/4] Loading stored tokens from encrypted storage...');
  const tokens = await secureTokenStorage.loadTokens();
  if (!tokens) {
    console.error('  [FAIL] No tokens found. Run scripts/run-oauth-flow.ts first.');
    process.exit(1);
  }
  console.log('  [OK] tokens loaded');
  console.log(`       access_token:  ${tokens.access_token.length} chars (redacted)`);
  console.log(`       refresh_token: ${tokens.refresh_token.length} chars (redacted)`);
  console.log(`       created_at:    ${tokens.created_at ? new Date(tokens.created_at * 1000).toISOString() : '<missing>'}`);
  console.log(`       expires_in:    ${tokens.expires_in ?? '<missing>'} seconds`);
  console.log(`       expired:       ${isTokenExpired(tokens) ? 'yes (will use refresh)' : 'no'}`);
  console.log();

  // ---- Step 2: who_am_i with current access token ----
  console.log('[2/4] Calling GET /api/v4/users/who_am_i with current access token...');
  let workingAccessToken = tokens.access_token;
  if (isTokenExpired(tokens)) {
    console.log('       (token already expired or near-expiry; refreshing first)');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    await secureTokenStorage.saveTokens(refreshed);
    workingAccessToken = refreshed.access_token;
    console.log('       [OK] refresh-on-pre-call succeeded');
  }
  const r1 = await callWhoAmI(workingAccessToken);
  if (!r1.ok) {
    console.error(`  [FAIL] HTTP ${r1.status}`);
    console.error(`         body: ${JSON.stringify(r1.body).slice(0, 500)}`);
    process.exit(1);
  }
  const data1 = (r1.body as WhoAmIResponse).data;
  console.log(`  [OK] HTTP ${r1.status}`);
  console.log(`       user id:    ${data1.id}`);
  console.log(`       user name:  ${data1.name ?? '<no name field>'}`);
  console.log(`       user email: ${redactEmail(data1.email as string | undefined)}`);
  console.log(`       user type:  ${data1.type ?? '<no type field>'}`);
  console.log();

  // ---- Step 3: explicit refresh-on-demand to confirm refresh path works ----
  // Per RFC 6749 §6, the authorization server MAY issue a new refresh_token on
  // refresh. Clio (with 30-day access tokens) does NOT — it returns the new
  // access_token only and expects the client to keep the original refresh
  // token. We require ONLY access_token in the response and merge with the
  // existing refresh_token so the persisted bundle stays usable.
  console.log('[3/4] Calling refreshAccessToken() to confirm refresh path...');
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  if (!refreshed.access_token) {
    console.error('  [FAIL] refresh did not return an access_token');
    console.error(`         response shape: ${JSON.stringify(refreshed).slice(0, 300)}`);
    process.exit(1);
  }
  // Merge: keep original refresh_token if Clio didn't reissue one.
  const merged = {
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  };
  await secureTokenStorage.saveTokens(merged);
  console.log(`  [OK] refresh succeeded`);
  console.log(`       new access_token length:  ${refreshed.access_token.length}`);
  console.log(`       new refresh_token:        ${refreshed.refresh_token ? `${refreshed.refresh_token.length} chars (rotated)` : '<not reissued; reusing original — RFC 6749 §6 compliant>'}`);
  console.log(`       new created_at:           ${refreshed.created_at ? new Date(refreshed.created_at * 1000).toISOString() : '<missing>'}`);
  console.log(`       new expires_in:           ${refreshed.expires_in} seconds`);
  console.log();

  // ---- Step 4: who_am_i with refreshed access token (proves the new token works) ----
  console.log('[4/4] Re-calling who_am_i with the refreshed access token...');
  const r2 = await callWhoAmI(merged.access_token);
  if (!r2.ok) {
    console.error(`  [FAIL] HTTP ${r2.status}`);
    console.error(`         body: ${JSON.stringify(r2.body).slice(0, 500)}`);
    process.exit(1);
  }
  const data2 = (r2.body as WhoAmIResponse).data;
  if (data2.id !== data1.id) {
    console.error(`  [FAIL] user id mismatch after refresh (${data1.id} vs ${data2.id})`);
    process.exit(1);
  }
  console.log(`  [OK] HTTP ${r2.status} — same user id (${data2.id}) as Step 2`);
  console.log();

  console.log('=' .repeat(72));
  console.log('VERIFICATION PASSED.');
  console.log('  - Stored tokens load + decrypt cleanly');
  console.log('  - who_am_i returns HTTP 200 with valid user record');
  console.log('  - refresh path issues a new access token');
  console.log('  - refreshed token works against who_am_i (round-trip)');
  console.log('=' .repeat(72));
  console.log();
  console.log('Tell Claude Code "verification passed" and Pass 6c finalizes:');
  console.log('  - decision log + setup report + security_privacy §14');
  console.log('  - commit + push integration code to fork');
  console.log('  - 10 verification checks');
  console.log();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
