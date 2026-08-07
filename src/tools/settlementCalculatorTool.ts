/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) Protomated
 * Email: team@protomated.com
 * Website: protomated.com
 *
 * PJHB fork addition — settlement calculator MCP tool (Pass 7).
 *
 * Exposes the calculator-first MVP over MCP. Read-only over its inputs:
 * the caller supplies the matter's structured custom-field values (keyed
 * by fieldMapping canonical_name) and optional document bodies; the tool
 * runs extractBardalFactors + calculateSettlement and returns the full
 * estimate JSON, rationale trail included. No Clio API calls are made by
 * this tool — data acquisition stays in the (separately-gated) sync layer.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../logger';
import { extractBardalFactors } from '../extractors/bardalExtractor';
import {
  calculateSettlement,
  estimateFromEntitlement,
  CALCULATOR_VERSION,
  DEFAULT_CALIBRATION,
} from '../calculator/settlementCalculator';

export function registerSettlementCalculatorTools(server: McpServer): void {
  logger.info('Registering settlement calculator tools...');

  server.tool(
    'calculate_settlement',
    'PJHB calculator-first MVP: run the Bardal extractor over a matter\'s structured ' +
      'custom fields (+ optional document text bodies), then produce a risk band ' +
      '(red/yellow/green), a reasonable-notice band in weeks, a trial-level value, and a ' +
      'median-anchored settlement estimate with a full rationale trail. Deterministic and ' +
      'read-only; paralegal review flags included. Not legal advice.',
    {
      custom_fields: z
        .record(z.unknown())
        .describe('Structured Clio custom-field values keyed by fieldMapping canonical_name (e.g. years_of_service, annual_salary, notice_offered).'),
      documents: z
        .record(z.string())
        .optional()
        .describe('Optional plain-text document bodies keyed by role: termination_letter, employment_contract, demand_letter, settlement_conference_notes, trial_judgment.'),
      current_clio_stage: z
        .string()
        .optional()
        .describe('Current Clio stage label (one of the firm\'s 14 stage labels).'),
      matter_id: z.string().optional().describe('Matter identifier for the audit trail.'),
    },
    async ({ custom_fields, documents, current_clio_stage, matter_id }) => {
      logger.info(`calculate_settlement invoked (matter: ${matter_id ?? 'unspecified'}, calculator ${CALCULATOR_VERSION})`);
      const analysis = extractBardalFactors({
        matter_id,
        custom_fields,
        documents: (documents ?? {}) as {
          termination_letter?: string;
          employment_contract?: string;
          demand_letter?: string;
          settlement_conference_notes?: string;
          trial_judgment?: string;
        },
        current_clio_stage,
      });
      const estimate = calculateSettlement(analysis);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(estimate, null, 2) }],
      };
    },
  );

  server.tool(
    'estimate_from_entitlement',
    'PJHB direct-entitlement path: given an already-determined entitled notice period ' +
      '(weeks) and annual salary, compute trial-level value and the median-anchored ' +
      'settlement band. Reproduces the Pass 2.6 worked-example evaluation shape. ' +
      'Deterministic; not legal advice.',
    {
      entitled_weeks: z.number().positive().describe('Entitled notice period in weeks (e.g. a DSA-derived figure).'),
      annual_salary: z.number().positive().describe('Annual salary in CAD.'),
    },
    async ({ entitled_weeks, annual_salary }) => {
      const result = estimateFromEntitlement(entitled_weeks, annual_salary);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { calculator_version: CALCULATOR_VERSION, calibration: DEFAULT_CALIBRATION, ...result },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  logger.info('Settlement calculator tools registered');
}
