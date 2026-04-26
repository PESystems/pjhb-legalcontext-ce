/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — F3 unit tests for PKCE on OAuth flow.
 * Pass 6a W4 / RFC 7636.
 *
 * Covers:
 *   1. generateCodeVerifier() output shape (length 43, base64url charset).
 *   2. generateCodeVerifier() randomness sanity (1000 calls, all distinct).
 *   3. computeCodeChallenge() against RFC 7636 §B test vector.
 *   4. computeCodeChallenge() determinism for same input.
 *   5. generateAuthorizationUrl() includes code_challenge + S256.
 *   6. generateAuthorizationUrl() refuses missing codeChallenge.
 *
 * Runnable via:  bun run src/tests/test-oauth-pkce.ts
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'pjhb-oauth-pkce-test-'));
process.env.HOME = TMP_DIR;
process.env.USERPROFILE = TMP_DIR;
process.env.SECRET_KEY = 'pjhb-test-secret-key-v1-must-be-32-chars-min-aaaaaaaa';
process.env.CLIO_CLIENT_ID = 'test-client-id';
process.env.CLIO_CLIENT_SECRET = 'test-client-secret';
process.env.CLIO_REDIRECT_URI = 'http://127.0.0.1:3001/clio/auth/callback';
process.env.CLIO_API_REGION = 'us';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

async function main() {
  console.log('=== PJHB Pass 6a W4 — F3 PKCE OAuth tests ===');

  const { generateCodeVerifier, computeCodeChallenge, generateAuthorizationUrl } =
    await import('../clio/oauthClient');

  // ---- Test 1: code_verifier output shape ----
  console.log('\nTest 1 — generateCodeVerifier() output shape');
  const v1 = generateCodeVerifier();
  check('verifier is string', typeof v1 === 'string');
  check('verifier length within RFC 7636 range (43-128)',
    v1.length >= 43 && v1.length <= 128, `length=${v1.length}`);
  check('verifier is base64url (only A-Z a-z 0-9 - _)',
    /^[A-Za-z0-9_-]+$/.test(v1), `verifier=${v1}`);

  // ---- Test 2: randomness sanity ----
  console.log('\nTest 2 — randomness sanity (1000 distinct verifiers)');
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(generateCodeVerifier());
  check('1000 calls produce 1000 distinct verifiers', seen.size === 1000,
    `distinct=${seen.size}`);

  // ---- Test 3: RFC 7636 §B test vector ----
  // From RFC 7636 Appendix B:
  //   code_verifier:  dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
  //   code_challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  console.log('\nTest 3 — computeCodeChallenge() against RFC 7636 §B test vector');
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const computedChallenge = computeCodeChallenge(rfcVerifier);
  check('computeCodeChallenge produces RFC 7636 expected output',
    computedChallenge === expectedChallenge,
    `expected=${expectedChallenge} got=${computedChallenge}`);

  // ---- Test 4: determinism ----
  console.log('\nTest 4 — computeCodeChallenge() is deterministic');
  const v2 = generateCodeVerifier();
  const c2a = computeCodeChallenge(v2);
  const c2b = computeCodeChallenge(v2);
  check('same input produces same output', c2a === c2b);

  // ---- Test 5: generateAuthorizationUrl includes PKCE params ----
  console.log('\nTest 5 — generateAuthorizationUrl includes code_challenge + S256');
  const verifier = generateCodeVerifier();
  const challenge = computeCodeChallenge(verifier);
  const authUrl = generateAuthorizationUrl('test-state-xyz', challenge);
  const parsed = new URL(authUrl);
  check('URL has response_type=code', parsed.searchParams.get('response_type') === 'code');
  check('URL has state', parsed.searchParams.get('state') === 'test-state-xyz');
  check('URL has code_challenge', parsed.searchParams.get('code_challenge') === challenge);
  check('URL has code_challenge_method=S256',
    parsed.searchParams.get('code_challenge_method') === 'S256');

  // ---- Test 6: generateAuthorizationUrl refuses missing challenge ----
  console.log('\nTest 6 — generateAuthorizationUrl refuses missing codeChallenge');
  let threw = false;
  try {
    generateAuthorizationUrl('test-state', '');
  } catch (e) {
    threw = e instanceof Error && e.message.includes('PKCE');
  }
  check('refuses empty code_challenge', threw);

  // Cleanup
  rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
