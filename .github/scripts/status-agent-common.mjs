import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const transport = process.cwd();
export const sourceCheckout = path.join(transport, '.state/generation-source');
export const generated = path.join(transport, '.state/generated-status-project');
export const output = path.join(transport, 'artifacts/hosted-agent-add');
export const preparation = path.join(output, 'preparation');
export const payload = path.join(transport, '.state/status-feature-input');
export const config = JSON.parse(readFileSync(path.join(transport, '.github/payload/status-fresh-input.json'), 'utf8'));
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const writeJson = (name, value) => writeFileSync(path.join(preparation, name), JSON.stringify(value, null, 2) + '\n');
export const absentSource = () => assert.ok(!existsSync(sourceCheckout), 'Original Source checkout must be absent throughout generated-project feature work');
mkdirSync(preparation, { recursive: true });
mkdirSync(path.join(transport, '.state/tmp'), { recursive: true });
export const environment = { ...process.env, TMPDIR: path.join(transport, '.state/tmp'), TMP: path.join(transport, '.state/tmp'), TEMP: path.join(transport, '.state/tmp'), CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' };
export const commands = [];
export function run(argv, cwd, label, timeout = 60_000) {
  assert.ok(Array.isArray(argv) && argv.length && argv.every((value) => typeof value === 'string'));
  const started = new Date();
  const file = 'command-' + label + '.log';
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: environment, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const ended = new Date();
  const entry = { argv, cwd, started: started.toISOString(), ended: ended.toISOString(), durationMs: ended - started, exit: result.status, signal: result.signal, error: result.error?.message, log: 'preparation/' + file, execution: 'hosted-tools', kind: 'generation-preparation' };
  writeFileSync(path.join(preparation, file), 'argv: ' + JSON.stringify(argv) + '\ncwd: ' + cwd + '\n' + (result.stdout ?? '') + (result.stderr ?? '') + '\nresult: ' + JSON.stringify(entry) + '\n');
  commands.push(entry);
  writeJson('commands-' + process.env.STATUS_AGENT_STAGE + '.json', commands);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw new Error(label + ': ' + (result.error?.message ?? 'exit ' + result.status));
  return result.stdout;
}
export function guardCarrier() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/agent-add-983');
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(run(['git', 'rev-parse', 'HEAD'], transport, 'carrier-head-' + process.env.STATUS_AGENT_STAGE).trim(), process.env.GITHUB_SHA);
  assert.equal(config.schema, 1);
  assert.equal(config.kind, 'fresh-generation-support');
  assert.match(config.source.sha, /^[a-f0-9]{40}$/u, 'Exact new Source SHA must be frozen before transport');
  assert.match(config.source.contentId, /^[a-f0-9]{64}$/u, 'Exact new Source content ID must be frozen before transport');
  assert.equal(config.source.dirty, false);
  assert.deepEqual(config.identity, { name: 'independent-status-api', scope: '@independent-service', preset: 'api', features: [] });
  assert.equal(config.authoredTransportSha, '6c2f0045b4b4ba2f83d5c040c548a4c1e81a2ebf');
}
