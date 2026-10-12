import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { contentId } from '../../tools/quality/gate.ts';
import { artifactSizes, toolVersions } from '../../tools/quality/evidence.ts';
const state = JSON.parse(readFileSync('.template.json', 'utf8')) as {
  origin: { sha: string; dirty: boolean; contentId: string };
};
const commands = JSON.parse(readFileSync('artifacts/agent-desktop/commands.json', 'utf8')) as {
  phase: string;
  exit: number;
}[];
const phases = ['setup', 'doctor', 'dev', 'targeted-test', 'pre-pr', 'full', 'build', 'preflight'];
const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const report = {
  schema: 1,
  sha: state.origin.sha,
  origin: state.origin,
  contentId: contentId(process.cwd()),
  featureSha,
  status: phases.every((phase) =>
    commands.some((command) => command.phase === phase && command.exit === 0),
  )
    ? 'passed'
    : 'blocked',
  task: 'Add a native count_notes IPC command and accessible Desktop count indicator with normal/failure regression tests',
  agent: { version: 'Codex GPT-6 independent agent' },
  execution: 'agent',
  independentContext: true,
  os: process.platform,
  nativeExecution: 'actual target-OS Tauri app and Rust IPC; renderer tests reported separately',
  commands,
  versions: toolVersions(process.cwd()),
  artifacts: artifactSizes(process.cwd()),
};
writeFileSync('artifacts/agent-desktop/agent-desktop.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ featureSha, contentId: report.contentId, status: report.status, os: report.os }),
);
