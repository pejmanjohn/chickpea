#!/usr/bin/env node
/**
 * Backward-compatible Subscription alias for the lane-aware compatibility
 * verifier. The shared verifier owns bundled and hosted catalog admission,
 * route checks, egress restrictions, and response validation.
 */

const values = process.argv.slice(2);
if (!values.includes('--lane')) {
  process.argv.splice(2, 0, '--lane', 'subscription');
}
if (!values.includes('--model') && !values.includes('--help')) {
  process.argv.push('--model', 'gpt-5.3-codex-spark');
}

await import('./verify-model-compatibility-live.mjs');
