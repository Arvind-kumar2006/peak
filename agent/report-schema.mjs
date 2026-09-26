// Structured reports the agent submits through report-mcp tools.
// Single source of truth: report-mcp validates with these, and contracts/incident-report.schema.json
// mirrors them for the rest of the team.
import { z } from 'zod';

export const WRITE_ACTIONS = ['trigger_rollback', 'restart_service', 'scale_service', 'clear_cache'];

const evidence = z.object({
  claim: z.string().min(1).describe('What this evidence supports'),
  tool: z.string().min(1).describe('Tool that produced it, e.g. db-mcp.get_pool_stats'),
  observation: z.string().min(1).describe('The concrete value(s) observed, quoted from the tool result'),
});

const metricsSummary = z.object({
  errorRate: z.number().nullable(),
  p95Ms: z.number().nullable(),
  poolInUse: z.number().nullable(),
  poolWaiting: z.number().nullable(),
  memoryMB: z.number().nullable(),
  release: z.string().nullable(),
});

export const diagnosisShape = {
  summary: z.string().min(1).describe('One or two sentences for the dashboard headline'),
  rootCause: z.object({
    category: z.enum(['code', 'infra', 'unknown']),
    description: z.string().min(1).describe('The causal chain: cause → mechanism → symptom'),
    confidence: z.number().min(0).max(1),
    commitSha: z.string().nullable().describe('Offending commit (short or full SHA) when category = code, else null'),
  }),
  evidence: z.array(evidence).min(2),
  ruledOut: z.array(z.string()).describe('Alternative causes checked and rejected, each with the reason'),
  proposedFix: z.object({
    action: z.enum([...WRITE_ACTIONS, 'none']),
    args: z.record(z.any()).describe('Exact arguments you will pass to the action tool'),
    reasoning: z.string().min(1).describe('Why this action fixes the root cause (not just the symptom)'),
    expectedOutcome: z.enum(['resolves', 'mitigates']).describe('resolves = removes the root cause; mitigates = clears symptoms only'),
  }),
  before: metricsSummary.describe('Key metrics observed during the incident'),
};

export const resolutionShape = {
  verdict: z.enum(['resolved', 'mitigated', 'not_resolved', 'rejected']),
  actionTaken: z.enum([...WRITE_ACTIONS, 'none']),
  windowSec: z.number().int().min(0).describe('Length of the verification window you checked'),
  before: metricsSummary,
  after: metricsSummary.describe('Metrics at the end of the verification window'),
  reasoning: z.string().min(1).describe('Why this verdict, citing the window samples'),
  followUp: z.string().describe('What a human should do next (e.g. fix the code, investigate further); empty if nothing'),
};

export const diagnosisSchema = z.object(diagnosisShape);
export const resolutionSchema = z.object(resolutionShape);
