/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — settlement calculator (Pass 7, calculator-first MVP).
 *
 * The Pass 2.6 charter commitment: the settlement-level calculator is the
 * FIRST MVP deliverable, consuming the Bardal extractor's structured output
 * and producing a median-anchored settlement estimate.
 *
 * Pipeline position:
 *
 *   Clio matter → extractBardalFactors() → BardalAnalysis
 *                                              │
 *                       calculateSettlement(analysis)
 *                                              │
 *          ┌───────────────────────────────────┴──────────────────┐
 *          │ 1. input assembly + inter-source CONFLICT DETECTION  │
 *          │ 2. risk-band triage (red/yellow/green rubric v0.1)   │
 *          │ 3. reasonable-notice band (weeks, low/mid/high)      │
 *          │ 4. trial-level value = notice × weekly salary        │
 *          │ 5. settlement estimate = trial × settlement ratio    │
 *          └──────────────────────────────────────────────────────┘
 *
 * DESIGN CONSTRAINTS (from the workspace acceptance criteria + rubric):
 *
 *  - NOT a legal-judgement engine (W5c §2 anti-acceptance). Every output is
 *    an arithmetic estimate over extracted facts plus a transparent
 *    rationale trail. The paralegal makes the judgement.
 *  - Deterministic. Same input → same output, always. No LLM calls, no
 *    randomness, no clock reads in the estimate itself.
 *  - Transparent. Every adjustment appears in `rationale[]`; every input
 *    echoes back in `inputs_used` with its extraction confidence.
 *  - Calibration-honest. The settlement ratio ships from ONE ground-truth
 *    anchor (Pass 2.6 worked example: settled $13k of $32k trial-level
 *    ≈ 41%, charter framing "~50%"). `calibration.n_points = 1` says so.
 *    Bucket-wise medians from the 463-file corpus replace this table when
 *    the real-data extraction lands (Pass 8+, firm-authorized).
 *  - Rubric thresholds marked [TBD] in the v0.1 rubric are shipped as the
 *    PJHB-proposed defaults and clearly labeled `provisional: true` until
 *    Fuad confirms them at a Friday review.
 */

import type {
  BardalAnalysis,
  PositionBand,
} from '../extractors/bardalExtractor';

export const CALCULATOR_VERSION = '0.1.0-pass7';

export const CALCULATOR_DISCLAIMER =
  'Arithmetic estimate over extracted matter facts. Not legal advice, not a ' +
  'legal-judgement engine; paralegal review required before any client-facing use.';

// ---- Calibration ----------------------------------------------------

export interface CalibrationTable {
  /** Settled amount as a fraction of trial-level value. */
  settlement_ratio: { low: number; mid: number; high: number };
  /** Where the ratios came from. */
  source: string;
  /** Number of ground-truth points behind the ratios. */
  n_points: number;
}

/**
 * Default calibration — single Pass 2.6 worked-example anchor:
 * settled $13,000 of $32,000 trial-level ≈ 0.406, charter framing "~50%".
 * low = the observed anchor, high = the charter framing, mid = midpoint.
 */
export const DEFAULT_CALIBRATION: CalibrationTable = {
  settlement_ratio: { low: 0.41, mid: 0.45, high: 0.5 },
  source:
    'Pass 2.6 worked-example anchor (Fuad deep-dive [41:11]-[41:35]: settled ' +
    '$13k / $32k trial-level) + charter "~50% of trial-level" framing. ' +
    'Replace with bucket-wise medians from the 463-file corpus at Pass 8.',
  n_points: 1,
};

// ---- Risk band (rubric v0.1) ----------------------------------------

export type RiskBand = 'red' | 'yellow' | 'green' | 'not_terminated';

export interface BandTrigger {
  criterion: string;
  provisional: boolean; // true when the threshold is a PJHB-proposed [TBD] default
}

export interface RiskBandResult {
  band: RiskBand;
  triggers: BandTrigger[];
  /** Rubric §6.2: band was raised one level due to inter-source conflict. */
  elevated_by_conflict: boolean;
  /** Rubric §6.3: key inputs unknown → defaulted to yellow. */
  defaulted_by_unknowns: boolean;
}

/** Rubric v0.1 PJHB-proposed thresholds (all pending Fuad confirmation). */
export const RUBRIC_THRESHOLDS = {
  red_min_years: 10,
  red_min_salary: 150_000,
  red_zero_severance_min_years: 2,
  green_max_years: 2,
  green_max_salary: 50_000,
  green_probation_days: 90,
  yellow_lowball_weeks_per_year: 1, // offered < 1 wk/yr of service ⇒ below-entitlement signal
} as const;

// ---- Notice estimate ------------------------------------------------

export interface NoticeEstimate {
  weeks_low: number;
  weeks_mid: number;
  weeks_high: number;
  /** Ontario ESA termination-notice statutory floor (1 wk/yr, cap 8). */
  esa_minimum_weeks: number;
  rationale: string[];
}

export interface InputConflict {
  field: string;
  sources: string[];
  detail: string;
  severity: 'medium' | 'high';
}

export interface InputEcho {
  value: unknown;
  confidence: number;
  source: string[];
}

export interface SettlementEstimate {
  matter_id?: string;
  calculator_version: string;
  disclaimer: string;

  risk_band: RiskBandResult;
  notice: NoticeEstimate | null;
  /** notice_mid × weekly salary; null when salary or notice unavailable. */
  trial_level_value: number | null;
  /** trial_level_value × calibration ratio band. */
  settlement_estimate: { low: number; mid: number; high: number } | null;
  /** Employer's offer vs estimated entitlement, when both known. */
  offer_gap: {
    offered_weeks: number;
    entitled_weeks_mid: number;
    gap_weeks: number;
    offered_fraction_of_entitlement: number;
  } | null;

  conflicts: InputConflict[];
  paralegal_review_required: boolean;
  review_reasons: string[];

  /** Echo of every input consumed, with extraction confidence — audit surface. */
  inputs_used: {
    years_of_service: InputEcho;
    age: InputEcho;
    position_band: InputEcho;
    mitigation_status: InputEcho;
    annual_salary: InputEcho;
    notice_offered_weeks: InputEcho;
  };
  /** Min confidence across the inputs that actually drove the numbers. */
  driving_confidence: number;
  calibration: CalibrationTable;
}

// ---- Internals ------------------------------------------------------

const WEEKS_PER_YEAR = 52.1775;
const NOTICE_CAP_WEEKS = 104; // 24-month common-law ceiling absent exceptional circumstances
const BASE_WEEKS_PER_YEAR_OF_SERVICE = 4; // ≈0.92 months/yr starting point, adjusted below

function ageMultiplier(age: number | null): { mult: number; note: string } {
  if (age === null) return { mult: 1.0, note: 'age unknown — no age adjustment' };
  if (age >= 60) return { mult: 1.25, note: `age ${age} (60+) ×1.25 — re-employment prospects weigh heavily` };
  if (age >= 50) return { mult: 1.15, note: `age ${age} (50-59) ×1.15` };
  if (age >= 30) return { mult: 1.0, note: `age ${age} (30-49) ×1.00 — neutral` };
  return { mult: 0.85, note: `age ${age} (<30) ×0.85 — stronger re-employment prospects` };
}

/**
 * Character-of-employment multiplier. Deliberately COMPRESSED (0.9–1.2)
 * because the schema flags position as "weighted-but-debated" — Fuad:
 * "we're seeing kind of a shift away" from position-driven awards
 * (Bardal schema §3.3 edge cases). Calibrated low on purpose.
 */
function positionMultiplier(band: PositionBand | null): { mult: number; note: string } {
  const table: Record<PositionBand, number> = {
    'entry-level': 0.9,
    junior: 0.95,
    'mid-level': 1.0,
    senior: 1.05,
    management: 1.1,
    executive: 1.2,
    'specialized-professional': 1.15,
    unclassified: 1.0,
  };
  if (band === null) return { mult: 1.0, note: 'position unknown — no character adjustment' };
  const mult = table[band];
  return {
    mult,
    note: `position band '${band}' ×${mult.toFixed(2)} (character factor deliberately compressed — weighted-but-debated per schema §3.3)`,
  };
}

function mitigationMultiplier(status: string | null): { mult: number; note: string } {
  if (!status) return { mult: 1.0, note: 'mitigation status unknown — no adjustment' };
  const s = status.toLowerCase();
  if (/sparse|specialized|limited market|scarce/.test(s)) {
    return { mult: 1.1, note: `mitigation signal '${status}' ×1.10 — comparable employment scarce` };
  }
  if (/found comparable|re-employed|new role at comparable/.test(s)) {
    return { mult: 0.9, note: `mitigation signal '${status}' ×0.90 — comparable employment found` };
  }
  if (/unable/.test(s)) {
    return { mult: 1.15, note: `mitigation signal '${status}' ×1.15 — unable to search (also a red-band flag)` };
  }
  return { mult: 1.0, note: `mitigation signal '${status}' — no calibrated adjustment` };
}

export function esaMinimumWeeks(yearsOfService: number): number {
  // Ontario ESA s.57 termination notice: <3 months → 0; then 1 week per
  // started year of service, capped at 8. (Statutory severance under s.64
  // is a separate head, not modeled in v0.1.)
  if (yearsOfService * 12 < 3) return 0;
  return Math.min(8, Math.max(1, Math.floor(yearsOfService) || 1));
}

/**
 * Reasonable-notice band in weeks. Transparent heuristic, NOT a Bardal
 * "formula" (the courts reject rigid formulas — Bardal v. Globe & Mail
 * itself): a service-anchored baseline with compressed age / character /
 * mitigation adjustments, an ESA statutory floor, a short-service floor,
 * and the 24-month ceiling. Every step lands in `rationale`.
 */
export function estimateNoticeWeeks(inputs: {
  years_of_service: number;
  age: number | null;
  position_band: PositionBand | null;
  mitigation_status: string | null;
}): NoticeEstimate {
  const rationale: string[] = [];
  const years = inputs.years_of_service;

  let weeks = years * BASE_WEEKS_PER_YEAR_OF_SERVICE;
  rationale.push(
    `baseline: ${years} yr service × ${BASE_WEEKS_PER_YEAR_OF_SERVICE} wk/yr = ${weeks.toFixed(1)} wk`,
  );

  const age = ageMultiplier(inputs.age);
  weeks *= age.mult;
  rationale.push(age.note);

  const pos = positionMultiplier(inputs.position_band);
  weeks *= pos.mult;
  rationale.push(pos.note);

  const mit = mitigationMultiplier(inputs.mitigation_status);
  weeks *= mit.mult;
  rationale.push(mit.note);

  // Short-service floor: courts award proportionally MORE notice per year
  // for short-service employees; a bare linear model underestimates them.
  if (years >= 0.5 && years < 2 && weeks < 6) {
    weeks = 6;
    rationale.push('short-service floor applied: minimum 6 wk for 6mo–2yr service');
  }

  const esaFloor = esaMinimumWeeks(years);
  if (weeks < esaFloor) {
    weeks = esaFloor;
    rationale.push(`raised to ESA statutory floor: ${esaFloor} wk`);
  } else {
    rationale.push(`ESA statutory floor: ${esaFloor} wk (not binding)`);
  }

  if (weeks > NOTICE_CAP_WEEKS) {
    weeks = NOTICE_CAP_WEEKS;
    rationale.push(`capped at ${NOTICE_CAP_WEEKS} wk (24-month common-law ceiling)`);
  }

  const mid = Math.round(weeks * 10) / 10;
  const low = Math.max(esaFloor, Math.round(weeks * 0.75 * 10) / 10);
  const high = Math.min(NOTICE_CAP_WEEKS, Math.round(weeks * 1.3 * 10) / 10);
  return { weeks_low: low, weeks_mid: mid, weeks_high: high, esa_minimum_weeks: esaFloor, rationale };
}

// ---- Conflict detection (Gate G2 sub-feature) -----------------------

/**
 * Inter-source conflict detection: compare independently-extracted values
 * that should agree. Any conflict forces paralegal review and (per rubric
 * §6.2) elevates the risk band one level.
 */
export function detectInputConflicts(analysis: BardalAnalysis): InputConflict[] {
  const out: InputConflict[] = [];
  const pf = analysis.primary_factors;

  // 1. Stated years of service vs dates-derived tenure (> 6 months apart
  //    per Bardal schema §3.1 extraction strategy step 5).
  const stated = pf.length_of_employment.value;
  const start = analysis.key_dates.start_date.value;
  const term = analysis.key_dates.termination_date.value;
  if (stated !== null && start && term) {
    const derived = (Date.parse(term) - Date.parse(start)) / (365.25 * 24 * 3600 * 1000);
    if (derived > 0 && Math.abs(derived - stated) > 0.5) {
      out.push({
        field: 'length_of_employment',
        sources: ['custom_fields.years_of_service', 'key_dates.start_date + key_dates.termination_date'],
        detail: `stated ${stated} yr vs date-derived ${derived.toFixed(1)} yr (Δ ${(Math.abs(derived - stated)).toFixed(1)} yr > 0.5 yr)`,
        severity: 'high',
      });
    }
  }

  // 2. Stated age vs DOB-derived age is handled inside the extractor
  //    (confidence drop). Surface it here when the extractor's notes flag it.
  //    (The extractor returns 0.92/0.97 on agreement; disagreement falls to
  //    the age-only 0.78 path — treat sub-0.8 age with a DOB present as a
  //    conflict signal.)
  // 3. Settled amount present while the matter is not at a settled stage.
  const settled = analysis.monetary_amounts.settled_amount.value;
  if (
    settled !== null &&
    analysis.current_analytical_stage !== 'settled_terminal' &&
    analysis.current_analytical_stage !== 'post_resolution'
  ) {
    out.push({
      field: 'settled_amount',
      sources: ['custom_fields.settled_amount', 'current_analytical_stage'],
      detail: `settled_amount $${settled} recorded but analytical stage is '${analysis.current_analytical_stage}'`,
      severity: 'medium',
    });
  }

  // 4. Demand amount lower than the employer's own offer (offer in weeks ×
  //    salary) — a demand below the standing offer is near-certainly a data
  //    entry error.
  const demand = analysis.monetary_amounts.demand_amount.value;
  const offeredWeeks = analysis.monetary_amounts.notice_offered_weeks.value;
  const salary = analysis.monetary_amounts.annual_salary.value;
  if (demand !== null && offeredWeeks !== null && salary !== null) {
    const offeredValue = (salary / WEEKS_PER_YEAR) * offeredWeeks;
    if (demand < offeredValue) {
      out.push({
        field: 'demand_amount',
        sources: ['custom_fields.demand_amount', 'custom_fields.notice_offered', 'custom_fields.annual_salary'],
        detail: `demand $${demand} is below the employer's standing offer value ≈ $${Math.round(offeredValue)} (${offeredWeeks} wk)`,
        severity: 'high',
      });
    }
  }

  return out;
}

// ---- Risk band ------------------------------------------------------

export function assessRiskBand(
  analysis: BardalAnalysis,
  conflicts: InputConflict[],
): RiskBandResult {
  const pf = analysis.primary_factors;
  const cfSalary = analysis.monetary_amounts.annual_salary.value;
  const years = pf.length_of_employment.value;
  const band = pf.position_character.value?.band ?? null;
  const mitigation = pf.comparable_employment.value?.status ?? null;
  const offeredWeeks = analysis.monetary_amounts.notice_offered_weeks.value;
  const T = RUBRIC_THRESHOLDS;

  const triggers: BandTrigger[] = [];

  // Not-terminated → separate triage path (rubric §4.4).
  // The extractor doesn't carry a termination boolean directly; absence of a
  // termination date AND an intake-ish stage is the v0.1 proxy.
  const terminationDate = analysis.key_dates.termination_date.value;
  if (terminationDate === null && analysis.current_analytical_stage === 'intake') {
    return {
      band: 'not_terminated',
      triggers: [{ criterion: 'no termination date at intake stage — separate triage path (rubric §4.4)', provisional: true }],
      elevated_by_conflict: false,
      defaulted_by_unknowns: false,
    };
  }

  // RED triggers (rubric §4.1)
  if (years !== null && years >= T.red_min_years) {
    triggers.push({ criterion: `terminated + service ${years} yr ≥ ${T.red_min_years} yr`, provisional: true });
  }
  if (cfSalary !== null && cfSalary >= T.red_min_salary) {
    triggers.push({ criterion: `terminated + salary $${cfSalary} ≥ $${T.red_min_salary}`, provisional: true });
  }
  if (offeredWeeks !== null && offeredWeeks === 0 && years !== null && years >= T.red_zero_severance_min_years) {
    triggers.push({ criterion: `$0 severance offered with ${years} yr service (≥ ${T.red_zero_severance_min_years} yr)`, provisional: true });
  }
  if (mitigation && /unable/i.test(mitigation)) {
    triggers.push({ criterion: `mitigation status '${mitigation}' (unable-to-search)`, provisional: false });
  }
  if (band === 'executive') {
    triggers.push({ criterion: `position band 'executive'`, provisional: false });
  }
  if (analysis.edge_case_flags.includes('constructive_dismissal')) {
    triggers.push({ criterion: 'constructive-dismissal signal', provisional: false });
  }

  let result: RiskBand;
  let defaulted = false;
  if (triggers.length > 0) {
    result = 'red';
  } else if (years === null || cfSalary === null) {
    // Rubric §6.3 — key input unknown → default YELLOW.
    result = 'yellow';
    defaulted = true;
    triggers.push({
      criterion: `key input unknown (${years === null ? 'years_of_service' : ''}${years === null && cfSalary === null ? ' + ' : ''}${cfSalary === null ? 'annual_salary' : ''}) — rubric default`,
      provisional: false,
    });
  } else if (
    (years * 365.25 < T.green_probation_days) ||
    (years < T.green_max_years && cfSalary < T.green_max_salary)
  ) {
    result = 'green';
    triggers.push({
      criterion: years * 365.25 < T.green_probation_days
        ? `service < ${T.green_probation_days} days (probation)`
        : `service ${years} yr < ${T.green_max_years} yr AND salary $${cfSalary} < $${T.green_max_salary}`,
      provisional: true,
    });
  } else {
    result = 'yellow';
    triggers.push({
      criterion: `default band: service ${years} yr, salary $${cfSalary} (no red or green trigger)`,
      provisional: true,
    });
    if (offeredWeeks !== null && years !== null && offeredWeeks < years * T.yellow_lowball_weeks_per_year) {
      triggers.push({
        criterion: `offer ${offeredWeeks} wk < ${T.yellow_lowball_weeks_per_year} wk/yr of service — below-entitlement signal`,
        provisional: true,
      });
    }
  }

  // Rubric §6.2 — conflicts elevate one band.
  let elevated = false;
  if (conflicts.length > 0 && result !== 'red') {
    result = result === 'green' ? 'yellow' : 'red';
    elevated = true;
    triggers.push({
      criterion: `elevated one band: ${conflicts.length} inter-source conflict(s) (rubric §6.2 default-upward)`,
      provisional: false,
    });
  }

  return { band: result, triggers, elevated_by_conflict: elevated, defaulted_by_unknowns: defaulted };
}

// ---- Top-level ------------------------------------------------------

/**
 * Direct-entitlement path: when the paralegal already has an entitled
 * notice figure (e.g. a DSA/WDD-derived number), compute trial-level and
 * settlement values from it without re-deriving notice. Reproduces the
 * Pass 2.6 worked example: 52 wk (12 mo) at $32k salary → trial $32k →
 * settlement band $13.1k–$16k (observed settlement: $13k).
 */
export function estimateFromEntitlement(
  entitledWeeks: number,
  annualSalary: number,
  calibration: CalibrationTable = DEFAULT_CALIBRATION,
): { trial_level_value: number; settlement_estimate: { low: number; mid: number; high: number } } {
  const weekly = annualSalary / WEEKS_PER_YEAR;
  const trial = Math.round(weekly * entitledWeeks);
  const r = calibration.settlement_ratio;
  return {
    trial_level_value: trial,
    settlement_estimate: {
      low: Math.round(trial * r.low),
      mid: Math.round(trial * r.mid),
      high: Math.round(trial * r.high),
    },
  };
}

export function calculateSettlement(
  analysis: BardalAnalysis,
  calibration: CalibrationTable = DEFAULT_CALIBRATION,
): SettlementEstimate {
  const pf = analysis.primary_factors;
  const reviewReasons: string[] = [];

  const conflicts = detectInputConflicts(analysis);
  for (const c of conflicts) {
    reviewReasons.push(`conflict[${c.severity}] ${c.field}: ${c.detail}`);
  }

  const risk = assessRiskBand(analysis, conflicts);

  const years = pf.length_of_employment.value;
  const age = pf.age.value;
  const posBand = pf.position_character.value?.band ?? null;
  const mitStatus = pf.comparable_employment.value?.status ?? null;
  const salary = analysis.monetary_amounts.annual_salary.value;
  const offeredWeeks = analysis.monetary_amounts.notice_offered_weeks.value;

  const inputs_used: SettlementEstimate['inputs_used'] = {
    years_of_service: {
      value: years,
      confidence: pf.length_of_employment.extraction_confidence,
      source: pf.length_of_employment.source_doc_ref,
    },
    age: { value: age, confidence: pf.age.extraction_confidence, source: pf.age.source_doc_ref },
    position_band: {
      value: posBand,
      confidence: pf.position_character.extraction_confidence,
      source: pf.position_character.source_doc_ref,
    },
    mitigation_status: {
      value: mitStatus,
      confidence: pf.comparable_employment.extraction_confidence,
      source: pf.comparable_employment.source_doc_ref,
    },
    annual_salary: {
      value: salary,
      confidence: analysis.monetary_amounts.annual_salary.extraction_confidence,
      source: analysis.monetary_amounts.annual_salary.source_doc_ref,
    },
    notice_offered_weeks: {
      value: offeredWeeks,
      confidence: analysis.monetary_amounts.notice_offered_weeks.extraction_confidence,
      source: analysis.monetary_amounts.notice_offered_weeks.source_doc_ref,
    },
  };

  let notice: NoticeEstimate | null = null;
  let trial: number | null = null;
  let settlement: SettlementEstimate['settlement_estimate'] = null;
  let offerGap: SettlementEstimate['offer_gap'] = null;

  if (years === null) {
    reviewReasons.push('years_of_service unavailable — notice estimate skipped');
  } else {
    notice = estimateNoticeWeeks({
      years_of_service: years,
      age,
      position_band: posBand,
      mitigation_status: mitStatus,
    });

    if (salary === null) {
      reviewReasons.push('annual_salary unavailable — dollar estimates skipped');
    } else {
      const fromMid = estimateFromEntitlement(notice.weeks_mid, salary, calibration);
      trial = fromMid.trial_level_value;
      settlement = fromMid.settlement_estimate;
    }

    if (offeredWeeks !== null) {
      offerGap = {
        offered_weeks: offeredWeeks,
        entitled_weeks_mid: notice.weeks_mid,
        gap_weeks: Math.round((notice.weeks_mid - offeredWeeks) * 10) / 10,
        offered_fraction_of_entitlement:
          notice.weeks_mid > 0 ? Math.round((offeredWeeks / notice.weeks_mid) * 100) / 100 : 0,
      };
    }
  }

  // Confidence over the DRIVING inputs (the ones the numbers actually used).
  const driving: number[] = [];
  if (years !== null) driving.push(inputs_used.years_of_service.confidence);
  if (age !== null) driving.push(inputs_used.age.confidence);
  if (posBand !== null) driving.push(inputs_used.position_band.confidence);
  if (mitStatus !== null) driving.push(inputs_used.mitigation_status.confidence);
  if (salary !== null) driving.push(inputs_used.annual_salary.confidence);
  const driving_confidence = driving.length ? Math.min(...driving) : 0;

  if (driving_confidence < 0.8) {
    reviewReasons.push(`driving confidence ${driving_confidence.toFixed(2)} < 0.80`);
  }
  if (analysis.needs_paralegal_review) {
    reviewReasons.push('extractor flagged one or more factors for paralegal review');
  }
  if (risk.band === 'red') {
    reviewReasons.push('red band — senior-paralegal routing (rubric §5)');
  }
  if (calibration.n_points < 20) {
    reviewReasons.push(
      `calibration has n=${calibration.n_points} ground-truth point(s) — treat dollar figures as provisional until the 463-file corpus calibration lands`,
    );
  }

  return {
    matter_id: analysis.matter_id,
    calculator_version: CALCULATOR_VERSION,
    disclaimer: CALCULATOR_DISCLAIMER,
    risk_band: risk,
    notice,
    trial_level_value: trial,
    settlement_estimate: settlement,
    offer_gap: offerGap,
    conflicts,
    paralegal_review_required: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    inputs_used,
    driving_confidence,
    calibration,
  };
}
