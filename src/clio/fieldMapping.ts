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
 * Identity transformer: returns input unchanged. Placeholder until Pass 7
 * adds real transformers (e.g., word-form-to-decimal for "two years").
 */
export function identityTransformer<T>(value: T): T {
  return value;
}

/**
 * Apply a named transformer to a value. Currently only 'identity' is
 * registered; Pass 7+ extends this registry.
 */
export function applyTransformer(transformerName: string, value: unknown): unknown {
  switch (transformerName) {
    case 'identity':
      return identityTransformer(value);
    default:
      throw new Error(
        `Unknown transformer: ${transformerName}. ` +
        `Registered transformers: identity. ` +
        `Pass 7+ extends this registry.`,
      );
  }
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
  // Coarse equality check — Pass 7+ adds type-aware comparison
  // (e.g., date-format normalization, number parsing).
  const match = JSON.stringify(growValue) === JSON.stringify(manageValue);
  return {
    canonical_name: entry.canonical_name,
    match,
    severity: entry.drift_severity,
    grow_value: growValue,
    manage_value: manageValue,
    reason: match ? undefined : 'values differ',
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
