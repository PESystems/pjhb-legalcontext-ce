/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — fieldMapping bootstrap (Pass 6b W2).
 *
 * Reads the operator-supplied schema snapshot (Grow lex_customs +
 * Manage custom_fields), generates src/clio/fieldMapping.json with
 * one entry per Grow lex_custom row. Idempotent: running twice
 * produces byte-identical output.
 *
 * Usage:
 *   PJHB_SCHEMA_SNAPSHOT_DIR=/path/to/files bun run src/clio/scripts/bootstrap-field-mapping.ts
 *
 * Where the directory contains the 11 schema-snapshot JSON files
 * (grow_*.json + manage_*.json) per the workspace layout
 * 07_research/clio_schema_snapshot/files/.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { FieldMappingTable, FieldMappingEntry, FieldType, DriftSeverity, FieldSide } from '../fieldMapping';
import { validateFieldMapping } from '../fieldMapping';

interface GrowLexCustom {
  id: number;
  name: string;
  field_type: string; // Grow's field-type vocabulary
  clio_field: boolean;
  clio_field_id: number | null;
  kind?: string; // "Matter" | "Contact"
  // ... other fields ignored for bootstrap
}

interface ManageCustomField {
  id: number;
  name: string;
  field_type: string; // Manage's field-type vocabulary (capitalized)
  required: boolean;
  default: boolean;
  is_preconfigured?: boolean;
  // ... other fields ignored
}

/**
 * Map a Grow field_type string to the canonical FieldType enum.
 * Grow uses lowercase snake-ish names; Manage uses Capitalized names.
 * We canonicalize on a single vocabulary.
 */
function mapGrowType(growType: string): FieldType {
  const lc = (growType || '').toLowerCase();
  switch (lc) {
    case 'single_line_text':
    case 'singleline':
    case 'text':           return 'text';
    case 'paragraph':
    case 'paragraph_text':
    case 'multiline_text': return 'paragraph_text';
    case 'date':           return 'date';
    case 'integer':
    case 'int':            return 'integer';
    case 'number':
    case 'decimal':
    case 'float':          return 'number';
    case 'money':
    case 'currency':       return 'money';
    case 'checkbox':
    case 'boolean':
    case 'bool':           return 'boolean';
    case 'dropdown':
    case 'single_select':
    case 'picklist':       return 'single_select';
    case 'multi_select':
    case 'multiselect':    return 'multi_select';
    case 'email':          return 'email';
    case 'free_text':      return 'free_text';
    default:
      // Conservative fallback — text covers most unknowns
      return 'text';
  }
}

/**
 * Slugify a Grow field name to a canonical_name.
 * "Years of Service" → "years_of_service"
 * "Contract?"        → "contract"
 * "Notice Offered "  → "notice_offered" (trailing space tolerated)
 * "EP.ca Rep"        → "epca_rep"
 */
function slugify(name: string): string {
  let s = (name || '').trim().toLowerCase();
  // Replace any non-alphanumeric with underscore
  s = s.replace(/[^a-z0-9]+/g, '_');
  // Trim leading/trailing underscores
  s = s.replace(/^_+|_+$/g, '');
  // Ensure starts with a letter (slug schema requires ^[a-z])
  if (!/^[a-z]/.test(s)) s = `f_${s}`;
  return s;
}

interface GrowLexCustomFile {
  lex_customs?: GrowLexCustom[];
}
interface ManageCustomFieldsFile {
  rows?: ManageCustomField[];
}

function loadJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Schema snapshot file missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256OfFile(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

export interface BootstrapInputs {
  snapshotDir: string;
  /** When true, return the table without writing to disk. Used by tests. */
  dryRun?: boolean;
  /** When set, write to this path instead of src/clio/fieldMapping.json. */
  outPath?: string;
}

export interface BootstrapResult {
  table: FieldMappingTable;
  writtenTo?: string;
  rowCounts: { matter: number; contact: number; growOnly: number; total: number };
}

/**
 * Run the bootstrap. Pure function over inputs; no side effects beyond the
 * optional file write at the end.
 */
export function bootstrap(inputs: BootstrapInputs): BootstrapResult {
  const dir = inputs.snapshotDir;
  const growMatterPath  = join(dir, 'grow_matter_lex_customs.json');
  const growContactPath = join(dir, 'grow_contact_lex_customs.json');
  const manageMatterPath  = join(dir, 'manage_matter_custom_fields.json');
  const manageContactPath = join(dir, 'manage_contact_custom_fields.json');

  const growMatter   = loadJson<GrowLexCustomFile>(growMatterPath);
  const growContact  = loadJson<GrowLexCustomFile>(growContactPath);
  const manageMatter = loadJson<ManageCustomFieldsFile>(manageMatterPath);
  const manageContact = loadJson<ManageCustomFieldsFile>(manageContactPath);

  // Build Manage id → row index for fast lookup
  const manageById = new Map<number, ManageCustomField>();
  for (const row of (manageMatter.rows  ?? [])) manageById.set(row.id, row);
  for (const row of (manageContact.rows ?? [])) manageById.set(row.id, row);

  function buildEntries(rows: GrowLexCustom[], side: FieldSide): FieldMappingEntry[] {
    const out: FieldMappingEntry[] = [];
    for (const row of rows) {
      const linked = row.clio_field === true && typeof row.clio_field_id === 'number';
      const manageRow = linked ? manageById.get(row.clio_field_id as number) : undefined;
      const canonical = slugify(row.name);
      const entry: FieldMappingEntry = {
        grow_field_name: row.name,
        grow_field_id: row.id,
        manage_field_id: linked ? (row.clio_field_id as number) : null,
        manage_field_name: manageRow ? manageRow.name : null,
        canonical_name: canonical,
        type: mapGrowType(row.field_type),
        transformer: 'identity', // placeholder; Pass 7+ adds real transformers
        validation_rules: {},
        drift_severity: linked ? 'low' : 'high',
        side,
        grow_only: !linked,
      };
      if (!linked) {
        entry.notes = 'Grow-only field; no Manage equivalent. Conversion-time data loss flagged for Pass 7 auto-population design.';
      }
      out.push(entry);
    }
    return out;
  }

  // Disambiguate canonical_name collisions (e.g., matter `Contract?` and
  // grow-only `Contract` both slug to `contract`).
  //
  // Preference rule: when a collision pits a mapped entry against a
  // grow-only entry, the mapped entry keeps the bare canonical_name and
  // the grow-only entry takes the `_growonly` suffix. This gives PJHB
  // application code the cleanest DX on the field it will actually use.
  function disambiguate(entries: FieldMappingEntry[]): FieldMappingEntry[] {
    // First pass: group by base slug
    const groups = new Map<string, FieldMappingEntry[]>();
    for (const e of entries) {
      const arr = groups.get(e.canonical_name) ?? [];
      arr.push(e);
      groups.set(e.canonical_name, arr);
    }
    // Second pass: within each group, mapped first then grow-only
    const out: FieldMappingEntry[] = [];
    for (const [base, group] of groups) {
      if (group.length === 1) {
        out.push(group[0]);
        continue;
      }
      const mapped = group.filter(g => g.manage_field_id !== null);
      const growOnly = group.filter(g => g.manage_field_id === null);
      // The first mapped (or first growOnly if no mapped) keeps the bare slug.
      let bareTaken = false;
      const ordered = [...mapped, ...growOnly];
      for (let i = 0; i < ordered.length; i++) {
        const e = ordered[i];
        if (!bareTaken) {
          out.push({ ...e, canonical_name: base });
          bareTaken = true;
          continue;
        }
        const suffix = e.manage_field_id === null ? '_growonly' : `_${i}`;
        out.push({ ...e, canonical_name: `${base}${suffix}` });
      }
    }
    return out;
  }

  const matterEntries  = buildEntries(growMatter.lex_customs  ?? [], 'matter');
  const contactEntries = buildEntries(growContact.lex_customs ?? [], 'contact');
  const allEntries = [...matterEntries, ...contactEntries];

  // Single disambiguation pass across both sides at once
  const finalEntries = disambiguate(allEntries);

  const counts = {
    matter: matterEntries.length,
    contact: contactEntries.length,
    growOnly: finalEntries.filter(e => e.manage_field_id === null).length,
    total: finalEntries.length,
  };

  // Snapshot SHAs for all 11 files (re-pull comparison anchor for Pass 7).
  const snapshotSha: Record<string, string> = {};
  const trackedFiles = [
    'grow_contact_lex_customs.json',
    'grow_locations.json',
    'grow_matter_lex_customs.json',
    'grow_matter_statuses.json',
    'grow_matter_types.json',
    'manage_contact_custom_field_sets.json',
    'manage_contact_custom_fields.json',
    'manage_matter_custom_field_sets.json',
    'manage_matter_custom_fields.json',
    'manage_practice_area_assets.json',
    'manage_practice_areas.json',
  ];
  for (const f of trackedFiles) {
    const p = join(dir, f);
    if (existsSync(p)) snapshotSha[f] = sha256OfFile(p);
  }

  const table: FieldMappingTable = {
    version: 1,
    // Idempotent timestamp: derived from the snapshot SHAs themselves so
    // re-running the bootstrap on the same snapshot produces byte-identical
    // output. (Use the all-snapshot SHA composite as the "generated" anchor.)
    generated: deriveDeterministicTimestamp(snapshotSha),
    source_snapshot_sha256: snapshotSha,
    entries: finalEntries,
  };

  // Schema validate before writing
  const errors = validateFieldMapping(table);
  if (errors.length > 0) {
    throw new Error(`Bootstrap produced an invalid mapping: ${errors.slice(0, 3).join('; ')}`);
  }

  let writtenTo: string | undefined;
  if (!inputs.dryRun) {
    let outPath: string;
    if (inputs.outPath) {
      outPath = inputs.outPath;
    } else {
      let here: string;
      try {
        here = dirname(fileURLToPath(import.meta.url));
      } catch {
        here = process.cwd();
      }
      // src/clio/scripts/<this file>  →  src/clio/fieldMapping.json
      outPath = resolve(here, '..', 'fieldMapping.json');
    }
    writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n', 'utf8');
    writtenTo = outPath;
  }

  return { table, writtenTo, rowCounts: counts };
}

/**
 * Derive a deterministic ISO timestamp anchor from the snapshot SHAs.
 * This makes the bootstrap idempotent: the same input snapshot always
 * produces the same `generated` field. Real wall-clock time would break
 * idempotency.
 */
function deriveDeterministicTimestamp(snapshotSha: Record<string, string>): string {
  const composite = Object.keys(snapshotSha).sort().map(k => snapshotSha[k]).join('');
  const hash = createHash('sha256').update(composite).digest('hex');
  // Use the first 8 hex chars as a synthetic "snapshot version" id, embed
  // in a fixed-prefix ISO-shaped string. Pass 7 re-pulls produce a
  // different prefix.
  return `2026-04-26T00:00:00Z+snap:${hash.substring(0, 12)}`;
}

// Run as CLI when invoked directly via `bun run`.
function isMain(): boolean {
  try {
    const here = fileURLToPath(import.meta.url);
    return process.argv[1] === here || process.argv[1]?.endsWith('bootstrap-field-mapping.ts');
  } catch { return false; }
}

if (isMain()) {
  const dir = process.env.PJHB_SCHEMA_SNAPSHOT_DIR;
  if (!dir) {
    console.error(
      'PJHB_SCHEMA_SNAPSHOT_DIR env var is required.\n' +
      'Set it to the absolute path of the workspace\'s ' +
      '07_research/clio_schema_snapshot/files/ directory.',
    );
    process.exit(1);
  }
  const result = bootstrap({ snapshotDir: dir });
  console.log(`fieldMapping.json written to: ${result.writtenTo}`);
  console.log(`Rows: matter=${result.rowCounts.matter}  contact=${result.rowCounts.contact}  total=${result.rowCounts.total}  grow-only=${result.rowCounts.growOnly}`);
}
