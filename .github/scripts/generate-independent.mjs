import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve('source');
const out = path.join(root, 'artifacts/fresh-independent');
const sha = '0f9611c1c8e6934aa3f8d0fce924bcc9f4da9d5d';
const sourceCid = 'ab7ef5c3cd3b4f1fd2818c9acd965acefde447f172622a9da7761da4a214df60';
mkdirSync(out, { recursive: true });
const commands = [];
function run(phase, argv) {
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 12_000_000 });
  const log = `${String(commands.length + 1).padStart(2, '0')}-${phase}.log`;
  writeFileSync(path.join(out, log), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  commands.push({ phase, argv, milliseconds: Date.now() - started, exit: result.status, signal: result.signal, error: result.error?.message ?? null, log });
  writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  if (result.status !== 0) throw new Error(`${phase} failed`);
  return result.stdout.trim();
}
try {
  assert.equal(run('head', ['git', 'rev-parse', 'HEAD']), sha);
  assert.equal(run('initial-clean', ['git', 'status', '--porcelain']), '');
  run('setup', ['pnpm', 'env:setup', '--', '--javascript']);
  assert.equal(run('setup-clean', ['git', 'status', '--porcelain']), '');
  const { contentId } = await import(pathToFileURL(path.join(root, 'tools/quality/gate.ts')));
  assert.equal(contentId(root), sourceCid);
  const projects = [];
  for (const [id, name, scope, preset] of [
    ['desktop', 'independent-native-desktop', '@independent-native', 'desktop'],
    ['add', 'independent-status-api', '@independent-service', 'api'],
  ]) {
    const target = path.join(out, id);
    assert.equal(existsSync(target), false);
    run(`generate-${id}`, ['node', 'tools/generators/cli.ts', 'init', '--target', target, '--name', name, '--scope', scope, '--preset', preset, '--no-install']);
    const state = JSON.parse(readFileSync(path.join(target, '.template.json'), 'utf8'));
    assert.equal(state.origin.sha, sha);
    assert.equal(state.origin.dirty, false);
    assert.equal(state.kind, 'project');
    assert.equal(state.options.name, name);
    assert.equal(state.options.scope, scope);
    assert.equal(state.options.preset, preset);
    assert.deepEqual(state.options.features, []);
    const rendered = createHash('sha256');
    for (const [filename, digest] of Object.entries(state.managed)) {
      const contents = readFileSync(path.join(target, filename));
      assert.equal(createHash('sha256').update(contents).digest('hex'), digest, filename);
      rendered.update(`${filename}\0`);
      rendered.update(contents);
    }
    // This origin fingerprints the rendered configuration, rather than the
    // larger reference workspace fingerprint checked before generation.
    assert.equal(state.origin.contentId, rendered.digest('hex'));
    const archive = path.join(out, `${id}.zip`);
    const pack = "import pathlib,zipfile,sys; r=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(r).as_posix()) for p in sorted(r.rglob('*')) if p.is_file()]; z.close()";
    run(`archive-${id}`, ['python3', '-c', pack, target, archive]);
    const bytes = readFileSync(archive);
    projects.push({ id, options: state.options, origin: state.origin, archive: `${id}.zip`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentId: contentId(target) });
  }
  assert.equal(run('final-clean', ['git', 'status', '--porcelain']), '');
  assert.equal(run('final-head', ['git', 'rev-parse', 'HEAD']), sha);
  assert.equal(contentId(root), sourceCid);
  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schema: 1, kind: 'mechanical-fresh-generation', execution: 'hosted-tools', status: 'passed', sourceSha: sha, sourceCid, supportSha: process.env.GITHUB_SHA, commands, projects }, null, 2) + '\n');
  console.log('Two independent projects generated from the exact clean source');
} catch (error) {
  writeFileSync(path.join(out, 'failed.json'), JSON.stringify({ schema: 1, status: 'failed', sourceSha: sha, commands, error: String(error) }, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
}
