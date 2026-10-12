import { assertInput, fixedInput } from './web-agent-input.mjs';
import { recordCommand } from './web-agent-run.mjs';
const mode = process.argv[2];
if (!['pre-pr', 'full', 'ci'].includes(mode)) throw new Error('Invalid standard gate');
const argv = mode === 'full' ? ['pnpm', 'gate:full'] :
  ['pnpm', `gate:${mode}`, '--', '--base', fixedInput().baseSha, ...(mode === 'ci' ? ['--checks', 'javascript'] : [])];
await recordCommand(mode, argv, assertInput, assertInput);
