#!/usr/bin/env node
// Run the full pipeline once. Used by the GitHub Actions schedule and for local runs.
//   node scripts/run.js [--force] [--now=2026-10-08T03:00:00Z] [--db=state/intel.db] [--out=public]
import { runPipeline } from '../src/pipeline.js';

const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
try {
  const stats = await runPipeline({ force: process.argv.includes('--force'), now: arg('now'), dbPath: arg('db'), outDir: arg('out') });
  console.log(JSON.stringify(stats));
  // A run with stage errors still publishes; exit non-zero only for a hard failure so the schedule keeps going.
} catch (e) {
  console.error('FATAL', e.message);
  process.exit(1);
}
