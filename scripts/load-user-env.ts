/**
 * PJHB Pass 7 — load Clio user-level env vars into process.env.
 *
 * The Pass 6c secret storage uses `setx` (Windows user env vars). A process
 * whose parent predates the setx call — or whose parent scrubbed its
 * environment — won't see them. This helper reads HKCU\Environment directly
 * and populates process.env for any of the five Clio vars that are missing.
 *
 * Secret values stay in-process: nothing is printed, logged, or passed
 * through a shell command line.
 *
 * Import for side effect BEFORE importing src/config:
 *   import './load-user-env';
 */

import { spawnSync } from 'child_process';

const CLIO_ENV_VARS = [
  'CLIO_CLIENT_ID',
  'CLIO_CLIENT_SECRET',
  'SECRET_KEY',
  'CLIO_REDIRECT_URI',
  'CLIO_API_REGION',
] as const;

function readUserEnvVar(name: string): string | undefined {
  const res = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) return undefined;
  // Output line shape: "    NAME    REG_SZ    value"
  const m = res.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
  return m ? m[1].trim() : undefined;
}

let loaded = 0;
for (const name of CLIO_ENV_VARS) {
  if (!process.env[name]) {
    const v = readUserEnvVar(name);
    if (v) {
      process.env[name] = v;
      loaded++;
    }
  }
}

const missing = CLIO_ENV_VARS.filter((n) => !process.env[n]);
console.error(
  `[load-user-env] ${loaded} var(s) loaded from HKCU\\Environment; ` +
    (missing.length ? `MISSING: ${missing.join(', ')}` : 'all 5 present'),
);
