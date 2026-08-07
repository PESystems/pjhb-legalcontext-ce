/**
 * PJHB Pass 7 — calculator CLI runner.
 *
 * Run the extractor + settlement calculator over a W4 fixture file or an
 * arbitrary MatterInput JSON, printing a paralegal-readable summary plus
 * (optionally) the full estimate JSON.
 *
 * Usage:
 *   bun run scripts/run-calculator.ts --fixture <path-to-F0x.md> [--json]
 *   bun run scripts/run-calculator.ts --input <path-to-matter-input.json> [--json]
 */

import { readFileSync } from 'fs';
import { extractBardalFactors } from '../src/extractors/bardalExtractor';
import { calculateSettlement, CALCULATOR_VERSION } from '../src/calculator/settlementCalculator';
import { loadFixture } from '../src/tests/fixtureLoader';
import type { MatterInput } from '../src/extractors/bardalExtractor';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fixturePath = argValue('--fixture');
const inputPath = argValue('--input');
const wantJson = process.argv.includes('--json');

if (!fixturePath && !inputPath) {
  console.error('Usage: bun run scripts/run-calculator.ts (--fixture <F0x.md> | --input <matter.json>) [--json]');
  process.exit(1);
}

const input: MatterInput = fixturePath
  ? loadFixture(fixturePath).input
  : (JSON.parse(readFileSync(inputPath!, 'utf8')) as MatterInput);

const analysis = extractBardalFactors(input);
const estimate = calculateSettlement(analysis);

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toLocaleString('en-CA')}`);

console.log('='.repeat(68));
console.log(`PJHB settlement calculator ${CALCULATOR_VERSION} — matter ${estimate.matter_id ?? '(unspecified)'}`);
console.log('='.repeat(68));
console.log(`Risk band:        ${estimate.risk_band.band.toUpperCase()}${estimate.risk_band.elevated_by_conflict ? ' (elevated by conflict)' : ''}`);
for (const t of estimate.risk_band.triggers) {
  console.log(`   - ${t.criterion}${t.provisional ? '  [provisional threshold]' : ''}`);
}
if (estimate.notice) {
  console.log(`Notice estimate:  ${estimate.notice.weeks_low}–${estimate.notice.weeks_mid}–${estimate.notice.weeks_high} wk (ESA floor ${estimate.notice.esa_minimum_weeks} wk)`);
  for (const r of estimate.notice.rationale) console.log(`   - ${r}`);
}
console.log(`Trial-level:      ${fmt(estimate.trial_level_value)}`);
if (estimate.settlement_estimate) {
  console.log(`Settlement est.:  ${fmt(estimate.settlement_estimate.low)} – ${fmt(estimate.settlement_estimate.mid)} – ${fmt(estimate.settlement_estimate.high)}`);
}
if (estimate.offer_gap) {
  console.log(`Offer gap:        offered ${estimate.offer_gap.offered_weeks} wk vs entitled ~${estimate.offer_gap.entitled_weeks_mid} wk (${Math.round(estimate.offer_gap.offered_fraction_of_entitlement * 100)}% of entitlement)`);
}
if (estimate.conflicts.length) {
  console.log('Conflicts:');
  for (const c of estimate.conflicts) console.log(`   - [${c.severity}] ${c.field}: ${c.detail}`);
}
console.log(`Review required:  ${estimate.paralegal_review_required ? 'YES' : 'no'}`);
for (const r of estimate.review_reasons) console.log(`   - ${r}`);
console.log(`Driving conf.:    ${estimate.driving_confidence.toFixed(2)}`);
console.log(`\n${estimate.disclaimer}`);

if (wantJson) {
  console.log('\n--- full estimate JSON ---');
  console.log(JSON.stringify(estimate, null, 2));
}
