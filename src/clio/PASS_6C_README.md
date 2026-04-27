# Clio OAuth integration — Pass 6c operator notes

**Pass:** 6c (mini-pass)
**Date:** 2026-04-27
**Status:** Live, persistent, encrypted at rest
**Read-only.** No write paths enabled.

This README covers how the Pass 6c OAuth integration was set up, where the secrets live, how to verify the integration is healthy, and how to revoke or re-establish it.

For the full pass narrative, see `00_admin/decision_logs/2026-04-27_pass6c_oauth_setup.md` in the PJHB workspace and `08_reports/PJHB_workspace_setup_report_v0.6c__20260427__draft.md`.

## What's where

### Code (this fork)

| Path | Role |
| ---- | ---- |
| `src/clio/oauthClient.ts` | OAuth flow primitives (PKCE, authorize, exchange, refresh). Pre-existed. |
| `src/clio/tokenStorage.ts` | AES-256-GCM at-rest encryption, Argon2id KDF from `SECRET_KEY`. Pre-existed. |
| `src/clio/httpServer.ts` | Bun-based callback server. Pre-existed. |
| `src/clio/authStatus.ts` / `apiClient.ts` | Auth-status helpers + authenticated HTTP wrapper. Pre-existed. |
| `scripts/setup-clio-secrets.py` | **NEW** — one-shot dual-storage setup (setx + ACL'd backup file). |
| `scripts/run-oauth-flow.ts` | **NEW** — narrow OAuth runner; boots only the OAuth server (not the full MCP stack); polls for tokens then exits. |
| `scripts/verify-clio-token.ts` | **NEW** — `who_am_i` + refresh-on-demand verification (no other API calls). |

### Secrets (operator hardware — NOT in this repo)

| Where | Contents | Form |
| ----- | -------- | ---- |
| Windows user env vars (set by `setx`) | `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, `SECRET_KEY`, `CLIO_REDIRECT_URI`, `CLIO_API_REGION` | Plaintext in registry under `HKCU\Environment` |
| `C:\Users\<user>\.pjhb-secrets\clio_oauth_backup.txt` | The 3 secret env vars | Plaintext file, ACL stripped to current user only via `icacls` |
| `C:\Users\<user>\.legalcontext\clio_tokens` | `access_token` (30-day) + `refresh_token` (long-lived) | AES-256-GCM-encrypted envelope, key derived from `SECRET_KEY` via Argon2id |

`SECRET_KEY` is irrecoverable if lost. The encrypted token envelope is unrecoverable without `SECRET_KEY`. **The backup file is the recovery copy** — don't delete it unless you have another copy of the same values.

## Health check (run anytime)

```powershell
cd <fork-dir>
cmd /c bun run scripts/verify-clio-token.ts
```

Verifies in ~2 seconds:
1. Tokens load + decrypt cleanly from disk.
2. `GET /api/v4/users/who_am_i` returns HTTP 200 with the bound user's identity.
3. `refreshAccessToken()` returns a new access token.
4. The refreshed token works against `who_am_i` (round-trip).

If any step fails, the script exits non-zero with a labelled error.

## Token identity

The OAuth token is bound to **Fuad Aboulela's Clio Manage user** (per Pass 6c context — Malik operates under Fuad-granted admin credentials, signed in as Fuad's user when the consent screen ran).

**Implications:**
- If Fuad changes his Clio password, the existing tokens KEEP working (OAuth tokens survive password rotation). To force re-auth, the app must be explicitly revoked at the Developer Portal (see Revocation below).
- If Fuad's user is deactivated, the API rejects calls from these tokens — re-establish under a different user via re-auth.
- Pass 7 may switch to a dedicated service-account identity to decouple the integration from a specific co-owner's account.

## Scopes granted (read-only ONLY)

The Pass 6c app has **read** permission on these Clio resources:

| Scope | Coverage |
| ----- | -------- |
| Contacts | Clients, companies, co-counsel, contact notes |
| Custom fields | The custom fields registered against contacts and matters |
| Matters | Matters + matter notes + practice areas |
| Tasks | Tasks, task lists, task types, due dates, reminders |
| Users | User identity (the `who_am_i` endpoint and others) |

**No write scope.** The token cannot create, update, or delete any record.

To add or remove scopes: edit the app at `https://developers.clio.com/apps`, then re-run the OAuth flow (the user re-consents with the new scope set). After re-consent, re-run `verify-clio-token.ts` to confirm.

## Re-running the OAuth flow

If the token gets revoked, lost, or the scope set changes:

```powershell
cd <fork-dir>
# Option A: clear existing tokens then re-auth
# (verify-clio-token will show "[FAIL] No tokens found" if you delete first)
cmd /c bun run scripts/run-oauth-flow.ts
```

If `run-oauth-flow.ts` reports `[STOP] Tokens already exist`, force a clean re-auth by first deleting `~/.legalcontext/clio_tokens` and re-running.

## Restoring secrets after a wipe / new machine

If Windows env vars are blown away (machine reset, profile corruption) but you still have the backup file:

1. Open `C:\Users\<user>\.pjhb-secrets\clio_oauth_backup.txt`.
2. For each line `KEY=value`, run `setx KEY "value"` from PowerShell.
3. Open a NEW PowerShell window so the env vars load.
4. Run `cmd /c bun run scripts/verify-clio-token.ts` — should pass without re-auth (the encrypted token envelope at `~/.legalcontext/clio_tokens` is still valid as long as `SECRET_KEY` matches).

If the backup file is also lost: re-register the app at `developers.clio.com` (new Client ID/Secret), re-run `setup-clio-secrets.py`, re-run `run-oauth-flow.ts`. Effectively starting Pass 6c over.

## Revocation

To cut the integration at any time:

1. Visit `https://developers.clio.com/apps`.
2. Click **"Employment Paralegal Internal Tools"**.
3. Delete (or revoke / disable — button label varies). The access_token and refresh_token are invalidated server-side immediately.
4. Optionally clean up operator hardware:
   ```powershell
   Remove-Item "$env:USERPROFILE\.legalcontext\clio_tokens"
   Remove-Item "$env:USERPROFILE\.pjhb-secrets\clio_oauth_backup.txt"
   # (env vars persist; remove via setx with empty string OR `[Environment]::SetEnvironmentVariable(...)`)
   ```

## SECRET_KEY rotation

If `SECRET_KEY` is suspected compromised but `CLIO_CLIENT_*` are not:

1. Generate a new SECRET_KEY: `python -c "import secrets; print(secrets.token_urlsafe(36))"`
2. `setx SECRET_KEY "<new-value>"`
3. Update the backup file (`C:\Users\<user>\.pjhb-secrets\clio_oauth_backup.txt`).
4. Delete the old encrypted token envelope: `Remove-Item "$env:USERPROFILE\.legalcontext\clio_tokens"` (it was encrypted with the OLD key; the new key can't decrypt it).
5. Re-run the OAuth flow: `cmd /c bun run scripts/run-oauth-flow.ts`. New tokens land encrypted with the new key.

If `CLIO_CLIENT_SECRET` is suspected compromised: regenerate it at `developers.clio.com`, then re-run `setup-clio-secrets.py` (which will overwrite all 5 env vars + backup). Then `run-oauth-flow.ts`.

## Known follow-ups for Pass 7

1. **Latent bug in `oauthClient.ts:refreshAccessToken()`** — Clio doesn't reissue `refresh_token` on refresh (RFC 6749 §6 compliant); the current code casts the response to `ClioTokens` without merging the existing `refresh_token`. If a caller persists the result without merging, next refresh breaks. Worked around in `verify-clio-token.ts`. Fix at the source.
2. **Schema re-pull** before any matter-data calls — Pass 6b W0 snapshot is from 2026-04-26.
3. **fieldMapping per-type transformers** — currently identity placeholders.
4. **Service-account identity** — consider switching the OAuth integration off Fuad's user.
