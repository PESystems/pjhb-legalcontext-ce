/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — fieldMapping unit tests (Pass 6b W2).
 *
 * Covers:
 *   1. Schema validator: known-good + known-bad mapping JSONs.
 *   2. Loader: file-not-found, malformed JSON, schema-violation paths.
 *   3. Runtime mapping: identity transformer round-trip per type.
 *   4. Drift detection: synthetic mismatches at each severity.
 *   5. Conversion-time warning surface for the 5 grow-only fields.
 *   6. Bootstrap integration smoke test against the real workspace
 *      schema snapshot (validates row count + grow-only set + idempotency).
 *
 * Runnable via:  bun run src/tests/test-fieldMapping.ts
 */

import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateFieldMapping,
  loadFieldMapping,
  applyTransformer,
  growToManage,
  manageToGrow,
  detectDrift,
  emitConversionWarnings,
  listGrowOnlyEntries,
  indexByCanonical,
  FieldMappingValidationError,
  type FieldMappingTable,
  type FieldMappingEntry,
} from '../clio/fieldMapping';
import { bootstrap } from '../clio/scripts/bootstrap-field-mapping';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

function makeEntry(over: Partial<FieldMappingEntry> = {}): FieldMappingEntry {
  return {
    grow_field_name: 'Test Field',
    manage_field_id: 12345,
    manage_field_name: 'Test Field',
    canonical_name: 'test_field',
    type: 'text',
    transformer: 'identity',
    validation_rules: {},
    drift_severity: 'low',
    side: 'matter',
    ...over,
  };
}

function makeTable(entries: FieldMappingEntry[]): FieldMappingTable {
  return {
    version: 1,
    generated: '2026-04-26T00:00:00Z+test',
    source_snapshot_sha256: { 'foo.json': 'a'.repeat(64) },
    entries,
  };
}

async function main() {
  console.log('=== PJHB Pass 6b W2 — fieldMapping unit tests ===\n');

  // ---- Test 1: schema validator — known good ----
  console.log('Test 1 — schema validator: known good');
  const good = makeTable([makeEntry()]);
  check('known-good table validates clean', validateFieldMapping(good).length === 0);

  // ---- Test 2: schema validator — known bad cases ----
  console.log('\nTest 2 — schema validator: rejects bad input');
  check('rejects non-object top-level', validateFieldMapping(null).length > 0);
  check('rejects wrong version', validateFieldMapping({ ...good, version: 2 }).length > 0);
  check('rejects non-array entries', validateFieldMapping({ ...good, entries: 'oops' }).length > 0);
  check('rejects bad canonical_name (uppercase)',
    validateFieldMapping(makeTable([makeEntry({ canonical_name: 'BadName' })])).length > 0);
  check('rejects bad canonical_name (leading digit)',
    validateFieldMapping(makeTable([makeEntry({ canonical_name: '1bad' })])).length > 0);
  check('rejects bad canonical_name (hyphen)',
    validateFieldMapping(makeTable([makeEntry({ canonical_name: 'bad-name' })])).length > 0);
  check('rejects unknown type',
    validateFieldMapping(makeTable([makeEntry({ type: 'fancy' as any })])).length > 0);
  check('rejects bad drift_severity',
    validateFieldMapping(makeTable([makeEntry({ drift_severity: 'extreme' as any })])).length > 0);
  check('rejects duplicate canonical_name',
    validateFieldMapping(makeTable([makeEntry(), makeEntry()])).length > 0);
  check('rejects bad side',
    validateFieldMapping(makeTable([makeEntry({ side: 'matter ' as any })])).length > 0);

  // ---- Test 3: loader paths ----
  console.log('\nTest 3 — loader paths');
  const tmp = mkdtempSync(join(tmpdir(), 'pjhb-fieldmap-test-'));
  // file-not-found
  let threw = false;
  try { loadFieldMapping(join(tmp, 'absent.json')); } catch (e) { threw = (e as Error).message.includes('not found'); }
  check('file-not-found surfaces clear error', threw);
  // malformed JSON
  const malformed = join(tmp, 'malformed.json');
  writeFileSync(malformed, '{ this is not json');
  threw = false;
  try { loadFieldMapping(malformed); } catch (e) { threw = (e as Error).message.includes('parse'); }
  check('malformed JSON surfaces parse error', threw);
  // schema violation
  const badSchema = join(tmp, 'bad.json');
  writeFileSync(badSchema, JSON.stringify({ version: 99, entries: [] }));
  threw = false;
  try { loadFieldMapping(badSchema); } catch (e) {
    threw = e instanceof FieldMappingValidationError && e.errors.length > 0;
  }
  check('schema-violation surfaces FieldMappingValidationError', threw);
  // happy path
  const goodPath = join(tmp, 'good.json');
  writeFileSync(goodPath, JSON.stringify(good));
  const loaded = loadFieldMapping(goodPath);
  check('happy-path loads and returns table', loaded.entries.length === 1);

  // ---- Test 4: identity transformer round-trip ----
  console.log('\nTest 4 — identity transformer round-trip per type');
  const samples: Array<[string, unknown]> = [
    ['text', 'hello'],
    ['number', 42.5],
    ['integer', 7],
    ['date', '2026-04-26'],
    ['boolean', true],
    ['money', 12345.67],
    ['paragraph_text', 'multi\nline\ntext'],
    ['email', 'support@example.test'],
  ];
  for (const [type, val] of samples) {
    const out = applyTransformer('identity', val);
    check(`identity round-trip preserves ${type}`, JSON.stringify(out) === JSON.stringify(val));
  }
  threw = false;
  try { applyTransformer('not_real', 'x'); } catch (e) { threw = (e as Error).message.includes('Unknown transformer'); }
  check('unknown transformer throws', threw);

  // ---- Test 5: growToManage / manageToGrow direction handling ----
  console.log('\nTest 5 — growToManage / manageToGrow');
  const mapped = makeEntry({ canonical_name: 'mapped', manage_field_id: 999 });
  const growOnly = makeEntry({ canonical_name: 'grow_only', manage_field_id: null, manage_field_name: null, drift_severity: 'high' });
  check('growToManage preserves value on mapped entry', growToManage(mapped, 'foo') === 'foo');
  check('growToManage returns null for grow-only entry', growToManage(growOnly, 'foo') === null);
  check('manageToGrow preserves value on mapped entry', manageToGrow(mapped, 'bar') === 'bar');
  check('manageToGrow returns null for grow-only entry', manageToGrow(growOnly, 'bar') === null);

  // ---- Test 6: drift detection ----
  console.log('\nTest 6 — drift detection');
  const matchReport = detectDrift(mapped, 'same', 'same');
  check('match report when values agree', matchReport.match === true);
  const mismatchReport = detectDrift(mapped, 'a', 'b');
  check('mismatch report when values differ', mismatchReport.match === false);
  check('mismatch carries severity from entry', mismatchReport.severity === 'low');
  const growOnlyReport = detectDrift(growOnly, 'g', 'm');
  check('grow-only report flagged not-match', growOnlyReport.match === false);
  check('grow-only report severity is high', growOnlyReport.severity === 'high');

  // ---- Test 7: conversion-time warning surface ----
  console.log('\nTest 7 — conversion-time warning surface');
  const tableWithGrowOnly = makeTable([
    mapped,
    makeEntry({ canonical_name: 'grow_a', manage_field_id: null, manage_field_name: null, drift_severity: 'high', side: 'matter' }),
    makeEntry({ canonical_name: 'grow_b', manage_field_id: null, manage_field_name: null, drift_severity: 'high', side: 'contact' }),
  ]);
  const growOnlyList = listGrowOnlyEntries(tableWithGrowOnly);
  check('listGrowOnlyEntries returns 2', growOnlyList.length === 2);
  const warnings = emitConversionWarnings(tableWithGrowOnly, { grow_a: 'val-a', mapped: 'safe' });
  check('emits warning for present grow-only field', warnings.length === 1 && warnings[0].canonical_name === 'grow_a');
  check('warning carries side info', warnings[0].side === 'matter');
  check('does NOT warn on mapped fields', !warnings.some(w => w.canonical_name === 'mapped'));
  const noWarnings = emitConversionWarnings(tableWithGrowOnly, { mapped: 'only-mapped' });
  check('zero warnings when no grow-only data present', noWarnings.length === 0);

  // ---- Test 8: indexByCanonical ----
  console.log('\nTest 8 — indexByCanonical');
  const idx = indexByCanonical(tableWithGrowOnly);
  check('indexes 3 entries', idx.size === 3);
  check('lookup returns same entry by canonical_name',
    idx.get('mapped')?.manage_field_id === 999);

  // ---- Test 9: bootstrap integration smoke test against workspace ----
  console.log('\nTest 9 — bootstrap integration smoke test against workspace snapshot');
  const snapshotDir = process.env.PJHB_SCHEMA_SNAPSHOT_DIR;
  if (!snapshotDir) {
    console.warn('  [SKIP] Test 9 — set PJHB_SCHEMA_SNAPSHOT_DIR to run');
  } else {
    const r1 = bootstrap({ snapshotDir, dryRun: true });
    check('bootstrap row count matches expected (58 = 50 matter + 8 contact)',
      r1.rowCounts.total === 58 && r1.rowCounts.matter === 50 && r1.rowCounts.contact === 8);
    check('bootstrap reports 5 grow-only entries', r1.rowCounts.growOnly === 5);
    // Idempotency: byte-equal output
    const r2 = bootstrap({ snapshotDir, dryRun: true });
    check('bootstrap is idempotent (byte-equal table)',
      JSON.stringify(r1.table) === JSON.stringify(r2.table));
    // Validate the bootstrap output passes validation
    check('bootstrap output passes schema validation',
      validateFieldMapping(r1.table).length === 0);
    // Spot-check the 5 known grow-only canonical names
    const growOnlySet = new Set(r1.table.entries.filter(e => e.manage_field_id === null).map(e => e.canonical_name));
    const expectedGrowOnly = ['employment_status', 'contract_growonly', 'file_stage', 'ep_ca_rep', 'union_growonly'];
    for (const expected of expectedGrowOnly) {
      check(`grow-only set contains ${expected}`, growOnlySet.has(expected));
    }
  }

  // Cleanup
  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
