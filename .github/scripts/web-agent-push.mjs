import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertInput, fixedInput } from './web-agent-input.mjs';
import { recordCommand, directory } from './web-agent-run.mjs';

const bare = path.join(directory, 'owned-origin.git');
await recordCommand('bootstrap-bare', ['git', 'init', '--bare', bare], assertInput, assertInput);
await recordCommand('bootstrap-origin', ['git', 'remote', 'add', 'origin', bare], assertInput, assertInput);
await recordCommand('push', ['git', 'push', '--set-upstream', 'origin', 'feat/notes-count'], assertInput, assertInput);
const sha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/feat/notes-count'], { encoding: 'utf8' }).trim();
if (sha !== fixedInput().featureSha) throw new Error('Actual bare remote does not contain exact pushed feature');
writeFileSync(path.join(directory, 'bare-push-proof.json'), JSON.stringify({ bare, featureSha: sha, normalHooks: true }, null, 2) + '\n');
