/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — shared W4 fixture loader (Pass 7).
 *
 * Single source of truth for parsing the synthetic case-file fixtures
 * (F01..F12) into a MatterInput. Extracted from diag-extractor-eval.ts,
 * which carried two latent bugs now fixed here:
 *   - it passed `clio_stage_label` where MatterInput declares
 *     `current_clio_stage`, so every fixture's analytical stage silently
 *     fell back to the no-stage default;
 *   - its summary read `result.analytical_stage`, which does not exist on
 *     BardalAnalysis (`current_analytical_stage` does).
 */

import { readFileSync } from 'fs';
import type { MatterInput } from '../extractors/bardalExtractor';

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const m = /^(\s*)([\w_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1]!.length > 0) continue;
    const key = m[2]!;
    let val: unknown = m[3]!.trim();
    if (val === '' || val === 'null' || val === '~') { val = null; }
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
    else if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/** Fixture `stage:` frontmatter value → the firm's Clio stage label. */
export const FIXTURE_STAGE_TO_CLIO_LABEL: Record<string, string> = {
  'demand-letter': 'Demand Letter',
  'settlement-conference': 'Settlement Conference Scheduled',
  trial: 'Awaiting Trial',
};

export interface LoadedFixture {
  meta: Record<string, unknown>;
  input: MatterInput;
}

export function loadFixture(filePath: string): LoadedFixture {
  const raw = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`No frontmatter in ${filePath}`);
  const meta = parseSimpleYaml(m[1]!);
  const body = m[2]!;

  const documents: MatterInput['documents'] = {};
  for (const s of body.split(/\n## /)) {
    const norm = s.trim();
    if (norm.startsWith('Letter of Termination')) documents.termination_letter = norm;
    else if (norm.startsWith('Employment contract')) documents.employment_contract = norm;
    else if (norm.startsWith('Demand Letter')) documents.demand_letter = norm;
    else if (norm.startsWith('Settlement-conference notes')) documents.settlement_conference_notes = norm;
    else if (norm.startsWith('Trial-judgment summary')) documents.trial_judgment = norm;
  }

  const skipKeys = new Set([
    'fixture_id', 'synthetic', 'generator', 'generator_seed',
    'stage', 'risk_band', 'chronology_bucket',
    'client_name_synthetic', 'employer_synthetic', 'practice_area',
  ]);
  const custom_fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (skipKeys.has(k) || k.startsWith('expected_extraction_confidence_')) continue;
    custom_fields[k] = v;
  }

  const input: MatterInput = {
    matter_id: meta.fixture_id as string,
    custom_fields,
    documents,
    current_clio_stage: FIXTURE_STAGE_TO_CLIO_LABEL[String(meta.stage)] ?? 'No Stage Assigned',
  };

  return { meta, input };
}
