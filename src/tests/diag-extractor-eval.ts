/**
 * Pass 6b W5a — diagnostic dump: run the Bardal extractor against the 12
 * W4 fixtures and emit a per-fixture summary for the evaluation report.
 *
 * Pass 7 revision: fixture parsing moved to the shared fixtureLoader,
 * fixing two latent Pass 6b bugs — the loader passed `clio_stage_label`
 * where MatterInput declares `current_clio_stage` (so the analytical stage
 * silently defaulted for every fixture), and the summary read
 * `result.analytical_stage`, which does not exist on BardalAnalysis
 * (`current_analytical_stage` does). Pass 7 also appends the settlement
 * calculator's outputs per fixture.
 *
 * Not a unit test. Run via:
 *   PJHB_FIXTURES_DIR=<W4 fixtures dir> bun run src/tests/diag-extractor-eval.ts > eval.json
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { extractBardalFactors, EXTRACTOR_VERSION } from '../extractors/bardalExtractor';
import { calculateSettlement, CALCULATOR_VERSION } from '../calculator/settlementCalculator';
import { loadFixture } from './fixtureLoader';

const fixturesDir = process.env.PJHB_FIXTURES_DIR;
if (!fixturesDir) { console.error('Set PJHB_FIXTURES_DIR'); process.exit(1); }

const files = readdirSync(fixturesDir).filter(f => /^F\d+_.*\.md$/.test(f)).sort();
const summary: Array<Record<string, unknown>> = [];

for (const f of files) {
  const { meta, input } = loadFixture(join(fixturesDir, f));
  const result = extractBardalFactors(input);
  const estimate = calculateSettlement(result);
  summary.push({
    fixture: f,
    fixture_id: meta.fixture_id,
    expected: {
      stage: meta.stage,
      risk_band: meta.risk_band,
      chronology: meta.chronology_bucket,
      years_of_service: meta.years_of_service,
      age: meta.age,
      position: meta.position,
      mitigation_status: meta.mitigation_status,
    },
    extracted: {
      analytical_stage: result.current_analytical_stage,
      length: result.primary_factors.length_of_employment.value,
      length_conf: result.primary_factors.length_of_employment.extraction_confidence,
      age: result.primary_factors.age.value,
      age_conf: result.primary_factors.age.extraction_confidence,
      position_band: (result.primary_factors.position_character.value as { band: string } | null)?.band,
      position_conf: result.primary_factors.position_character.extraction_confidence,
      mitigation_status: (result.primary_factors.comparable_employment.value as { status: string } | null)?.status,
      mitigation_conf: result.primary_factors.comparable_employment.extraction_confidence,
      edge_flags: result.edge_case_flags,
    },
    calculated: {
      risk_band: estimate.risk_band.band,
      band_elevated_by_conflict: estimate.risk_band.elevated_by_conflict,
      notice_weeks_mid: estimate.notice?.weeks_mid ?? null,
      trial_level_value: estimate.trial_level_value,
      settlement_mid: estimate.settlement_estimate?.mid ?? null,
      conflicts: estimate.conflicts.map(c => `${c.field}: ${c.detail}`),
      review_required: estimate.paralegal_review_required,
      driving_confidence: estimate.driving_confidence,
    },
  });
}

console.log(JSON.stringify(
  { extractor_version: EXTRACTOR_VERSION, calculator_version: CALCULATOR_VERSION, count: files.length, fixtures: summary },
  null, 2,
));
