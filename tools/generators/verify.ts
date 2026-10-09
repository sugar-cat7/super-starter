import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pnpm } from '../process.ts';
import { contentId as sourceId } from '../quality/gate.ts';
import { spawnSync } from 'node:child_process';
import { applyFiles, digest } from './files.ts';
import { projectFiles } from './render.ts';
import { flags, projectOptions, verificationCases } from './options.ts';
import { faultRehearsal } from '../quality/faults.ts';
import { hookRehearsal } from '../quality/hooks-rehearsal.ts';
import { lifecycleRehearsal } from './lifecycle.ts';

const source = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const input = flags(process.argv.slice(2));
const allowed = ['preset', 'output', 'generate-only', 'faults', 'hooks', 'lifecycle'];
for (const key of Object.keys(input))
  if (!allowed.includes(key)) throw new Error(`Unknown verification flag --${key}`);
const selected =
  typeof input.preset === 'string'
    ? verificationCases.filter((entry) => entry.key === input.preset)
    : verificationCases;
if (!selected.length) throw new Error('Unknown preset verification case');
const temporary = typeof input.output !== 'string';
const output = temporary
  ? mkdtempSync(path.join(os.tmpdir(), 'starter-verify-'))
  : path.resolve(String(input.output));
mkdirSync(output, { recursive: true });
const reports: {
  preset: string;
  contentId: string;
  milliseconds: number;
  status: 'generated' | 'passed' | 'failed';
  error?: string;
}[] = [];
try {
  for (const entry of selected) {
    const started = performance.now();
    const root = path.join(output, entry.key);
    if (existsSync(root) && readdirSync(root).length)
      throw new Error(`Verification destination must be empty: ${root}`);
    const options = projectOptions({
      name: `rehearsal-${entry.key}`,
      scope: '@rehearsal',
      preset: entry.preset,
      features: entry.features,
    });
    const files = projectFiles(source, options);
    const contentId = digest(
      Buffer.concat(
        [...files].flatMap(([filename, contents]) => [Buffer.from(filename), contents]),
      ),
    );
    applyFiles(root, files);
    try {
      await pnpm(['install', '--lockfile-only', '--no-frozen-lockfile'], { cwd: root });
      if (!input['generate-only']) {
        await pnpm(['env:setup'], { cwd: root, timeout: 10 * 60_000 });
        await pnpm(['env:doctor'], { cwd: root });
        await pnpm(['gate:full'], { cwd: root, timeout: 60 * 60_000 });
        if (input.faults) await faultRehearsal(root);
        if (input.hooks) await hookRehearsal(root);
        if (input.lifecycle) await lifecycleRehearsal(root);
      }
      reports.push({
        preset: entry.key,
        contentId,
        milliseconds: Math.round(performance.now() - started),
        status: input['generate-only'] ? 'generated' : 'passed',
      });
    } catch (error) {
      reports.push({
        preset: entry.key,
        contentId,
        milliseconds: Math.round(performance.now() - started),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (existsSync(path.join(root, 'artifacts'))) {
        const destination = path.join(
          source,
          'artifacts',
          'generated',
          `${entry.key}-${process.platform}`,
        );
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(root, 'artifacts'), destination, { recursive: true });
      }
    }
  }
} finally {
  mkdirSync(path.join(source, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(source, 'artifacts', `template-${process.platform}.json`),
    `${JSON.stringify({ schema: 1, node: process.version, os: process.platform, sourceSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim() || null, sourceContentId: sourceId(source), generatedFrom: JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8')).version, reports }, null, 2)}\n`,
  );
  if (temporary) rmSync(output, { recursive: true, force: true });
}
