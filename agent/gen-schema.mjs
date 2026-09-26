// Regenerate contracts/incident-report.schema.json from report-schema.mjs (the Zod source of truth).
import { writeFileSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { diagnosisSchema, resolutionSchema } from './report-schema.mjs';

const strip = ({ $schema, ...s }) => s;
const doc = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'PEAK incident reports',
  description:
    'GENERATED from agent/report-schema.mjs (npm run schema in agent/) — do not edit by hand. The agent submits these as arguments to report-mcp tools; the backend reads them with getReports() from agent/lib/trueforge-client.mjs.',
  definitions: {
    Diagnosis: { description: 'submit_diagnosis arguments — available while the action awaits approval', ...strip(zodToJsonSchema(diagnosisSchema)) },
    Resolution: { description: 'submit_resolution arguments — the final verdict after verification', ...strip(zodToJsonSchema(resolutionSchema)) },
  },
};
writeFileSync(new URL('../contracts/incident-report.schema.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
console.log('✓ contracts/incident-report.schema.json regenerated');
