/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — extractBardalFactors (Pass 6b W1).
 *
 * Implements the Pass 5 W4 schema, anchored on real Clio Manage field
 * names from the schema snapshot. Four primary Bardal factors:
 *   1. length_of_employment      ← Clio Years of Service (id 9455616)
 *   2. age                       ← Date of Birth (9637746) + Age (10158109)
 *   3. position_character        ← Position (9455586) → 7-band classifier
 *   4. comparable_employment     ← Mitigation Status / Salary / Start / End
 *
 * Plus four non-Bardal entity extractors:
 *   - opposing_counsel (Adverse Party + contact set)
 *   - judge
 *   - monetary_amounts (Demand / Settled / WDD Multiplier)
 *   - key_dates (Termination Date / Start Date / Litigation Start Date / Settled Date)
 *
 * Plus the 14-stage → 3-stage analytical mapping per Pass 6b CORRECTION 1.
 *
 * TERMINOLOGY: "Notice Offered" is the canonical Bardal field name in
 * the alpha firm's Clio schema (Pass 6b CORRECTION 2). The reverse-
 * direction phrasing ("Notice" + "G" + "iven") must NOT appear anywhere
 * in this file's source, schema, or output. A grep test in
 * src/tests/test-bardalExtractor.ts enforces this.
 */

// ---- Types ----------------------------------------------------------

export type AnalyticalStage =
  | 'intake'
  | 'demand'
  | 'demand_to_conference_transition'
  | 'conference'
  | 'trial'
  | 'settled_terminal'
  | 'post_resolution';

export type ExtractionMethod = 'structured' | 'body_text' | 'hybrid' | 'absent';

export type PositionBand =
  | 'entry-level'
  | 'junior'
  | 'mid-level'
  | 'senior'
  | 'management'
  | 'executive'
  | 'specialized-professional'
  | 'unclassified';

export type NegativeSignalFlag =
  | 'opposing_counsel_unreasonable'
  | 'client_changed_mind'
  | 'insufficient_documentation'
  | 'opposing_party_no_funds'
  | 'strategic_proceed_to_trial'
  | 'other';

export type EdgeCaseFlag =
  | 'contractor_vs_employee'
  | 'partial_mitigation'
  | 'constructive_dismissal';

export interface FactorOutput<T = unknown> {
  value: T | null;
  extraction_confidence: number;        // 0.0–1.0
  extraction_method: ExtractionMethod;
  source_doc_ref: string[];             // Which input documents contributed
  needs_paralegal_review: boolean;      // True if confidence < 0.7
  notes?: string;
}

export interface PerStageSnapshot {
  stage: 'demand' | 'conference' | 'trial';
  length_of_employment: FactorOutput<number>;
  age: FactorOutput<number>;
  position_character: FactorOutput<{ raw: string; band: PositionBand }>;
  comparable_employment: FactorOutput<{
    status: string | null;
    mitigation_salary: number | null;
    mitigation_start: string | null;
    mitigation_end: string | null;
  }>;
}

export interface OpposingCounselOutput {
  adverse_party: FactorOutput<string>;
}

export interface JudgeOutput {
  identified: FactorOutput<string>;
}

export interface MonetaryAmountsOutput {
  demand_amount: FactorOutput<number>;
  settled_amount: FactorOutput<number>;
  notice_offered_weeks: FactorOutput<number>;     // Pass 6b CORRECTION 2: "Notice Offered" canonical
  wdd_multiplier: FactorOutput<number>;
  annual_salary: FactorOutput<number>;
}

export interface KeyDatesOutput {
  termination_date: FactorOutput<string>;
  start_date: FactorOutput<string>;
  litigation_start_date: FactorOutput<string>;
  settled_date: FactorOutput<string>;
}

export interface BardalAnalysis {
  matter_id?: string;
  current_clio_stage: string | null;
  current_analytical_stage: AnalyticalStage;
  per_stage_snapshots: PerStageSnapshot[];   // For demand / conference / trial as applicable
  // Top-level current view (the snapshot for current_analytical_stage if it
  // maps to one of the three Bardal stages, else the latest of the three)
  primary_factors: PerStageSnapshot;
  opposing_counsel: OpposingCounselOutput;
  judge: JudgeOutput;
  monetary_amounts: MonetaryAmountsOutput;
  key_dates: KeyDatesOutput;
  edge_case_flags: EdgeCaseFlag[];
  negative_signal_flags: NegativeSignalFlag[];
  needs_paralegal_review: boolean;            // True if any factor needs review
  extraction_meta: {
    timestamp: string;
    extractor_version: string;
    notice_terminology: 'notice_offered';     // Asserted, never 'notice_given'
  };
}

export interface MatterInput {
  matter_id?: string;
  /**
   * Structured Clio Manage custom-field values, keyed by canonical_name
   * (the slug from fieldMapping.json). Reflects what Clio currently has
   * stored on the matter.
   */
  custom_fields: Record<string, unknown>;
  /**
   * Documents associated with the matter, keyed by document role.
   * Bodies are plain text.
   */
  documents: {
    termination_letter?: string;
    employment_contract?: string;
    demand_letter?: string;
    settlement_conference_notes?: string;
    trial_judgment?: string;
  };
  /**
   * Current Clio stage label (one of the 14 from the snapshot).
   * Used to derive current_analytical_stage via mapClioStageToAnalytical().
   */
  current_clio_stage?: string;
}

// ---- Stage mapping --------------------------------------------------

/**
 * Pass 6b CORRECTION 1: Clio Stages are flat labels, not a workflow. Map
 * the 14 labels onto the 3-stage analytical model used by the calculator.
 */
export function mapClioStageToAnalytical(clioStage: string | undefined | null): AnalyticalStage {
  if (!clioStage) return 'intake';
  const norm = clioStage.trim().toLowerCase();
  switch (norm) {
    case 'no stage assigned':
    case 'newly added':
    case 'file opened':
      return 'intake';
    case 'demand letter':
      return 'demand';
    case 'prepare claim':
      return 'demand_to_conference_transition';
    case 'defence filed':
    case 'settlement conference scheduled':
    case 'in negotiations':
      return 'conference';
    case 'set for trial':
    case 'awaiting trial':
    case 'trial scheduled':
      return 'trial';
    case 'settled':
      return 'settled_terminal';
    case 'billed':
    case 'to close':
      return 'post_resolution';
    default:
      return 'intake'; // conservative default for any unknown label
  }
}

// ---- Position band classifier (Pass 5.5 PR1 7-band) ----------------

const POSITION_BAND_RULES: Array<{ band: PositionBand; patterns: RegExp[] }> = [
  {
    band: 'executive',
    patterns: [
      /\bchief\s+\w+\s+officer\b/i,
      /\bC[EFOTM]O\b/,
      /\b(president|vice[\s-]president|VP)\b/i,
      /\b(general|managing)\s+(counsel|partner|director)\b/i,
      /\bregional\s+managing\b/i,
    ],
  },
  {
    band: 'management',
    patterns: [
      /\bdirector\s+of\b/i,
      /\bsenior\s+director\b/i,
      // "Senior X Manager" elevates an otherwise mid-level role to management
      // (e.g. "Senior Account Manager" → management even though plain
      // "Account Manager" is mid-level).
      /\bsenior\s+\w+\s+manager\b/i,
      // \bmanager\b but NOT plain "account manager" / "project manager" —
      // those are individual-contributor mid-level roles in Pass 5.5 PR1's
      // taxonomy. Variable-width lookbehind is supported by V8/Bun.
      /(?<!\b(?:account|project)\s)\bmanager\b/i,
      /\bsupervisor\b/i,
      /\bteam\s+lead\b/i,
      /\bforeman\b/i,
    ],
  },
  {
    band: 'senior',
    patterns: [
      /\bsenior\s+\w+/i,
      /\blead\s+\w+/i,
      /\bprincipal\s+\w+/i,
      /\bspecialist\b/i,
    ],
  },
  {
    band: 'specialized-professional',
    patterns: [
      /\b(software\s+developer|engineer|architect|analyst)\b/i,
      /\b(accountant|controller|paralegal|legal\s+assistant)\b/i,
      /\b(designer|consultant)\b/i,
      /\b(physician|doctor|nurse|dentist|surgeon)\b/i,
    ],
  },
  {
    band: 'mid-level',
    patterns: [
      /\bcoordinator\b/i,
      /\b(account|project)\s+manager\b/i,
      /\b(business\s+partner|partner)\b/i,
      /\b(administrator|administrative\s+\w+)\b/i,
    ],
  },
  {
    band: 'junior',
    patterns: [
      /\bjunior\s+\w+/i,
      /\bassociate\b/i,
      /\bassistant\b/i,
      /\btrainee\b/i,
      /\bapprentice\b/i,
    ],
  },
  {
    band: 'entry-level',
    patterns: [
      /\b(receptionist|cashier|clerk)\b/i,
      /\b(driver|warehouse\s+\w+|labourer|labor(er)?)\b/i,
      /\b(customer\s+service\s+representative|representative)\b/i,
      /\bbookkeeper\b/i,
    ],
  },
];

export function classifyPositionBand(rawText: string | null | undefined): PositionBand {
  if (!rawText || typeof rawText !== 'string') return 'unclassified';
  for (const rule of POSITION_BAND_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(rawText)) return rule.band;
    }
  }
  return 'unclassified';
}

// ---- Years-of-service text → decimal transformer --------------------

/**
 * Parse Clio's free-text "Years of Service" into a decimal years value.
 * Handles: numeric ("3.5"), numeric+unit ("3.5 years"), word-form
 * ("two years"), and "X years Y months" patterns.
 */
const WORD_TO_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50,
};

export function parseYearsOfService(input: unknown): { value: number; confidence: number } | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && isFinite(input)) {
    return { value: input, confidence: 0.98 };
  }
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === '') return null;

  // Numeric prefix: "3.5", "3.5 years", "3 years 6 months"
  const numMatch = /^(\d+(?:\.\d+)?)\s*(?:year|yr)s?\b/.exec(s);
  if (numMatch) {
    let years = parseFloat(numMatch[1]);
    const monthsMatch = /(\d+)\s*month/.exec(s);
    if (monthsMatch) years += parseInt(monthsMatch[1], 10) / 12;
    return { value: parseFloat(years.toFixed(2)), confidence: 0.95 };
  }

  // Bare numeric: "3.5"
  const bareNum = /^\d+(?:\.\d+)?$/.exec(s);
  if (bareNum) return { value: parseFloat(s), confidence: 0.85 };

  // Word-form years: "two years", "twenty-five years six months"
  const wordRe = /^([a-z]+)(?:[\s-]([a-z]+))?\s*years?\b/.exec(s);
  if (wordRe) {
    const w1 = WORD_TO_NUM[wordRe[1]];
    const w2 = wordRe[2] ? WORD_TO_NUM[wordRe[2]] : undefined;
    if (typeof w1 === 'number') {
      let years = w1 + (typeof w2 === 'number' ? w2 : 0);
      const monthsMatch = /(\d+|[a-z]+)\s*month/.exec(s);
      if (monthsMatch) {
        const mNum = /^\d+$/.test(monthsMatch[1])
          ? parseInt(monthsMatch[1], 10)
          : (WORD_TO_NUM[monthsMatch[1]] ?? 0);
        years += mNum / 12;
      }
      return { value: parseFloat(years.toFixed(2)), confidence: 0.80 };
    }
  }
  return null;
}

// ---- Age computation -----------------------------------------------

export function computeAgeFromDOB(dob: string, asOf: string): number | null {
  try {
    const [dy, dm, dd] = dob.split('-').map(Number);
    const [ay, am, ad] = asOf.split('-').map(Number);
    if (!dy || !dm || !dd || !ay || !am || !ad) return null;
    let age = ay - dy;
    if (am < dm || (am === dm && ad < dd)) age -= 1;
    if (age < 0 || age > 130) return null;
    return age;
  } catch {
    return null;
  }
}

export function parseAgeText(input: unknown): number | null {
  if (typeof input === 'number' && isFinite(input)) {
    const n = Math.round(input);
    return n >= 0 && n <= 130 ? n : null;
  }
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  // Numeric: "32", "32 years old"
  const num = /^(\d+)/.exec(s);
  if (num) {
    const n = parseInt(num[1], 10);
    return n >= 0 && n <= 130 ? n : null;
  }
  // Word-form: "thirty-two"
  const wordRe = /^([a-z]+)(?:[\s-]([a-z]+))?/.exec(s);
  if (wordRe) {
    const w1 = WORD_TO_NUM[wordRe[1]];
    const w2 = wordRe[2] ? WORD_TO_NUM[wordRe[2]] : 0;
    if (typeof w1 === 'number') {
      const n = w1 + (typeof w2 === 'number' ? w2 : 0);
      return n >= 0 && n <= 130 ? n : null;
    }
  }
  return null;
}

// ---- Edge-case detection -------------------------------------------

export function detectEdgeCases(input: MatterInput): EdgeCaseFlag[] {
  const flags: EdgeCaseFlag[] = [];
  const reason = String(input.custom_fields.reason_for_termination ?? '').toLowerCase();
  const termLetter = (input.documents.termination_letter ?? '').toLowerCase();
  const contract = (input.documents.employment_contract ?? '').toLowerCase();
  const allText = `${reason} ${termLetter} ${contract}`;

  if (/constructive\s+dismissal/.test(allText) || /relocated\s+\w+\s+to/.test(allText)) {
    flags.push('constructive_dismissal');
  }
  if (/independent\s+contractor/.test(allText) || /characterization\s+disputed/.test(allText)) {
    flags.push('contractor_vs_employee');
  }
  // Partial mitigation: status text mentions partial / lower / lesser
  const mitigStatus = String(input.custom_fields.mitigation_status ?? '').toLowerCase();
  if (/partial/.test(mitigStatus) || /lesser\s+role/.test(mitigStatus) ||
      /lower\s+(?:compensation|comp|pay|salary)/.test(mitigStatus)) {
    flags.push('partial_mitigation');
  }
  return flags;
}

// ---- Helper: build a FactorOutput ----------------------------------

function makeFactor<T>(
  value: T | null,
  confidence: number,
  method: ExtractionMethod,
  source_doc_ref: string[],
  notes?: string,
): FactorOutput<T> {
  return {
    value,
    extraction_confidence: confidence,
    extraction_method: method,
    source_doc_ref,
    needs_paralegal_review: confidence < 0.7,
    notes,
  };
}

// ---- Per-factor extractors -----------------------------------------

function extractLengthOfEmployment(input: MatterInput): FactorOutput<number> {
  const raw = input.custom_fields.years_of_service;
  const parsed = parseYearsOfService(raw);
  if (parsed) {
    return makeFactor(parsed.value, parsed.confidence, 'structured', ['custom_fields.years_of_service']);
  }
  // Fallback: scan body text for "X years" patterns
  const bodies = Object.entries(input.documents)
    .filter(([_, v]) => typeof v === 'string')
    .map(([k, v]) => ({ key: k, text: v as string }));
  for (const { key, text } of bodies) {
    const m = /\b(\d+(?:\.\d+)?)\s*years?\s+(?:of|at)\b/i.exec(text);
    if (m) {
      return makeFactor(parseFloat(m[1]), 0.55, 'body_text', [`documents.${key}`],
        'Body-text fallback; consider re-asking client for exact tenure.');
    }
  }
  return makeFactor<number>(null, 0, 'absent', [],
    'No years_of_service field; no recoverable years pattern in document bodies.');
}

function extractAge(input: MatterInput): FactorOutput<number> {
  const dob = input.custom_fields.date_of_birth;
  const ageRaw = input.custom_fields.age;
  const termDate = input.custom_fields.termination_date as string | undefined;
  // Path 1: DOB + termination date
  if (typeof dob === 'string' && typeof termDate === 'string') {
    const computed = computeAgeFromDOB(dob, termDate);
    if (computed !== null) {
      const ageFromText = typeof ageRaw === 'string' || typeof ageRaw === 'number'
        ? parseAgeText(ageRaw) : null;
      // If both DOB-derived and text-form-Age agree (±1), high confidence.
      if (ageFromText !== null && Math.abs(ageFromText - computed) <= 1) {
        return makeFactor(computed, 0.97, 'structured',
          ['custom_fields.date_of_birth', 'custom_fields.termination_date', 'custom_fields.age']);
      }
      return makeFactor(computed, 0.92, 'structured',
        ['custom_fields.date_of_birth', 'custom_fields.termination_date']);
    }
  }
  // Path 2: Age field only
  const ageOnly = parseAgeText(ageRaw);
  if (ageOnly !== null) {
    return makeFactor(ageOnly, 0.78, 'structured', ['custom_fields.age']);
  }
  // Path 3: body-text scan
  for (const [key, body] of Object.entries(input.documents)) {
    if (typeof body !== 'string') continue;
    const m = /\b(\d{2})\s*years?\s*old\b/i.exec(body);
    if (m) {
      return makeFactor(parseInt(m[1], 10), 0.55, 'body_text', [`documents.${key}`]);
    }
  }
  return makeFactor<number>(null, 0, 'absent', [], 'No DOB, no Age, no body-text age reference.');
}

function extractPositionCharacter(input: MatterInput): FactorOutput<{ raw: string; band: PositionBand }> {
  const raw = input.custom_fields.position;
  if (typeof raw === 'string' && raw.length > 0) {
    const band = classifyPositionBand(raw);
    const conf = band === 'unclassified' ? 0.55 : 0.92;
    return makeFactor(
      { raw, band },
      conf,
      'structured',
      ['custom_fields.position'],
      band === 'unclassified' ? 'Position text did not match any of the 7 bands; paralegal classifies manually.' : undefined,
    );
  }
  return makeFactor<{ raw: string; band: PositionBand }>(
    null, 0, 'absent', [], 'No position field.');
}

function extractComparableEmployment(input: MatterInput): FactorOutput<{
  status: string | null;
  mitigation_salary: number | null;
  mitigation_start: string | null;
  mitigation_end: string | null;
}> {
  const status = input.custom_fields.mitigation_status as string | undefined;
  const salaryRaw = input.custom_fields.mitigation_salary;
  const start = input.custom_fields.mitigation_start as string | undefined;
  const end = input.custom_fields.mitigation_end as string | undefined;

  const salary = typeof salaryRaw === 'number' ? salaryRaw
    : (typeof salaryRaw === 'string' && /^\d+(\.\d+)?$/.test(salaryRaw) ? parseFloat(salaryRaw) : null);

  if (status) {
    const populatedCount = [salary, start, end].filter(v => v !== null && v !== undefined).length;
    // Status alone → 0.78. Status + 1 detail → 0.85. Status + ≥2 details → 0.92.
    const conf = populatedCount >= 2 ? 0.92 : populatedCount === 1 ? 0.85 : 0.78;
    return makeFactor(
      {
        status,
        mitigation_salary: salary,
        mitigation_start: start ?? null,
        mitigation_end: end ?? null,
      },
      conf,
      'structured',
      ['custom_fields.mitigation_status', 'custom_fields.mitigation_salary',
       'custom_fields.mitigation_start', 'custom_fields.mitigation_end']
        .filter((_, i) => [status, salary, start, end][i] !== null && [status, salary, start, end][i] !== undefined),
    );
  }
  return makeFactor<{
    status: string | null; mitigation_salary: number | null;
    mitigation_start: string | null; mitigation_end: string | null;
  }>(null, 0, 'absent', [], 'No mitigation_status. Treat as "no mitigation reported".');
}

function buildSnapshot(input: MatterInput, stage: 'demand' | 'conference' | 'trial'): PerStageSnapshot {
  // Note: per-stage variation isn't fully implemented in Pass 6b. The
  // structured custom fields are point-in-time current values; per-stage
  // snapshots in real-world data would come from change-history or
  // stage-checkpoints. Pass 7 wires those in. For now, all three snapshots
  // share the same primary-factor values; re-extract per stage for cohesion
  // with the schema contract.
  return {
    stage,
    length_of_employment: extractLengthOfEmployment(input),
    age: extractAge(input),
    position_character: extractPositionCharacter(input),
    comparable_employment: extractComparableEmployment(input),
  };
}

// ---- Non-Bardal entity extractors ----------------------------------

function extractOpposingCounsel(input: MatterInput): OpposingCounselOutput {
  const adverse = input.custom_fields.adverse_party;
  if (typeof adverse === 'string' && adverse.length > 0) {
    return { adverse_party: makeFactor(adverse, 0.92, 'structured', ['custom_fields.adverse_party']) };
  }
  return { adverse_party: makeFactor<string>(null, 0, 'absent', []) };
}

function extractJudge(input: MatterInput): JudgeOutput {
  const judgment = input.documents.trial_judgment;
  if (typeof judgment === 'string') {
    const m = /\b(?:Justice|Judge|J\.)\s+([A-Z][a-zA-Z.\-' ]+)\b/.exec(judgment);
    if (m) {
      return { identified: makeFactor(m[1].trim(), 0.65, 'body_text', ['documents.trial_judgment']) };
    }
  }
  return { identified: makeFactor<string>(null, 0, 'absent', []) };
}

function extractMonetaryAmounts(input: MatterInput): MonetaryAmountsOutput {
  const cf = input.custom_fields;
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v
      : (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? parseFloat(v) : null);

  const dem = num(cf.demand_amount);
  const sett = num(cf.settled_amount);
  const notice = num(cf.notice_offered);  // Pass 6b CORRECTION 2: notice_offered canonical
  const wdd = num(cf.wdd_multiplier);
  const sal = num(cf.annual_salary);

  return {
    demand_amount: dem !== null
      ? makeFactor(dem, 0.95, 'structured', ['custom_fields.demand_amount'])
      : makeFactor<number>(null, 0, 'absent', []),
    settled_amount: sett !== null
      ? makeFactor(sett, 0.95, 'structured', ['custom_fields.settled_amount'])
      : makeFactor<number>(null, 0, 'absent', []),
    notice_offered_weeks: notice !== null
      ? makeFactor(notice, 0.95, 'structured', ['custom_fields.notice_offered'])
      : makeFactor<number>(null, 0, 'absent', []),
    wdd_multiplier: wdd !== null
      ? makeFactor(wdd, 0.95, 'structured', ['custom_fields.wdd_multiplier'])
      : makeFactor<number>(null, 0, 'absent', []),
    annual_salary: sal !== null
      ? makeFactor(sal, 0.95, 'structured', ['custom_fields.annual_salary'])
      : makeFactor<number>(null, 0, 'absent', []),
  };
}

function extractKeyDates(input: MatterInput): KeyDatesOutput {
  const cf = input.custom_fields;
  const dat = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null;

  const term = dat(cf.termination_date);
  const start = dat(cf.start_date);
  const lit = dat(cf.litigation_start_date);
  const settled = dat(cf.settled_date);

  return {
    termination_date: term ? makeFactor(term, 0.95, 'structured', ['custom_fields.termination_date'])
                           : makeFactor<string>(null, 0, 'absent', []),
    start_date: start ? makeFactor(start, 0.95, 'structured', ['custom_fields.start_date'])
                      : makeFactor<string>(null, 0, 'absent', []),
    litigation_start_date: lit ? makeFactor(lit, 0.95, 'structured', ['custom_fields.litigation_start_date'])
                               : makeFactor<string>(null, 0, 'absent', []),
    settled_date: settled ? makeFactor(settled, 0.95, 'structured', ['custom_fields.settled_date'])
                          : makeFactor<string>(null, 0, 'absent', []),
  };
}

// ---- Top-level orchestrator ----------------------------------------

export const EXTRACTOR_VERSION = '0.1.0-pass6b';

export function extractBardalFactors(input: MatterInput): BardalAnalysis {
  const analytical = mapClioStageToAnalytical(input.current_clio_stage);

  const demandSnap = buildSnapshot(input, 'demand');
  const conferenceSnap = buildSnapshot(input, 'conference');
  const trialSnap = buildSnapshot(input, 'trial');

  const per_stage_snapshots: PerStageSnapshot[] = [];
  // Include only the snapshots up through the current analytical stage.
  // Demand-stage matters get only the demand snapshot; conference-stage
  // matters get demand + conference; trial gets all three. Settled
  // and post-resolution states retain whatever stage they reached.
  per_stage_snapshots.push(demandSnap);
  if (analytical === 'conference' || analytical === 'trial' ||
      analytical === 'settled_terminal' || analytical === 'post_resolution') {
    per_stage_snapshots.push(conferenceSnap);
  }
  if (analytical === 'trial' || analytical === 'settled_terminal' ||
      analytical === 'post_resolution') {
    per_stage_snapshots.push(trialSnap);
  }

  const primary_factors = per_stage_snapshots[per_stage_snapshots.length - 1];

  const opposing_counsel = extractOpposingCounsel(input);
  const judge = extractJudge(input);
  const monetary_amounts = extractMonetaryAmounts(input);
  const key_dates = extractKeyDates(input);
  const edge_case_flags = detectEdgeCases(input);

  // Negative-signal flags — body-text patterns
  const negative_signal_flags: NegativeSignalFlag[] = [];
  const conf = (input.documents.settlement_conference_notes ?? '').toLowerCase();
  if (/no settlement\b/.test(conf) || /did not reach agreement/.test(conf)) {
    if (/insufficient\s+document/.test(conf)) negative_signal_flags.push('insufficient_documentation');
    if (/no\s+funds|insolven/.test(conf)) negative_signal_flags.push('opposing_party_no_funds');
    if (/proceed.+trial/.test(conf)) negative_signal_flags.push('strategic_proceed_to_trial');
    if (negative_signal_flags.length === 0) negative_signal_flags.push('other');
  }

  // Aggregate paralegal-review flag
  const allFactors: FactorOutput<unknown>[] = [
    primary_factors.length_of_employment,
    primary_factors.age,
    primary_factors.position_character,
    primary_factors.comparable_employment,
    opposing_counsel.adverse_party,
  ];
  const needs_paralegal_review = allFactors.some(f => f.needs_paralegal_review);

  return {
    matter_id: input.matter_id,
    current_clio_stage: input.current_clio_stage ?? null,
    current_analytical_stage: analytical,
    per_stage_snapshots,
    primary_factors,
    opposing_counsel,
    judge,
    monetary_amounts,
    key_dates,
    edge_case_flags,
    negative_signal_flags,
    needs_paralegal_review,
    extraction_meta: {
      timestamp: new Date().toISOString(),
      extractor_version: EXTRACTOR_VERSION,
      notice_terminology: 'notice_offered',
    },
  };
}
