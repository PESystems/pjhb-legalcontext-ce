/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — fieldMapping module (Pass 6b W2).
 *
 * Reads the bootstrap-generated mapping JSON, validates it against the
 * schema, exposes a runtime mapping function + drift detector +
 * conversion-time data-loss warning surface.
 *
 * The mapping table itself (src/clio/fieldMapping.json) is populated by
 * src/clio/scripts/bootstrap-field-mapping.ts from the PJHB workspace's
 * operator-supplied schema snapshot. See the bootstrap script + the
 * fieldMapping.schema.json for the contract.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'free_text'
  | 'boolean'
  | 'money'
  | 'paragraph_text'
  | 'integer'
  | 'email';

export type DriftSeverity = 'low' | 'medium' | 'high';
export type FieldSide = 'matter' | 'contact';

export interface FieldMappingEntry {
  grow_field_name: string;
  grow_field_id?: number;
  manage_field_id: number | null;
  manage_field_name: string | null;
  canonical_name: string;
  type: FieldType;
  transformer: string;
  validation_rules: Record<string, unknown>;
  drift_severity: DriftSeverity;
  side: FieldSide;
  grow_only?: boolean;
  notes?: string;
}

export interface FieldMappingTable {
  version: 1;
  generated: string;
  source_snapshot_sha256: Record<string, string>;
  entries: FieldMappingEntry[];
}

export class FieldMappingValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`fieldMapping validation failed: ${errors.length} error(s) — ${errors[0] ?? '(none)'}`);
    this.name = 'FieldMappingValidationError';
  }
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  'text', 'number', 'date', 'single_select', 'multi_select',
  'free_text', 'boolean', 'money', 'paragraph_text', 'integer', 'email',
]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const VALID_SIDES: ReadonlySet<string> = new Set(['matter', 'contact']);
const CANONICAL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a parsed mapping table against the schema. Returns a list of
 * human-readable error messages; empty list = valid.
 */
export function validateFieldMapping(table: unknown): string[] {
  const errors: string[] = [];
  if (typeof table !== 'object' || table === null) {
    return ['Top-level must be an object'];
  }
  const t = table as Partial<FieldMappingTable>;
  if (t.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(t.version)}`);
  if (typeof t.generated !== 'string') errors.push('generated must be an ISO 8601 timestamp string');
  if (typeof t.source_snapshot_sha256 !== 'object' || t.source_snapshot_sha256 === null) {
    errors.push('source_snapshot_sha256 must be an object');
  }
  if (!Array.isArray(t.entries)) {
    errors.push('entries must be an array');
    return errors;
  }
  const seenCanonical = new Set<string>();
  for (let i = 0; i < t.entries.length; i++) {
    const e = t.entries[i] as Partial<FieldMappingEntry>;
    const ctx = `entries[${i}]`;
    if (typeof e.grow_field_name !== 'string' || e.grow_field_name.length === 0) {
      errors.push(`${ctx}.grow_field_name must be a non-empty string`);
    }
    if (e.manage_field_id !== null && typeof e.manage_field_id !== 'number') {
      errors.push(`${ctx}.manage_field_id must be number or null`);
    }
    if (e.manage_field_name !== null && typeof e.manage_field_name !== 'string') {
      errors.push(`${ctx}.manage_field_name must be string or null`);
    }
    if (typeof e.canonical_name !== 'string' || !CANONICAL_NAME_RE.test(e.canonical_name)) {
      errors.push(`${ctx}.canonical_name must match ${CANONICAL_NAME_RE} (got ${JSON.stringify(e.canonical_name)})`);
    } else {
      if (seenCanonical.has(e.canonical_name)) {
        errors.push(`${ctx}.canonical_name duplicate: ${e.canonical_name}`);
      }
      seenCanonical.add(e.canonical_name);
    }
    if (typeof e.type !== 'string' || !VALID_TYPES.has(e.type)) {
      errors.push(`${ctx}.type must be one of ${Array.from(VALID_TYPES).join(',')} (got ${JSON.stringify(e.type)})`);
    }
    if (typeof e.transformer !== 'string' || e.transformer.length === 0) {
      errors.push(`${ctx}.transformer must be a non-empty string`);
    }
    if (typeof e.validation_rules !== 'object' || e.validation_rules === null) {
      errors.push(`${ctx}.validation_rules must be an object`);
    }
    if (typeof e.drift_severity !== 'string' || !VALID_SEVERITIES.has(e.drift_severity)) {
      errors.push(`${ctx}.drift_severity must be one of low/medium/high`);
    }
    if (typeof e.side !== 'string' || !VALID_SIDES.has(e.side)) {
      errors.push(`${ctx}.side must be 'matter' or 'contact'`);
    }
  }
  return errors;
}

/**
 * Load + validate the mapping table from a JSON file path.
 * Throws FieldMappingValidationError on schema violation.
 */
export function loadFieldMapping(filePath?: string): FieldMappingTable {
  let resolved: string;
  if (filePath) {
    resolved = filePath;
  } else {
    // Default: sibling fieldMapping.json next to this module's source.
    // Works under Bun (import.meta.url) and Node ESM.
    let here: string;
    try {
      here = dirname(fileURLToPath(import.meta.url));
    } catch {
      here = process.cwd();
    }
    resolved = join(here, 'fieldMapping.json');
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `fieldMapping.json not found at ${resolved}. ` +
      `Run \`bun run src/clio/scripts/bootstrap-field-mapping.ts\` to generate it ` +
      `from the workspace's schema snapshot.`,
    );
  }
  const raw = readFileSync(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`fieldMapping.json failed to parse as JSON: ${e}`);
  }
  const errors = validateFieldMapping(parsed);
  if (errors.length > 0) {
    throw new FieldMappingValidationError(errors);
  }
  return parsed as FieldMappingTable;
}

/**
 * Index a mapping table by canonical_name for O(1) lookup.
 */
export function indexByCanonical(table: FieldMappingTable): Map<string, FieldMappingEntry> {
  const map = new Map<string, FieldMappingEntry>();
  for (const e of table.entries) map.set(e.canonical_name, e);
  return map;
}

/**
 * Identity transformer: returns input unchanged. Retained for
 * backwards-compatibility with Pass 6b mapping tables and as the explicit
 * no-op choice.
 */
export function identityTransformer<T>(value: T): T {
  return value;
}

/**
 * Pass 7 transformer design principles:
 *
 *   1. NEVER destroy data. A transformer that cannot confidently parse its
 *      input returns the whitespace-normalized original, not null and not a
 *      guess. Downstream consumers (extractor, calculator) decide what an
 *      unparseable value means.
 *   2. Deterministic. No locale, clock, or environment dependence.
 *   3. Normalizing, not validating. Range/option checks belong to
 *      validation_rules, applied by the caller.
 *
 * Empty-ish inputs (null, undefined, '') normalize to null so Grow/Manage
 * empty-representation differences don't read as drift.
 */

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Collapse internal whitespace + trim. Non-strings pass through. */
export function trimTextTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value !== 'string') return value;
  return value.replace(/\s+/g, ' ').trim();
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

/**
 * Normalize a date to ISO 8601 (YYYY-MM-DD) when the format is unambiguous:
 *   - YYYY-MM-DD / YYYY/MM/DD (already ISO-ordered)
 *   - "January 5, 2020" / "5 January 2020" / "Jan 5 2020"
 *   - D/M/YYYY or M/D/YYYY where one part > 12 (disambiguates itself)
 * Ambiguous numeric dates (e.g. 04/05/2020) pass through unchanged — a
 * wrong month/day swap is worse than no normalization.
 */
export function dateIsoTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return value;
  const s = value.replace(/\s+/g, ' ').trim();

  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!) ?? s;

  m = s.match(/^([A-Za-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/);
  if (m && MONTHS[m[1]!.toLowerCase()]) return isoDate(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!) ?? s;

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+)\.?,? (\d{4})$/);
  if (m && MONTHS[m[2]!.toLowerCase()]) return isoDate(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!) ?? s;

  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const a = +m[1]!; const b = +m[2]!; const y = +m[3]!;
    if (a > 12 && b <= 12) return isoDate(y, b, a) ?? s; // D/M/YYYY
    if (b > 12 && a <= 12) return isoDate(y, a, b) ?? s; // M/D/YYYY
    if (a === b) return isoDate(y, a, b) ?? s;           // same either way
    return s; // ambiguous — pass through
  }

  return s;
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};

function parseNumericString(s: string): number | null {
  const cleaned = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:ca\$|cad|c\$|us\$|usd|\$)\s*/i, '')
    .replace(/\s*(?:cad|usd|dollars?)\.?$/i, '')
    .replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
  const word = WORD_NUMBERS[cleaned.toLowerCase()];
  return word !== undefined ? word : null;
}

/** Parse to a float when confident ("$65,000.50", "two"); else pass through. */
export function numberParseTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const n = parseNumericString(value);
  return n !== null ? n : (trimTextTransformer(value) as string);
}

/** Parse to an integer when confident; floats truncate toward zero only when exact ("5.0"); else pass through. */
export function integerParseTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : value;
  if (typeof value !== 'string') return value;
  const n = parseNumericString(value);
  if (n === null) return trimTextTransformer(value) as string;
  return Number.isInteger(n) ? n : n;
}

/** Parse currency to a number rounded to cents; else pass through. */
export function moneyParseTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (typeof value !== 'string') return value;
  const n = parseNumericString(value);
  return n !== null ? Math.round(n * 100) / 100 : (trimTextTransformer(value) as string);
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', 'checked', 'x', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', 'unchecked', '0']);

/** Normalize common yes/no encodings to boolean; else pass through. */
export function booleanParseTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : value;
  if (typeof value !== 'string') return value;
  const k = value.trim().toLowerCase();
  if (TRUE_WORDS.has(k)) return true;
  if (FALSE_WORDS.has(k)) return false;
  return trimTextTransformer(value) as string;
}

/** Picklist option: whitespace-normalize only (option membership is a validation concern). */
export function selectTrimTransformer(value: unknown): unknown {
  return trimTextTransformer(value);
}

/** Multi-select: split on ; or , into trimmed non-empty options. Arrays normalize element-wise. */
export function multiSelectSplitTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (Array.isArray(value)) {
    const out = value.map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v)).filter((v) => !isEmpty(v));
    return out.length ? out : null;
  }
  if (typeof value !== 'string') return value;
  const parts = value.split(/[;,]/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/** Email: trim + lowercase (addresses are case-insensitive in practice; Clio treats them so). */
export function emailNormalizeTransformer(value: unknown): unknown {
  if (isEmpty(value)) return null;
  if (typeof value !== 'string') return value;
  const s = value.trim();
  return s.includes('@') ? s.toLowerCase() : (trimTextTransformer(s) as string);
}

const TRANSFORMER_REGISTRY: Record<string, (value: unknown) => unknown> = {
  identity: identityTransformer,
  trim_text: trimTextTransformer,
  date_iso: dateIsoTransformer,
  number_parse: numberParseTransformer,
  integer_parse: integerParseTransformer,
  money_parse: moneyParseTransformer,
  boolean_parse: booleanParseTransformer,
  select_trim: selectTrimTransformer,
  multi_select_split: multiSelectSplitTransformer,
  email_normalize: emailNormalizeTransformer,
};

/** Default transformer per canonical FieldType — used by the bootstrap. */
export const DEFAULT_TRANSFORMER_BY_TYPE: Record<FieldType, string> = {
  text: 'trim_text',
  free_text: 'trim_text',
  paragraph_text: 'trim_text',
  date: 'date_iso',
  integer: 'integer_parse',
  number: 'number_parse',
  money: 'money_parse',
  boolean: 'boolean_parse',
  single_select: 'select_trim',
  multi_select: 'multi_select_split',
  email: 'email_normalize',
};

export function listRegisteredTransformers(): string[] {
  return Object.keys(TRANSFORMER_REGISTRY);
}

/**
 * Apply a named transformer to a value. Throws on unregistered names so a
 * stale mapping table fails loudly instead of silently passing data through.
 */
export function applyTransformer(transformerName: string, value: unknown): unknown {
  const fn = TRANSFORMER_REGISTRY[transformerName];
  if (!fn) {
    throw new Error(
      `Unknown transformer: ${transformerName}. ` +
      `Registered transformers: ${listRegisteredTransformers().join(', ')}.`,
    );
  }
  return fn(value);
}

/**
 * Map a Grow value to a Manage value via the named transformer.
 * Returns null when the entry is grow_only (no Manage equivalent).
 */
export function growToManage(entry: FieldMappingEntry, growValue: unknown): unknown {
  if (entry.manage_field_id === null) return null;
  return applyTransformer(entry.transformer, growValue);
}

/**
 * Map a Manage value to a Grow value via the named transformer.
 * Returns null when the entry is grow_only (no Manage equivalent — direction undefined).
 */
export function manageToGrow(entry: FieldMappingEntry, manageValue: unknown): unknown {
  if (entry.manage_field_id === null) return null;
  return applyTransformer(entry.transformer, manageValue);
}

/**
 * Drift detection: compare paired Grow+Manage values. Returns a structured
 * report. Caller decides what to do based on `entry.drift_severity`:
 *   low    → annotation-only; log and continue
 *   medium → PJHB-side reconciliation logged; paralegal review at extraction
 *   high   → block file workflow until reconciled
 */
export interface DriftReport {
  canonical_name: string;
  match: boolean;
  severity: DriftSeverity;
  grow_value: unknown;
  manage_value: unknown;
  reason?: string;
}

export function detectDrift(
  entry: FieldMappingEntry,
  growValue: unknown,
  manageValue: unknown,
): DriftReport {
  if (entry.manage_field_id === null) {
    return {
      canonical_name: entry.canonical_name,
      match: false,
      severity: entry.drift_severity,
      grow_value: growValue,
      manage_value: null,
      reason: 'grow-only field; no Manage equivalent (conversion-time data loss)',
    };
  }
  // Pass 7: type-aware comparison — normalize both sides through the
  // entry's transformer first, so representation-only differences
  // ("$65,000" vs 65000, "Jan 5, 2020" vs "2020-01-05", "Yes" vs true)
  // don't read as drift.
  const growNorm = applyTransformer(entry.transformer, growValue);
  const manageNorm = applyTransformer(entry.transformer, manageValue);
  const rawMatch = JSON.stringify(growValue) === JSON.stringify(manageValue);
  const match = JSON.stringify(growNorm) === JSON.stringify(manageNorm);
  return {
    canonical_name: entry.canonical_name,
    match,
    severity: entry.drift_severity,
    grow_value: growValue,
    manage_value: manageValue,
    reason: match
      ? (rawMatch ? undefined : 'values equivalent after normalization')
      : 'values differ after normalization',
  };
}

/**
 * Conversion-time data-loss warning surface.
 *
 * When a Grow lead converts to a Manage matter, the 5 grow-only entries
 * (4 matter, 1 contact) cannot be propagated to Manage automatically.
 * Pass 7 will design auto-population at conversion time. Pass 6b emits
 * the warning + logs to a conversion log so the data isn't silently
 * discarded.
 */
export interface ConversionWarning {
  canonical_name: string;
  side: FieldSide;
  grow_value: unknown;
  reason: string;
}

export function listGrowOnlyEntries(table: FieldMappingTable): FieldMappingEntry[] {
  return table.entries.filter(e => e.manage_field_id === null);
}

export function emitConversionWarnings(
  table: FieldMappingTable,
  growData: Record<string, unknown>,
): ConversionWarning[] {
  const out: ConversionWarning[] = [];
  for (const e of listGrowOnlyEntries(table)) {
    if (e.canonical_name in growData) {
      out.push({
        canonical_name: e.canonical_name,
        side: e.side,
        grow_value: growData[e.canonical_name],
        reason: `Grow-only field; no Manage equivalent. Pass 7 will design auto-population.`,
      });
    }
  }
  return out;
}
