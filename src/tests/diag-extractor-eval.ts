/**
 * Pass 6b W5a — diagnostic dump: run the Bardal extractor against the 12
 * W4 fixtures and emit a per-fixture summary for the evaluation report.
 *
 * Not a unit test. Run via:
 *   PJHB_FIXTURES_DIR=<W4 fixtures dir> bun run src/tests/diag-extractor-eval.ts > eval.json
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractBardalFactors, EXTRACTOR_VERSION } from '../extractors/bardalExtractor';

function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const m = /^(\s*)([\w_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1].length > 0) continue;
    const key = m[2];
    let val: unknown = m[3].trim();
    if (val === '' || val === 'null' || val === '~') { val = null; }
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
    else if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function loadAndExtract(filePath: string) {
  const raw = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`No frontmatter in ${filePath}`);
  const meta = parseSimpleYaml(m[1]);
  const body = m[2];

  // Build documents map by H2-section split
  const documents: Record<string, string> = {};
  for (const s of body.split(/\n## /)) {
    const norm = s.trim();
    if (norm.startsWith('Letter of Termination')) documents.termination_letter = norm;
    else if (norm.startsWith('Employment contract')) documents.employment_contract = norm;
    else if (norm.startsWith('Demand Letter')) documents.demand_letter = norm;
    else if (norm.startsWith('Settlement-conference notes')) documents.settlement_conference_notes = norm;
    else if (norm.startsWith('Trial-judgment summary')) documents.trial_judgment = norm;
  }

  const skipKeys = new Set([
    'fixture_id','synthetic','generator','generator_seed',
    'stage','risk_band','chronology_bucket',
    'client_name_synthetic','employer_synthetic','practice_area',
  ]);
  const custom_fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (skipKeys.has(k) || k.startsWith('expected_extraction_confidence_')) continue;
    custom_fields[k] = v;
  }

  const clioStageMap: Record<string,string> = {
    'demand-letter': 'Demand Letter',
    'settlement-conference': 'Settlement Conference Scheduled',
    'trial': 'Awaiting Trial',
  };
  const stageRaw = clioStageMap[meta.stage as string] || 'No Stage Assigned';

  const result = extractBardalFactors({
    matter_id: meta.fixture_id as string,
    custom_fields,
    documents,
    clio_stage_label: stageRaw,
  });

  return { meta, result };
}

const fixturesDir = process.env.PJHB_FIXTURES_DIR;
if (!fixturesDir) { console.error('Set PJHB_FIXTURES_DIR'); process.exit(1); }

const files = readdirSync(fixturesDir).filter(f => /^F\d+_.*\.md$/.test(f)).sort();
const summary: Array<Record<string, unknown>> = [];

for (const f of files) {
  const { meta, result } = loadAndExtract(join(fixturesDir, f));
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
      analytical_stage: result.analytical_stage,
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
  });
}

console.log(JSON.stringify({ extractor_version: EXTRACTOR_VERSION, count: files.length, fixtures: summary }, null, 2));
