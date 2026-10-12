import { assertInput } from './web-agent-input.mjs';
import { recordCommand, directory } from './web-agent-run.mjs';
import path from 'node:path';
await recordCommand('final-git-bundle', ['git', 'bundle', 'create', path.join(directory, 'final-feature.bundle'), 'refs/heads/main', 'refs/heads/feat/notes-count'], assertInput, assertInput);
