import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertInput, fixedInput } from './web-agent-input.mjs';
import { recordCommand, directory } from './web-agent-run.mjs';
const mode = process.argv[2];
if (!['pre-pr', 'full', 'ci'].includes(mode)) throw new Error('Invalid standard gate');
const argv = mode === 'full' ? ['pnpm', 'gate:full'] :
  ['pnpm', `gate:${mode}`, '--', '--base', fixedInput().baseSha, ...(mode === 'ci' ? ['--checks', 'javascript'] : [])];
try {
  await recordCommand(mode, argv, assertInput, assertInput);
} finally {
  const archive = path.join(directory, 'gate-phase-evidence', mode);
  mkdirSync(archive, { recursive: true });
  for (const file of [`artifacts/gate-${mode}-${mode === 'ci' ? 'javascript' : 'all'}-linux.json`,
    'packages/web/artifacts', 'packages/api/artifacts', 'packages/web/test-results']) {
    if (existsSync(file)) cpSync(file, path.join(archive, file), { recursive: true, errorOnExist: true, force: false });
  }
}
