import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { contentId } from '../../tools/quality/gate.ts';
import { assertCheckout, ownHeadSha } from '../../tools/quality/checkout.ts';

export function inputIdentity() {
  const state = JSON.parse(readFileSync('.template.json', 'utf8')) as {
    kind: string;
    options: { preset: string };
    origin: { sha: string; dirty: boolean; contentId: string };
  };
  return {
    featureSha: ownHeadSha(process.cwd()),
    contentId: contentId(process.cwd()),
    origin: state.origin,
    preset: state.options.preset,
    kind: state.kind,
    clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
  };
}

export function assertExpectedInput() {
  const actual = inputIdentity();
  const expected = {
    featureSha: process.env.GITHUB_SHA,
    contentId: process.env.AGENT_EXPECTED_CONTENT_ID,
    originSha: process.env.AGENT_EXPECTED_ORIGIN_SHA,
    originContentId: process.env.AGENT_EXPECTED_ORIGIN_CONTENT_ID,
  };
  if (
    !/^[a-f0-9]{40}$/u.test(expected.featureSha ?? '') ||
    !/^[a-f0-9]{64}$/u.test(expected.contentId ?? '') ||
    !/^[a-f0-9]{40}$/u.test(expected.originSha ?? '') ||
    !/^[a-f0-9]{64}$/u.test(expected.originContentId ?? '') ||
    actual.featureSha !== expected.featureSha ||
    actual.contentId !== expected.contentId ||
    actual.origin.sha !== expected.originSha ||
    actual.origin.contentId !== expected.originContentId ||
    actual.origin.dirty !== false ||
    !actual.clean ||
    actual.kind !== 'project' ||
    actual.preset !== 'desktop'
  )
    throw new Error(
      'Generated Desktop input does not match the dispatched clean feature/source identity',
    );
  assertCheckout(process.cwd(), expected.featureSha!);
  return actual;
}

if (process.argv[1]?.endsWith('desktop-agent-input.ts')) {
  const phase = process.argv[2];
  if (!['before-setup', 'after-setup', 'after-execution'].includes(phase ?? ''))
    throw new Error('Expected before-setup, after-setup or after-execution');
  const actual = assertExpectedInput();
  mkdirSync('artifacts/agent-desktop', { recursive: true });
  writeFileSync(
    `artifacts/agent-desktop/input-${phase}.json`,
    `${JSON.stringify(actual, null, 2)}\n`,
  );
  console.log(JSON.stringify({ phase, ...actual }));
}
