/**
 * PJHB Pass 7 — Clio Manage schema re-pull + drift diff vs Pass 6b W0 snapshot.
 *
 * Pulls SCHEMA METADATA ONLY from the Clio Manage API (read-only):
 *   - /api/v4/custom_fields?parent_type=Matter
 *   - /api/v4/custom_fields?parent_type=Contact
 *   - /api/v4/custom_field_sets?parent_type=Matter
 *   - /api/v4/custom_field_sets?parent_type=Contact
 *   - /api/v4/practice_areas
 *
 * NO matter, contact, task, note, or document endpoints are called. No client
 * data is requested or received — these endpoints return firm configuration
 * (field definitions), which is exactly what the Pass 6b W0 snapshot held.
 *
 * The Grow-side snapshot files (lex_customs, matter types/statuses, locations)
 * came from an operator browser session against the Clio Grow API and are NOT
 * reachable with the Manage OAuth token; they retain their 2026-04-26 baseline.
 *
 * Usage:
 *   bun run scripts/pull-clio-schema.ts --out <dir> [--baseline <snapshot-files-dir>]
 *
 * Writes raw API responses as JSON into <out>/files/, a SHA256 manifest, and
 * (when --baseline is given) a drift report at <out>/DRIFT_REPORT.md.
 */

import './load-user-env';

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const { secureTokenStorage } = await import('../src/clio/tokenStorage');
const { refreshAccessToken, getClioBaseUrl, isTokenExpired } = await import('../src/clio/oauthClient');

// ---------------- args ----------------
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const outDir = argValue('--out');
const baselineDir = argValue('--baseline');
if (!outDir) {
  console.error('Usage: bun run scripts/pull-clio-schema.ts --out <dir> [--baseline <dir>]');
  process.exit(1);
}

// ---------------- rate limit ----------------
const REQUEST_SPACING_MS = 400; // ≤ 3 req/sec sustained (Gate G3)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- auth ----------------
async function getAccessToken(): Promise<string> {
  const tokens = await secureTokenStorage.loadTokens();
  if (!tokens) {
    console.error('[FAIL] No stored tokens. Run scripts/run-oauth-flow.ts first.');
    process.exit(1);
  }
  if (isTokenExpired(tokens)) {
    console.log('[auth] access token expired/near-expiry — refreshing');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    await secureTokenStorage.saveTokens(refreshed);
    return refreshed.access_token;
  }
  return tokens.access_token;
}

// ---------------- paginated GET ----------------
interface ApiPage {
  data: unknown[];
  meta?: { paging?: { next?: string }; records?: number };
}

async function getAllPages(accessToken: string, path: string, params: Record<string, string>): Promise<ApiPage> {
  const base = getClioBaseUrl();
  let url: string | undefined = (() => {
    const u = new URL(path, base);
    for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
    return u.toString();
  })();

  const all: unknown[] = [];
  let meta: ApiPage['meta'];
  let pages = 0;
  while (url) {
    pages++;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${url.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const page = (await res.json()) as ApiPage;
    all.push(...(page.data ?? []));
    meta = page.meta;
    url = page.meta?.paging?.next;
    await sleep(REQUEST_SPACING_MS);
  }
  return { data: all, meta: { ...meta, records: all.length, paging: pages > 1 ? { next: undefined } : undefined } };
}

// ---------------- pull spec ----------------
const CF_FIELDS = 'id,name,parent_type,field_type,displayed,deleted,required,display_order,picklist_options{id,option}';
const CFS_FIELDS = 'id,name,parent_type,displayed,custom_fields{id,name}';
const PA_FIELDS = 'id,name,code,category';

const PULLS: Array<{ file: string; path: string; params: Record<string, string> }> = [
  { file: 'manage_matter_custom_fields.json', path: '/api/v4/custom_fields.json', params: { parent_type: 'Matter', fields: CF_FIELDS, limit: '200' } },
  { file: 'manage_contact_custom_fields.json', path: '/api/v4/custom_fields.json', params: { parent_type: 'Contact', fields: CF_FIELDS, limit: '200' } },
  { file: 'manage_matter_custom_field_sets.json', path: '/api/v4/custom_field_sets.json', params: { parent_type: 'Matter', fields: CFS_FIELDS, limit: '200' } },
  { file: 'manage_contact_custom_field_sets.json', path: '/api/v4/custom_field_sets.json', params: { parent_type: 'Contact', fields: CFS_FIELDS, limit: '200' } },
  { file: 'manage_practice_areas.json', path: '/api/v4/practice_areas.json', params: { fields: PA_FIELDS, limit: '200' } },
];

// ---------------- baseline loading (Pass 6b snapshot shapes) ----------------
interface BaselineField { id: number; name: string; field_type?: string; required?: boolean }

function loadBaselineCustomFields(file: string): BaselineField[] {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(j.rows)) return j.rows as BaselineField[];
  if (Array.isArray(j.data)) return j.data as BaselineField[];
  return [];
}

function normType(t: string | undefined): string {
  // Settings-UI labels (snapshot) vs API enum (re-pull)
  const map: Record<string, string> = {
    'text field': 'text_line', 'text (one-line)': 'text_line', 'text': 'text_line',
    'text area': 'text_area', 'text (multi-line)': 'text_area',
    'money': 'currency',
    'checkbox': 'checkbox', 'picklist': 'picklist', 'date': 'date',
    'numeric': 'numeric', 'currency': 'currency', 'contact': 'contact',
    'matter': 'matter', 'url': 'url', 'time': 'time', 'email': 'email',
  };
  const k = (t ?? '').toLowerCase().trim();
  return map[k] ?? k;
}

/** Collapse whitespace for tolerant name comparison; exact spelling still reported when it differs. */
function normName(n: string | undefined): string {
  return (n ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------- main ----------------
async function main() {
  const filesDir = join(outDir!, 'files');
  mkdirSync(filesDir, { recursive: true });

  const accessToken = await getAccessToken();
  const manifest: string[] = [];
  const pulled: Record<string, ApiPage> = {};

  for (const spec of PULLS) {
    console.log(`[pull] ${spec.path} ${JSON.stringify(spec.params.parent_type ?? '')}`);
    const page = await getAllPages(accessToken, spec.path, spec.params);
    pulled[spec.file] = page;
    const body = JSON.stringify(page, null, 2);
    writeFileSync(join(filesDir, spec.file), body);
    const sha = createHash('sha256').update(body).digest('hex');
    manifest.push(`${sha}  ${spec.file}`);
    console.log(`       -> ${page.data.length} rows, sha256 ${sha.slice(0, 12)}…`);
  }

  writeFileSync(join(outDir!, 'SHA256_MANIFEST.txt'), manifest.join('\n') + '\n');

  // ---------------- drift diff ----------------
  if (!baselineDir) {
    console.log('\n[done] no --baseline given; skipping drift diff');
    return;
  }

  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); console.log(s); };

  say('# Clio Manage schema drift report — Pass 7 re-pull vs Pass 6b W0 snapshot');
  say('');
  say(`**Re-pull:** ${new Date().toISOString()} via OAuth API (raw responses).`);
  say(`**Baseline:** ${baselineDir} (2026-04-26 DevTools capture; 3 files reconstructed).`);
  say('**Grow-side files:** not re-pullable with the Manage OAuth token; April baseline retained.');
  say('');

  let driftCount = 0;

  for (const kind of ['matter', 'contact'] as const) {
    const file = `manage_${kind}_custom_fields.json`;
    const baselinePath = join(baselineDir, file);
    if (!existsSync(baselinePath)) { say(`## ${kind} custom fields — baseline file missing, skipped`); continue; }
    const before = loadBaselineCustomFields(baselinePath);
    const after = (pulled[file].data as BaselineField[]).filter((f) => !(f as { deleted?: boolean }).deleted);

    const beforeById = new Map(before.map((f) => [f.id, f]));
    const afterById = new Map(after.map((f) => [f.id, f]));

    const added = after.filter((f) => !beforeById.has(f.id));
    const removed = before.filter((f) => !afterById.has(f.id));

    say(`## ${kind} custom fields`);
    say(`- Baseline rows: ${before.length} · Re-pull rows (non-deleted): ${after.length}`);
    if (added.length) { driftCount += added.length; say(`- **ADDED (${added.length}):** ${added.map((f) => `\`${f.name}\` (id ${f.id}, ${f.field_type})`).join(', ')}`); }
    if (removed.length) { driftCount += removed.length; say(`- **REMOVED (${removed.length}):** ${removed.map((f) => `\`${f.name}\` (id ${f.id})`).join(', ')}`); }
    let changedCount = 0;
    for (const f of after) {
      const b = beforeById.get(f.id);
      if (!b) continue;
      const diffs: string[] = [];
      if (normName(b.name) !== normName(f.name)) diffs.push(`name \`${b.name}\` -> \`${f.name}\``);
      else if (b.name !== f.name) diffs.push(`name whitespace-only change \`${b.name}\` -> \`${f.name}\` (exact spelling; mapping keys must use the new exact form)`);
      if (normType(b.field_type) !== normType(f.field_type)) diffs.push(`type ${b.field_type} -> ${f.field_type}`);
      if ((b.required ?? false) !== (f.required ?? false)) diffs.push(`required ${b.required ?? false} -> ${f.required ?? false}`);
      if (diffs.length) {
        driftCount++; changedCount++;
        say(`- **CHANGED:** \`${normName(f.name)}\` (id ${f.id}): ${diffs.join('; ')}`);
      }
    }
    if (!added.length && !removed.length && !changedCount) say('- No drift.');
    say('');
  }

  // Practice areas (baseline is raw API shape already)
  {
    const file = 'manage_practice_areas.json';
    const baselinePath = join(baselineDir, file);
    if (existsSync(baselinePath)) {
      const before = (JSON.parse(readFileSync(baselinePath, 'utf8')).data ?? []) as BaselineField[];
      const after = pulled[file].data as BaselineField[];
      const beforeNames = new Set(before.map((p) => p.name));
      const afterNames = new Set(after.map((p) => p.name));
      const added = after.filter((p) => !beforeNames.has(p.name));
      const removed = before.filter((p) => !afterNames.has(p.name));
      say('## practice areas');
      say(`- Baseline rows: ${before.length} · Re-pull rows: ${after.length}`);
      if (added.length) { driftCount += added.length; say(`- **ADDED (${added.length}):** ${added.map((p) => p.name).join(', ')}`); }
      if (removed.length) { driftCount += removed.length; say(`- **REMOVED (${removed.length}):** ${removed.map((p) => p.name).join(', ')}`); }
      if (!added.length && !removed.length) say('- No drift.');
      say('');
    }
  }

  // Field sets — compare set names + member names
  for (const kind of ['matter', 'contact'] as const) {
    const file = `manage_${kind}_custom_field_sets.json`;
    const baselinePath = join(baselineDir, file);
    if (!existsSync(baselinePath)) continue;
    const bj = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const beforeRows = (bj.rows ?? bj.data ?? []) as Array<{ name: string; members?: string }>;
    const afterRows = pulled[file].data as Array<{ name: string; custom_fields?: Array<{ name: string }> }>;
    say(`## ${kind} custom field sets`);
    say(`- Baseline sets: ${beforeRows.length} · Re-pull sets: ${afterRows.length}`);
    const beforeNames = new Set(beforeRows.map((r) => r.name));
    const afterNames = new Set(afterRows.map((r) => r.name));
    const added = [...afterNames].filter((n) => !beforeNames.has(n));
    const removed = [...beforeNames].filter((n) => !afterNames.has(n));
    if (added.length) { driftCount += added.length; say(`- **ADDED SETS:** ${added.join(', ')}`); }
    if (removed.length) { driftCount += removed.length; say(`- **REMOVED SETS:** ${removed.join(', ')}`); }
    for (const a of afterRows) {
      const b = beforeRows.find((r) => r.name === a.name);
      if (!b || !b.members) continue;
      // Members arrive as a comma-joined display string in the baseline; field
      // names themselves contain commas inside parentheses (e.g. "Salary
      // (yr,mo,wk)"), so compare on a space-insensitive whole-string key
      // against each after-side name rather than naive comma-splitting.
      const memberKey = (s: string) => normName(s).replace(/\s/g, '');
      const afterMemberKeys = new Set((a.custom_fields ?? []).map((f) => memberKey(f.name)));
      const beforeJoined = memberKey(b.members);
      const afterNames = (a.custom_fields ?? []).map((f) => f.name);
      void afterMemberKeys;
      const mAdded = afterNames.filter((n) => !beforeJoined.includes(memberKey(n)));
      let residue = beforeJoined;
      for (const n of afterNames) residue = residue.replace(memberKey(n), '');
      residue = residue.replace(/^,+|,+$/g, '').replace(/,{2,}/g, ',').replace(/—/g, '');
      const mRemoved = residue.split(',').filter(Boolean);
      if (mAdded.length) { driftCount += mAdded.length; say(`- **SET \`${a.name}\` MEMBERS ADDED:** ${mAdded.join(', ')}`); }
      if (mRemoved.length) { driftCount += mRemoved.length; say(`- **SET \`${a.name}\` MEMBERS REMOVED:** ${mRemoved.join(', ')}`); }
    }
    if (!added.length && !removed.length) say('- Set names unchanged (member-level notes above if any).');
    say('');
  }

  say(`## Verdict`);
  say(driftCount === 0
    ? '**NO DRIFT** on the Manage side vs the 2026-04-26 baseline (within compared fields: id, name, type, required, set membership, practice-area names).'
    : `**DRIFT DETECTED: ${driftCount} item(s)** — fieldMapping bootstrap must be re-run against this snapshot before any matter-data call consumes the mapping.`);

  writeFileSync(join(outDir!, 'DRIFT_REPORT.md'), lines.join('\n') + '\n');
  console.log(`\n[done] wrote ${join(outDir!, 'DRIFT_REPORT.md')}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
