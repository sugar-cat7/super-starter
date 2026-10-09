import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { applyFiles, walk } from '../generators/files.ts';
import { installHooks } from './hooks.ts';
import { pnpm } from '../process.ts';
import { contentId } from './gate.ts';
import { hookPhases } from './definitions.ts';
import { baselineDifferences } from '../generators/baseline.ts';

export async function hookRehearsal(project: string): Promise<void> {
  const started = performance.now();
  let status: 'passed' | 'failed' = 'failed';
  const owned = mkdtempSync(path.join(os.tmpdir(), 'starter-hooks-'));
  const root = path.join(owned, 'project');
  const remote = path.join(owned, 'remote.git');
  const git = (args: string[], expected = true, cwd = root, input?: string): string => {
    const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 10 * 60_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (expected) assert.equal(result.status, 0, output);
    else {
      assert.notEqual(result.status, 0, 'Fault must reject the Git operation');
      assert.match(output, /no-debugger/u, output);
    }
    return output;
  };
  const good = "export const hookProbe = 'valid';\n";
  const bad = "debugger;\nexport const hookProbe = 'invalid';\n";
  try {
    const ignored = new Set([
      'node_modules',
      '.git',
      '.state',
      '.cloudflare',
      'dist',
      'target',
      'artifacts',
      'test-results',
      'playwright-report',
      '.template-cache',
    ]);
    applyFiles(
      root,
      new Map(
        walk(project, '', ignored).map((filename) => [
          filename,
          readFileSync(path.join(project, filename)),
        ]),
      ),
    );
    await pnpm(['env:setup'], { cwd: root, timeout: 10 * 60_000 });
    git(['init', '-q']);
    git(['config', 'user.name', 'Template rehearsal']);
    git(['config', 'user.email', 'template-rehearsal@example.invalid']);
    installHooks(root);
    installHooks(root);
    git(['add', '.']);
    git(['commit', '-m', 'Valid initial generated project']);
    const probe = path.join(root, 'tools/hook-probe.ts');
    writeFileSync(probe, good);
    git(['add', 'tools/hook-probe.ts']);
    writeFileSync(probe, bad);
    git(
      ['commit', '-m', 'Valid index with invalid unstaged source'],
      true,
      path.join(root, 'packages'),
    );
    assert.equal(readFileSync(probe, 'utf8'), bad, 'Hook must preserve unstaged content');
    assert.equal(git(['show', 'HEAD:tools/hook-probe.ts']).trim(), good.trim());
    git(['add', 'tools/hook-probe.ts']);
    writeFileSync(probe, good);
    const head = git(['rev-parse', 'HEAD']);
    git(['commit', '-m', 'Invalid index with valid unstaged source'], false);
    assert.equal(git(['rev-parse', 'HEAD']), head, 'Rejected commit must not advance HEAD');
    assert.equal(readFileSync(probe, 'utf8'), good, 'Hook must preserve unstaged correction');
    assert.equal(git(['show', ':tools/hook-probe.ts']).trim(), bad.trim(), 'Hook must not restage');
    git(['add', 'tools/hook-probe.ts']);
    git(['commit', '--allow-empty', '-m', 'Repaired index and empty-diff hook']);
    git(['init', '--bare', '-q', remote]);
    git(['push', remote, 'HEAD:refs/heads/test']);
    const before = git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']);
    const blob = git(['hash-object', '-w', '--stdin'], true, root, bad).trim();
    git(['update-index', '--cacheinfo', `100644,${blob},tools/hook-probe.ts`]);
    const invalidTree = git(['write-tree']).trim();
    // Plumbing simulates a commit created through an entry without hooks; CI/push must still reject it.
    const invalidCommit = git(
      ['commit-tree', invalidTree, '-p', 'HEAD'],
      true,
      root,
      'Injected committed lint fault\n',
    ).trim();
    git(['reset', '-q', 'HEAD', '--', 'tools/hook-probe.ts']);
    git(['push', remote, `${invalidCommit}:refs/heads/test`], false);
    assert.equal(
      git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']),
      before,
      'Rejected push must preserve remote ref',
    );
    const repairedTree = git(['rev-parse', 'HEAD^{tree}']).trim();
    const repaired = git(
      ['commit-tree', repairedTree, '-p', invalidCommit],
      true,
      root,
      'Repair committed fault\n',
    ).trim();
    git(['push', remote, `${repaired}:refs/heads/test`, `${repaired}:refs/heads/second`]);
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/test']).trim(), repaired);
    const linked = path.join(owned, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD']);
    try {
      await pnpm(['env:setup'], { cwd: linked, timeout: 10 * 60_000 });
      writeFileSync(path.join(linked, 'tools/linked-probe.ts'), good);
      git(['add', '.'], true, linked);
      git(['commit', '-m', 'Linked worktree hook'], true, path.join(linked, 'packages'));
      assert.equal(
        git(['diff', '--name-only']),
        '',
        'Linked worktree must not change original worktree',
      );
    } finally {
      git(['worktree', 'remove', '--force', linked]);
    }
    mkdirSync(path.join(root, 'user-hooks'));
    writeFileSync(path.join(root, 'user-hooks/pre-commit'), 'owned');
    git(['config', '--local', 'core.hooksPath', 'user-hooks']);
    assert.throws(() => installHooks(root), /Existing core.hooksPath/u);
    assert.equal(readFileSync(path.join(root, 'user-hooks/pre-commit'), 'utf8'), 'owned');
    console.log(
      'Real Git index/partial-stage, subdirectory, push-ref, linked-worktree and existing-hook protection passed',
    );
    status = 'passed';
  } finally {
    mkdirSync(path.join(project, 'artifacts'), { recursive: true });
    const state = JSON.parse(readFileSync(path.join(project, '.template.json'), 'utf8')) as {
      origin?: unknown;
    };
    writeFileSync(
      path.join(project, 'artifacts/hooks.json'),
      `${JSON.stringify({ schema: 1, baselineDifferences: baselineDifferences(project), phases: status === 'passed' ? hookPhases : [], status, origin: state.origin, contentId: contentId(project), os: process.platform, milliseconds: Math.round(performance.now() - started) }, null, 2)}\n`,
    );
    rmSync(owned, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith(`${path.sep}hooks-rehearsal.ts`)) await hookRehearsal(process.cwd());
