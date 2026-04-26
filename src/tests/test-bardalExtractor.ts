/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — extractBardalFactors unit tests (Pass 6b W1).
 *
 * Covers:
 *   1. parseYearsOfService — numeric, word-form, "X years Y months".
 *   2. computeAgeFromDOB / parseAgeText — age computation paths.
 *   3. classifyPositionBand — 7-band classifier across exemplar titles.
 *   4. mapClioStageToAnalytical — 14-label → 6-state stage mapping.
 *   5. detectEdgeCases — constructive_dismissal / contractor_vs_employee /
 *      partial_mitigation flags.
 *   6. extractBardalFactors — end-to-end against the W4 fixture set
 *      (12 fixtures from PJHB workspace 10_artifacts/test_fixtures/).
 *   7. Confidence-distribution sanity (no factor at all-1.0 across set).
 *   8. Round-trip stability: extract → JSON → parse → extract → match.
 *   9. Terminology grep: "Notice Given" appears nowhere in this file's
 *      sources or schema.
 *
 * Runnable via:  bun run src/tests/test-bardalExtractor.ts
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  parseYearsOfService,
  computeAgeFromDOB,
  parseAgeText,
  classifyPositionBand,
  mapClioStageToAnalytical,
  detectEdgeCases,
  extractBardalFactors,
  type MatterInput,
  type PositionBand,
  type AnalyticalStage,
  EXTRACTOR_VERSION,
} from '../extractors/bardalExtractor';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.error(`  [FAIL] ${name}  ${detail}`); }
}

// ---- Fixture loading -----------------------------------------------

interface FixtureMeta {
  fixture_id: string;
  stage: 'demand-letter' | 'settlement-conference' | 'trial';
  risk_band: 'RED' | 'YELLOW' | 'GREEN' | 'EDGE-CASE';
  chronology_bucket: 'older' | 'current' | 'newest';
  // ... plus all the extracted custom-field values (use `any` typing here for forward-compat)
  [k: string]: unknown;
}

interface LoadedFixture {
  filename: string;
  meta: FixtureMeta;
  body: string;
}

function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  // Minimal YAML parser for the flat key:value form our generator emits.
  // Avoids adding a yaml dep just for tests.
  const out: Record<string, unknown> = {};
  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let val: string = line.slice(colonIdx + 1).trim();
    // Trim trailing comment
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    if (val === 'null' || val === '~') { out[key] = null; continue; }
    if (val === 'true') { out[key] = true; continue; }
    if (val === 'false') { out[key] = false; continue; }
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      out[key] = parseFloat(val);
      continue;
    }
    out[key] = val;
  }
  return out;
}

function loadFixture(filePath: string): LoadedFixture {
  const rawRaw = readFileSync(filePath, 'utf8');
  // Normalize CRLF → LF so the frontmatter regex (and downstream H2 split) work
  // on both Windows-generated and Unix-generated fixture files.
  const raw = rawRaw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`No frontmatter in ${filePath}`);
  const meta = parseSimpleYaml(m[1]) as unknown as FixtureMeta;
  const body = m[2];
  return { filename: filePath.split(/[\/\\]/).pop() || filePath, meta, body };
}

/** Convert a fixture into a MatterInput by splitting its body sections. */
function fixtureToMatterInput(f: LoadedFixture): MatterInput {
  // Split on H2 headers in our generator's body output
  const documents: MatterInput['documents'] = {};
  const sections = f.body.split(/\n## /);
  for (const s of sections) {
    const norm = s.trim();
    if (norm.startsWith('Letter of Termination')) documents.termination_letter = norm;
    else if (norm.startsWith('Employment contract')) documents.employment_contract = norm;
    else if (norm.startsWith('Demand Letter')) documents.demand_letter = norm;
    else if (norm.startsWith('Settlement-conference notes')) documents.settlement_conference_notes = norm;
    else if (norm.startsWith('Trial-judgment summary')) documents.trial_judgment = norm;
  }

  // Build custom_fields from the metadata, EXCLUDING test-only annotations
  const skipKeys = new Set([
    'fixture_id', 'synthetic', 'generator', 'generator_seed',
    'stage', 'risk_band', 'chronology_bucket',
    'client_name_synthetic', 'employer_synthetic', 'practice_area',
  ]);
  const custom_fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.meta)) {
    if (skipKeys.has(k) || k.startsWith('expected_extraction_confidence_')) continue;
    custom_fields[k] = v;
  }

  // Map stage label to a Clio stage label that mapClioStageToAnalytical
  // recognizes
  const clioStageMap: Record<string, string> = {
    'demand-letter': 'Demand Letter',
    'settlement-conference': 'Settlement Conference Scheduled',
    'trial': 'Awaiting Trial',
  };
  return {
    matter_id: f.meta.fixture_id,
    custom_fields,
    documents,
    current_clio_stage: clioStageMap[f.meta.stage],
  };
}

async function main() {
  console.log('=== PJHB Pass 6b W1 — extractBardalFactors unit tests ===\n');

  // ---- Test 1: parseYearsOfService ----
  console.log('Test 1 — parseYearsOfService');
  check('numeric "3.5"', parseYearsOfService('3.5')?.value === 3.5);
  check('numeric "3.5 years"', parseYearsOfService('3.5 years')?.value === 3.5);
  check('"3 years 6 months"', Math.abs((parseYearsOfService('3 years 6 months')?.value ?? 0) - 3.5) < 0.01);
  check('word "two years"', parseYearsOfService('two years')?.value === 2);
  check('word "twenty-five years"', parseYearsOfService('twenty-five years')?.value === 25);
  check('bare numeric "7"', parseYearsOfService('7')?.value === 7);
  check('null on empty', parseYearsOfService('') === null);
  check('null on garbage', parseYearsOfService('hello world') === null);
  check('numeric input passes through', parseYearsOfService(4.2)?.value === 4.2);

  // ---- Test 2: computeAgeFromDOB / parseAgeText ----
  console.log('\nTest 2 — age computation');
  check('DOB→age (birthday already passed)', computeAgeFromDOB('1980-03-15', '2026-04-26') === 46);
  check('DOB→age (birthday not yet)', computeAgeFromDOB('1980-12-31', '2026-04-26') === 45);
  check('DOB→age same-month-day', computeAgeFromDOB('1980-04-26', '2026-04-26') === 46);
  check('parseAgeText numeric "32"', parseAgeText('32') === 32);
  check('parseAgeText word "thirty-two"', parseAgeText('thirty-two') === 32);
  check('parseAgeText "50 years old"', parseAgeText('50 years old') === 50);
  check('parseAgeText returns null on garbage', parseAgeText('not a number') === null);

  // ---- Test 3: classifyPositionBand ----
  console.log('\nTest 3 — classifyPositionBand (7 bands)');
  const bandTests: Array<[string, PositionBand]> = [
    ['Chief Technology Officer', 'executive'],
    ['VP of Sales', 'executive'],
    ['Director of Operations', 'management'],
    ['Senior Director of Finance', 'management'],
    ['Operations Manager', 'management'],
    ['Senior Account Manager', 'management'],   // manager pattern wins over senior
    ['Senior Software Developer', 'senior'],
    ['Software Developer', 'specialized-professional'],
    ['Project Engineer', 'specialized-professional'],
    ['Account Manager', 'mid-level'],
    ['Junior Bookkeeper', 'junior'],
    ['Customer Service Representative', 'entry-level'],
    ['Receptionist', 'entry-level'],
  ];
  for (const [title, expected] of bandTests) {
    const got = classifyPositionBand(title);
    check(`"${title}" → ${expected}`, got === expected, `got ${got}`);
  }
  check('null input → unclassified', classifyPositionBand(null) === 'unclassified');
  check('empty string → unclassified', classifyPositionBand('') === 'unclassified');

  // ---- Test 4: mapClioStageToAnalytical ----
  console.log('\nTest 4 — mapClioStageToAnalytical (14 labels → 6 analytical stages)');
  const stageTests: Array<[string, AnalyticalStage]> = [
    ['No Stage Assigned', 'intake'],
    ['Newly Added', 'intake'],
    ['File Opened', 'intake'],
    ['Demand Letter', 'demand'],
    ['Prepare Claim', 'demand_to_conference_transition'],
    ['Defence Filed', 'conference'],
    ['Settlement Conference Scheduled', 'conference'],
    ['In Negotiations', 'conference'],
    ['Set for Trial', 'trial'],
    ['Awaiting Trial', 'trial'],
    ['Trial Scheduled', 'trial'],
    ['Settled', 'settled_terminal'],
    ['Billed', 'post_resolution'],
    ['To Close', 'post_resolution'],
  ];
  for (const [label, expected] of stageTests) {
    check(`"${label}" → ${expected}`, mapClioStageToAnalytical(label) === expected);
  }
  check('undefined → intake (default)', mapClioStageToAnalytical(undefined) === 'intake');

  // ---- Test 5: detectEdgeCases ----
  console.log('\nTest 5 — detectEdgeCases');
  const constructive: MatterInput = {
    custom_fields: { reason_for_termination: 'constructive dismissal — employer relocated employee' },
    documents: {},
  };
  check('constructive_dismissal flagged via reason text',
    detectEdgeCases(constructive).includes('constructive_dismissal'));
  const contractor: MatterInput = {
    custom_fields: { reason_for_termination: 'characterization disputed — independent contractor designation' },
    documents: {},
  };
  check('contractor_vs_employee flagged',
    detectEdgeCases(contractor).includes('contractor_vs_employee'));
  const partialMit: MatterInput = {
    custom_fields: { mitigation_status: 'Partial mitigation: substitute role at lower compensation' },
    documents: {},
  };
  check('partial_mitigation flagged',
    detectEdgeCases(partialMit).includes('partial_mitigation'));

  // ---- Test 6: end-to-end against W4 fixtures ----
  console.log('\nTest 6 — end-to-end against W4 fixture set');
  const fixturesDir = process.env.PJHB_FIXTURES_DIR;
  if (!fixturesDir || !existsSync(fixturesDir)) {
    console.warn('  [SKIP] Test 6 — set PJHB_FIXTURES_DIR to fixture directory');
  } else {
    const files = readdirSync(fixturesDir).filter(f => /^F\d+_.*\.md$/.test(f));
    check('found 12 fixtures', files.length === 12, `got ${files.length}`);

    let perFactorMatches = {
      length_of_employment: 0,
      age: 0,
      position_band: 0,
      mitigation: 0,
    };
    let perStageCounts = { demand: 0, conference: 0, trial: 0 };
    let perChronoCounts = { older: 0, current: 0, newest: 0 };
    let perBandCounts = { RED: 0, YELLOW: 0, GREEN: 0, 'EDGE-CASE': 0 };
    let edgeCaseHits = { constructive_dismissal: 0, contractor_vs_employee: 0, partial_mitigation: 0 };
    let allConfidences: number[] = [];

    for (const fname of files.sort()) {
      const fixture = loadFixture(join(fixturesDir, fname));
      const input = fixtureToMatterInput(fixture);
      const result = extractBardalFactors(input);
      // Per-factor accuracy vs. ground truth from frontmatter
      const expectedYears = fixture.meta.years_of_service as number | undefined;
      if (typeof expectedYears === 'number' &&
          typeof result.primary_factors.length_of_employment.value === 'number' &&
          Math.abs(result.primary_factors.length_of_employment.value - expectedYears) < 0.5) {
        perFactorMatches.length_of_employment++;
      }
      const expectedAge = fixture.meta.age as number | undefined;
      if (typeof expectedAge === 'number' &&
          typeof result.primary_factors.age.value === 'number' &&
          Math.abs(result.primary_factors.age.value - expectedAge) <= 1) {
        perFactorMatches.age++;
      }
      const expectedPosition = fixture.meta.position as string | undefined;
      if (typeof expectedPosition === 'string' &&
          result.primary_factors.position_character.value?.raw === expectedPosition &&
          result.primary_factors.position_character.value?.band !== 'unclassified') {
        perFactorMatches.position_band++;
      }
      const expectedMitig = fixture.meta.mitigation_status as string | undefined;
      if (typeof expectedMitig === 'string' &&
          result.primary_factors.comparable_employment.value?.status === expectedMitig) {
        perFactorMatches.mitigation++;
      }
      // Stage / band / chronology coverage. Map fixture frontmatter labels
      // ('demand-letter' / 'settlement-conference' / 'trial') onto the test
      // counter keys ('demand' / 'conference' / 'trial').
      const stageKey: 'demand'|'conference'|'trial' =
        fixture.meta.stage === 'demand-letter' ? 'demand'
        : fixture.meta.stage === 'settlement-conference' ? 'conference'
        : 'trial';
      perStageCounts[stageKey]++;
      perChronoCounts[fixture.meta.chronology_bucket]++;
      perBandCounts[fixture.meta.risk_band]++;
      // Edge-case verification
      if (fixture.meta.risk_band === 'EDGE-CASE') {
        for (const f of result.edge_case_flags) {
          edgeCaseHits[f]++;
        }
      }
      // Confidence collection
      allConfidences.push(
        result.primary_factors.length_of_employment.extraction_confidence,
        result.primary_factors.age.extraction_confidence,
        result.primary_factors.position_character.extraction_confidence,
        result.primary_factors.comparable_employment.extraction_confidence,
      );
    }

    check('length_of_employment matched ≥ 60% of fixtures',
      perFactorMatches.length_of_employment >= Math.ceil(files.length * 0.6),
      `${perFactorMatches.length_of_employment}/${files.length}`);
    check('age matched ≥ 60% of fixtures',
      perFactorMatches.age >= Math.ceil(files.length * 0.6),
      `${perFactorMatches.age}/${files.length}`);
    check('position_band matched ≥ 60% of fixtures',
      perFactorMatches.position_band >= Math.ceil(files.length * 0.6),
      `${perFactorMatches.position_band}/${files.length}`);
    check('mitigation matched ≥ 60% of fixtures',
      perFactorMatches.mitigation >= Math.ceil(files.length * 0.6),
      `${perFactorMatches.mitigation}/${files.length}`);
    check('stage coverage 4/4/4',
      perStageCounts.demand === 4 && perStageCounts.conference === 4 && perStageCounts.trial === 4,
      JSON.stringify(perStageCounts));
    check('chronology coverage 4/4/4',
      perChronoCounts.older === 4 && perChronoCounts.current === 4 && perChronoCounts.newest === 4,
      JSON.stringify(perChronoCounts));
    check('band coverage 3/3/3/3',
      perBandCounts.RED === 3 && perBandCounts.YELLOW === 3 &&
      perBandCounts.GREEN === 3 && perBandCounts['EDGE-CASE'] === 3,
      JSON.stringify(perBandCounts));
    check('at least one constructive_dismissal flagged across edge fixtures',
      edgeCaseHits.constructive_dismissal >= 1);
    check('at least one contractor_vs_employee flagged',
      edgeCaseHits.contractor_vs_employee >= 1);
    check('at least one partial_mitigation flagged',
      edgeCaseHits.partial_mitigation >= 1);

    // ---- Test 7: confidence-distribution sanity ----
    console.log('\nTest 7 — confidence-distribution sanity');
    const allOnes = allConfidences.every(c => c === 1.0);
    check('NOT every confidence is 1.0 (overconfidence guard)', !allOnes);
    const min = Math.min(...allConfidences);
    const max = Math.max(...allConfidences);
    check('confidence range spans [0.0, 1.0]', min >= 0 && max <= 1.0);
    check('confidence variance present (max - min >= 0.1)',
      max - min >= 0.1, `range ${min}-${max}`);

    // ---- Test 8: round-trip stability ----
    console.log('\nTest 8 — round-trip stability (extract → JSON → parse → extract → match)');
    const sampleFixture = loadFixture(join(fixturesDir, files.sort()[0]));
    const input = fixtureToMatterInput(sampleFixture);
    const r1 = extractBardalFactors(input);
    const json = JSON.stringify(r1);
    const r1Back: typeof r1 = JSON.parse(json);
    const r2 = extractBardalFactors(input);
    // Compare the structural primary_factors values (timestamps differ)
    check('round-trip primary length matches',
      r1Back.primary_factors.length_of_employment.value === r2.primary_factors.length_of_employment.value);
    check('round-trip primary age matches',
      r1Back.primary_factors.age.value === r2.primary_factors.age.value);
    check('round-trip primary position matches',
      JSON.stringify(r1Back.primary_factors.position_character.value) ===
      JSON.stringify(r2.primary_factors.position_character.value));
    check('round-trip primary mitigation matches',
      JSON.stringify(r1Back.primary_factors.comparable_employment.value) ===
      JSON.stringify(r2.primary_factors.comparable_employment.value));
  }

  // ---- Test 9: terminology grep — "Notice Given" appears nowhere ----
  console.log('\nTest 9 — terminology grep: Notice Given absent from extractor source');
  const extractorSrc = readFileSync(
    new URL('../extractors/bardalExtractor.ts', import.meta.url),
    'utf8',
  );
  check('extractor source does NOT contain "Notice Given"',
    !/notice\s+given/i.test(extractorSrc));
  // Also assert the canonical assertion in the output type
  check('extractor output asserts notice_terminology = "notice_offered"',
    /notice_terminology:\s*['"]notice_offered['"]/.test(extractorSrc));

  // ---- Test 10: extractor version constant ----
  console.log('\nTest 10 — extractor metadata');
  check('EXTRACTOR_VERSION exists and is a string', typeof EXTRACTOR_VERSION === 'string' && EXTRACTOR_VERSION.length > 0);

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
