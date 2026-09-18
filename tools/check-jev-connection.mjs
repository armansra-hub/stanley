/** Explicit, one-request credential check. Uses synthetic public data only. */
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not configured');
const started = Date.now();
const response = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
  headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: process.env.TYPESAFE_MODEL || 'jev-1.13.0',
    state: 'Synthetic example: Example Company announced a second office. This is a connection test, not a real prospect.',
    questions: { expansion: { type: 'noul', instructions: 'Does this synthetic example describe an office expansion?' } },
  }),
});
if (!response.ok) {
  console.log(JSON.stringify({ ok: false, status: response.status, checkedAt: new Date().toISOString() }));
  process.exitCode = 1;
} else {
  const value = await response.json();
  const tokens = value.usage?.input_tokens;
  console.log(JSON.stringify({ ok: true, status: response.status, model: value.model,
    answerType: value.answers?.expansion?.type, answer: value.answers?.expansion?.noul,
    inputTokens: tokens, estimatedCostUsd: Number.isFinite(tokens) ? tokens * 0.042 / 1000000 : null,
    latencyMs: Date.now() - started, checkedAt: new Date().toISOString() }));
}
