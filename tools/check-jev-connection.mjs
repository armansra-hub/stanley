/** Read-only Stanley readiness check. Never bypass the shared paid-call gate. */
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const token = process.env.CODEX_AGENT_TOKEN || process.env.AGENT_TOKEN;
if (!token) throw new Error('Stanley agent authorization is not configured');
const response = await fetch('https://jarvis-sable-eta.vercel.app/api/agent/intelligence/native', {
  method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
  headers: { 'x-agent-token': token, 'x-agent-name': 'codex' },
});
if (!response.ok) {
  console.log(JSON.stringify({ ok: false, status: response.status }));
  process.exitCode = 1;
} else {
  const value = await response.json();
  console.log(JSON.stringify({ ok: true, readinessOnly: true, paidRequestMade: false,
    enabled: value.enabled, configured: value.configured, model: value.model,
    privateExcerptsAuthorized: value.privateExcerptsAuthorized, checkedAt: new Date().toISOString() }));
}
