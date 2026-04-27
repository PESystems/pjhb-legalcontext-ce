/**
 * PJHB Pass 6c W2 — Narrow OAuth-only runner.
 *
 * Boots ONLY the existing OAuth HTTP server (src/clio/httpServer.ts), prints
 * the authorize URL, and exits cleanly once tokens land on disk.
 *
 * Why a separate runner (not `bun run src/server.ts`):
 *   The full server.ts boots the MCP transport + LanceDB + document indexer +
 *   tools + resources. Pass 6c only needs the OAuth handshake; everything
 *   else is Pass 7 territory and adds startup latency + failure surface
 *   we don't want during a one-shot credential-capture flow.
 *
 * Port is hardcoded to 3789 to match the Clio Developer Portal app's
 * registered redirect URI (http://127.0.0.1:3789/clio/auth/callback).
 *
 * Run via:
 *   bun run scripts/run-oauth-flow.ts
 *
 * Then:
 *   1. Open the printed URL in the same browser where you're logged into Clio Manage.
 *   2. Click "Allow" on the consent screen.
 *   3. Wait for the script to print "TOKENS CAPTURED" and exit cleanly.
 */

import { config } from '../src/config';
import { startOAuthServer } from '../src/clio/httpServer';
import { secureTokenStorage } from '../src/clio/tokenStorage';
import { logger } from '../src/logger';

// PORT FIX: ESM imports get hoisted, so any attempt to set process.env.PORT
// at the top of this file would run AFTER config.ts already loaded. The
// existing httpServer reads config.port AT CALL TIME (inside startOAuthServer),
// not at import time, so mutating config.port here BEFORE starting the server
// is the correct seam. 3789 matches the redirect URI registered with Clio.
config.port = 3789;

async function main() {
  console.log('=' .repeat(72));
  console.log('PJHB Pass 6c W2 — OAuth handshake runner');
  console.log('=' .repeat(72));
  console.log();

  // Pre-flight: do we already have tokens? If yes, warn and abort.
  if (await secureTokenStorage.tokensExist()) {
    console.log('[STOP] Tokens already exist on disk.');
    console.log();
    console.log('If you want to re-authenticate (e.g., scopes changed), first run:');
    console.log('    bun run -e "import(\'./src/clio/authStatus\').then(m => m.forceReauthentication())"');
    console.log('Then re-run this script.');
    console.log();
    console.log('Otherwise, your existing tokens are fine — proceed to W3 verification.');
    process.exit(0);
  }

  // Start the OAuth server (binds to port 3789 because we set process.env.PORT
  // above before httpServer.ts imported config).
  const server = startOAuthServer();
  const port = (server as any).port ?? 3789;

  console.log(`OAuth server listening on http://127.0.0.1:${port}`);
  console.log();
  console.log('NEXT STEP — open this URL in your browser:');
  console.log();
  console.log(`    http://127.0.0.1:${port}/clio/auth`);
  console.log();
  console.log('That URL redirects you to Clio\'s consent page. Click "Allow".');
  console.log('When the browser shows "Successfully authenticated with Clio",');
  console.log('this script will detect the saved tokens and exit cleanly.');
  console.log();
  console.log('=' .repeat(72));
  console.log();

  // Poll for tokens-on-disk every 2s; exit cleanly once they appear.
  // Timeout after 5 minutes so the server doesn't hang forever.
  const TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_INTERVAL_MS = 2000;
  const startTime = Date.now();

  const pollTimer = setInterval(async () => {
    try {
      if (await secureTokenStorage.tokensExist()) {
        clearInterval(pollTimer);
        console.log();
        console.log('[OK] TOKENS CAPTURED — encrypted at rest in ~/.legalcontext/clio_tokens');
        console.log('[OK] OAuth server shutting down. Pass 6c W2 complete.');
        console.log();
        console.log('Next: run W3 verification (who_am_i call) — see Claude Code.');
        server.stop();
        process.exit(0);
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(pollTimer);
        console.error();
        console.error('[TIMEOUT] No tokens captured after 5 minutes. Aborting.');
        console.error('Check the browser tab — did you click "Allow"?');
        console.error('If you saw an error, copy the URL bar contents (no secrets in it)');
        console.error('and tell Claude Code so we can debug.');
        server.stop();
        process.exit(1);
      }
    } catch (err) {
      logger.error('Error polling for tokens:', err);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
