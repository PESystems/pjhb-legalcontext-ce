/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — settlement calculator unit tests (Pass 7).
 *
 * Covers:
 *   1. Worked-example anchor reproduction (Pass 2.6 / MVP scope §8).
 *   2. ESA statutory floor + 24-month cap + short-service floor.
 *   3. Risk-band rubric v0.1: red/yellow/green triggers, precedence,
 *      unknown-input default, conflict default-upward, not-terminated path.
 *   4. Inter-source conflict detection (Gate G2 sub-feature).
 *   5. Determinism + audit surface.
 *   6. Full pipeline over the 12 W4 fixtures (band agreement vs fixture tags).
 *
 * Runnable via:
 *   PJHB_FIXTURES_DIR=<W4 fixtures dir> bun run src/tests/test-settlementCalculator.ts
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { extractBardalFactors } from '../extractors/bardalExtractor';
import type { MatterInput } from '../extractors/bardalExtractor';
import {
  calculateSettlement,
  estimateFromEntitlement,
  estimateNoticeWeeks,
  esaMinimumWeeks,
  detectInputConflicts,
  assessRiskBand,
  DEFAULT_CALIBRATION,
  CALCULATOR_VERSION,
} from '../calculator/settlementCalculator';
import { loadFixture } from './fixtureLoader';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

function makeInput(over: Partial<MatterInput> & { custom_fields?: Record<string, unknown> } = {}): MatterInput {
  return {
    matter_id: 'TEST',
    custom_fields: {
      years_of_service: 5,
      age: 45,
      date_of_birth: '1980-06-01',
      termination_date: '2026-01-15',
      start_date: '2021-01-15',
      position: 'Operations Manager',
      annual_salary: 80_000,
      notice_offered: 4,
      mitigation_status: 'Actively searching',
      ...(over.custom_fields ?? {}),
    },
    documents: over.documents ?? {},
    current_clio_stage: over.current_clio_stage ?? 'Demand Letter',
  };
}

// ---- Test 1: worked-example anchor ----------------------------------
console.log('Test 1 — Pass 2.6 worked-example anchor reproduction');
{
  // Fuad deep-dive [41:11]-[41:35]: evaluated at $32k for 12 months pay;
  // settled $13,000 (≈41% of trial-level).
  const r = estimateFromEntitlement(52, 32_000);
  check('trial-level ≈ $32k for 12 months at $32k salary',
    Math.abs(r.trial_level_value - 32_000) < 200, `got ${r.trial_level_value}`);
  check('settlement band low end ≈ observed $13k settlement',
    Math.abs(r.settlement_estimate.low - 13_000) < 200, `got ${r.settlement_estimate.low}`);
  check('observed settlement falls inside the estimate band',
    13_000 >= r.settlement_estimate.low - 200 && 13_000 <= r.settlement_estimate.high);
  check('high end reflects charter ~50% framing',
    Math.abs(r.settlement_estimate.high - 16_000) < 200, `got ${r.settlement_estimate.high}`);
  check('calibration is honest about n=1', DEFAULT_CALIBRATION.n_points === 1);
}

// ---- Test 2: ESA floor / caps ---------------------------------------
console.log('\nTest 2 — ESA statutory floor, caps, short-service floor');
{
  check('ESA: <3 months service → 0 wk', esaMinimumWeeks(0.2) === 0);
  check('ESA: 1 yr → 1 wk', esaMinimumWeeks(1) === 1);
  check('ESA: 5.7 yr → 5 wk', esaMinimumWeeks(5.7) === 5);
  check('ESA: 30 yr capped at 8 wk', esaMinimumWeeks(30) === 8);

  const long = estimateNoticeWeeks({ years_of_service: 40, age: 63, position_band: 'executive', mitigation_status: null });
  check('24-month cap binds for extreme tenure', long.weeks_mid <= 104 && long.weeks_high <= 104, `mid=${long.weeks_mid}`);

  const short = estimateNoticeWeeks({ years_of_service: 1, age: 28, position_band: 'entry-level', mitigation_status: null });
  check('short-service floor: 1 yr entry-level ≥ 6 wk', short.weeks_mid >= 6, `mid=${short.weeks_mid}`);
  check('notice low bounded below by ESA floor', short.weeks_low >= esaMinimumWeeks(1));

  const mid = estimateNoticeWeeks({ years_of_service: 10, age: 45, position_band: 'mid-level', mitigation_status: null });
  check('10 yr mid-level lands in a sane band (30–52 wk mid)', mid.weeks_mid >= 30 && mid.weeks_mid <= 52, `mid=${mid.weeks_mid}`);
  check('rationale trail present', mid.rationale.length >= 4);
}

// ---- Test 3: risk band rubric ---------------------------------------
console.log('\nTest 3 — risk-band rubric v0.1');
{
  const red1 = calculateSettlement(extractBardalFactors(makeInput({ custom_fields: { years_of_service: 12 } })));
  check('service ≥ 10 yr → red', red1.risk_band.band === 'red', red1.risk_band.band);

  const red2 = calculateSettlement(extractBardalFactors(makeInput({ custom_fields: { annual_salary: 200_000 } })));
  check('salary ≥ $150k → red', red2.risk_band.band === 'red', red2.risk_band.band);

  const red3 = calculateSettlement(extractBardalFactors(makeInput({ custom_fields: { notice_offered: 0, years_of_service: 3 } })));
  check('$0 severance + ≥2 yr → red', red3.risk_band.band === 'red', red3.risk_band.band);

  const red4 = calculateSettlement(extractBardalFactors(makeInput({ custom_fields: { position: 'Chief Financial Officer' } })));
  check('executive band → red', red4.risk_band.band === 'red', red4.risk_band.band);

  const green = calculateSettlement(extractBardalFactors(makeInput({
    custom_fields: {
      years_of_service: 1, age: 27, date_of_birth: '1998-06-01',
      start_date: '2025-01-10', termination_date: '2026-01-15', // dates agree with stated 1 yr
      annual_salary: 42_000, position: 'Warehouse Associate', notice_offered: 2,
    },
  })));
  check('short service + low salary → green', green.risk_band.band === 'green', green.risk_band.band);

  const yellow = calculateSettlement(extractBardalFactors(makeInput({})));
  check('5 yr / $80k defaults to yellow', yellow.risk_band.band === 'yellow', yellow.risk_band.band);

  // Precedence: green-looking service+salary but red salary trigger
  const precedence = calculateSettlement(extractBardalFactors(makeInput({
    custom_fields: { years_of_service: 1.5, annual_salary: 200_000, position: 'Analyst' },
  })));
  check('red trigger beats green profile (rubric §6.1)', precedence.risk_band.band === 'red', precedence.risk_band.band);

  // Unknown key inputs → yellow default (rubric §6.3)
  const unknown = calculateSettlement(extractBardalFactors({
    matter_id: 'U1',
    custom_fields: { position: 'Coordinator', termination_date: '2026-01-15' },
    documents: {},
    current_clio_stage: 'Demand Letter',
  }));
  check('unknown salary+service defaults to yellow', unknown.risk_band.band === 'yellow', unknown.risk_band.band);
  check('unknown default flagged', unknown.risk_band.defaulted_by_unknowns === true);

  // Not-terminated triage path (no termination date, intake stage)
  const nt = extractBardalFactors({
    matter_id: 'NT1',
    custom_fields: { position: 'Manager', annual_salary: 90_000 },
    documents: {},
    current_clio_stage: 'Contract Review',
  });
  const ntBand = assessRiskBand(nt, []);
  check('no termination date at intake → not_terminated path', ntBand.band === 'not_terminated', ntBand.band);
}

// ---- Test 4: conflict detection -------------------------------------
console.log('\nTest 4 — inter-source conflict detection (Gate G2 sub-feature)');
{
  // Stated 5 years, dates say ~10 years.
  const conflicted = extractBardalFactors(makeInput({
    custom_fields: { years_of_service: 5, start_date: '2016-01-15', termination_date: '2026-01-15' },
  }));
  const conflicts = detectInputConflicts(conflicted);
  check('stated-vs-derived tenure conflict detected', conflicts.some(c => c.field === 'length_of_employment'),
    JSON.stringify(conflicts));
  check('tenure conflict is high severity', conflicts.find(c => c.field === 'length_of_employment')?.severity === 'high');

  const est = calculateSettlement(conflicted);
  check('conflict forces paralegal review', est.paralegal_review_required === true);
  check('conflict elevates yellow → red (rubric §6.2)', est.risk_band.band === 'red' && est.risk_band.elevated_by_conflict,
    `band=${est.risk_band.band}`);

  // Settled amount at a non-settled stage
  const staged = extractBardalFactors(makeInput({ custom_fields: { settled_amount: 15_000 } }));
  const c2 = detectInputConflicts(staged);
  check('settled_amount at demand stage flagged', c2.some(c => c.field === 'settled_amount'), JSON.stringify(c2));

  // Demand below the employer's standing offer value
  const lowDemand = extractBardalFactors(makeInput({
    custom_fields: { demand_amount: 1_000, notice_offered: 8, annual_salary: 80_000 },
  }));
  const c3 = detectInputConflicts(lowDemand);
  check('demand below standing offer flagged', c3.some(c => c.field === 'demand_amount'), JSON.stringify(c3));

  // Clean input → no conflicts
  const clean = extractBardalFactors(makeInput({}));
  check('consistent input has no conflicts', detectInputConflicts(clean).length === 0);
}

// ---- Test 5: determinism + audit surface ----------------------------
console.log('\nTest 5 — determinism + audit surface');
{
  const input = makeInput({});
  const a = calculateSettlement(extractBardalFactors(input));
  const b = calculateSettlement(extractBardalFactors(input));
  const scrub = (e: object) => JSON.stringify(e).replace(/"timestamp":"[^"]+"/g, '');
  check('same input → identical estimate', scrub(a) === scrub(b));
  check('calculator version stamped', a.calculator_version === CALCULATOR_VERSION);
  check('disclaimer present', a.disclaimer.includes('Not legal advice'));
  check('inputs echoed with confidences', Object.keys(a.inputs_used).length === 6
    && a.inputs_used.years_of_service.confidence > 0);
  check('offer gap computed', a.offer_gap !== null && a.offer_gap!.offered_weeks === 4);
  check('n=1 calibration triggers provisional-review reason',
    a.review_reasons.some(r => r.includes('calibration')));
  check('notice rationale carried through', (a.notice?.rationale.length ?? 0) >= 4);
}

// ---- Test 6: full pipeline over the 12 W4 fixtures ------------------
console.log('\nTest 6 — full extractor→calculator pipeline over W4 fixtures');
const fixturesDir = process.env.PJHB_FIXTURES_DIR;
if (!fixturesDir) {
  console.warn('  [SKIP] Test 6 — set PJHB_FIXTURES_DIR to run');
} else {
  const files = readdirSync(fixturesDir).filter(f => /^F\d+_.*\.md$/.test(f)).sort();
  check('12 fixtures found', files.length === 12, `${files.length}`);
  let bandAgree = 0;
  let ran = 0;
  const disagreements: string[] = [];
  for (const f of files) {
    const { meta, input } = loadFixture(join(fixturesDir, f));
    const est = calculateSettlement(extractBardalFactors(input));
    ran++;
    const expected = String(meta.risk_band ?? '').toLowerCase();
    // EDGE-CASE fixtures carry deliberate anomalies; the rubric's
    // default-upward behavior means calculated ≥ expected is acceptable
    // there. For plain fixtures we count exact agreement.
    if (expected === 'red' || expected === 'yellow' || expected === 'green') {
      const order: Record<string, number> = { green: 0, yellow: 1, red: 2 };
      if (est.risk_band.band === expected) bandAgree++;
      else if ((order[est.risk_band.band] ?? 0) > (order[expected] ?? 0) &&
               (est.risk_band.elevated_by_conflict || meta.chronology_bucket === 'edge-case' || f.includes('edge-case'))) {
        bandAgree++; // upward elevation on a flagged fixture is rubric-correct
      } else {
        disagreements.push(`${f}: expected ${expected}, got ${est.risk_band.band}`);
      }
    }
    check(`${f}: calculator produced a complete estimate`,
      est.risk_band.band !== undefined && est.review_reasons.length >= 0 &&
      (est.notice === null || est.notice.weeks_mid > 0));
  }
  check('all 12 fixtures ran', ran === 12);
  check(`risk band agrees with fixture tag on ≥ 9 of tagged fixtures (got ${bandAgree})`,
    bandAgree >= 9, disagreements.join(' | '));

  // Ordering sanity: the RED trial fixture (F09: 23.8 yr, $159k, age 57)
  // must produce a larger settlement estimate than a GREEN fixture.
  const f09 = calculateSettlement(extractBardalFactors(loadFixture(join(fixturesDir, files.find(f => f.startsWith('F09'))!)).input));
  const green = files.find(f => /green/.test(f))!;
  const fGreen = calculateSettlement(extractBardalFactors(loadFixture(join(fixturesDir, green)).input));
  if (f09.settlement_estimate && fGreen.settlement_estimate) {
    check('RED long-tenure estimate > GREEN estimate',
      f09.settlement_estimate.mid > fGreen.settlement_estimate.mid,
      `${f09.settlement_estimate.mid} vs ${fGreen.settlement_estimate.mid}`);
  } else {
    check('both comparison fixtures produced dollar estimates', false,
      `f09=${JSON.stringify(f09.settlement_estimate)} green=${JSON.stringify(fGreen.settlement_estimate)}`);
  }
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
