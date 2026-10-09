import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  verificationCases,
  projectOptions,
  selectedPackages,
  type ProjectOptions,
} from '../generators/options.ts';
import { walk } from '../generators/files.ts';
import {
  globalChecks,
  packageChecks,
  faultCheckIds,
  hookPhases,
  lifecyclePhases,
} from './definitions.ts';
import type { WorkspacePackage } from './graph.ts';
import { appFiles } from '../generators/render.ts';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../..', import.meta.url));
function canonicalPackages(options: ProjectOptions): WorkspacePackage[] {
  return selectedPackages(options).map((kind) => {
    const directory = `packages/${kind}`;
    const manifest = JSON.parse(
      appFiles(source, options, kind, kind, false).get(`${directory}/package.json`)!.toString(),
    ) as {
      name: string;
      starter?: { runtime?: WorkspacePackage['runtime'] };
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      name: manifest.name,
      directory,
      runtime: manifest.starter?.runtime ?? 'library',
      scripts: manifest.scripts,
      dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
    };
  });
}
function phasesComplete(
  actual: readonly { id: string; status: string; repaired?: boolean }[] | undefined,
  expected: string[],
  repaired = false,
): boolean {
  return (
    !!actual &&
    expected.length > 0 &&
    actual.length === expected.length &&
    expected.every((id) =>
      actual.some(
        (entry) =>
          entry.id === id && entry.status === 'passed' && (!repaired || entry.repaired === true),
      ),
    )
  );
}

type GateReport = {
  schema: number;
  sha: string;
  contentId: string;
  os: string;
  status?: string;
  origin?: { sha: string | null; dirty: boolean; contentId: string };
  configuration?: ProjectOptions;
  workspace?: WorkspacePackage[];
  tools: Record<string, unknown>;
  checks: {
    id: string;
    requirements: string[];
    command: string[];
    status: string;
    milliseconds: number;
  }[];
};

export function acceptance(directory: string, sha: string) {
  const inputs = existsSync(directory)
    ? walk(directory)
        .filter((file) => /^gate-full-all-(?:linux|darwin|win32)\.json$/u.test(path.basename(file)))
        .map((file) => ({
          file,
          report: JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as GateReport,
        }))
    : [];
  const rows = verificationCases.flatMap((entry) => {
    const expected = projectOptions({
      name: 'acceptance',
      scope: '@acceptance',
      preset: entry.preset,
      features: entry.features,
    });
    const platforms = entry.key === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux'];
    return platforms.map((os) => {
      const compatible = inputs.filter(
        ({ report }) =>
          report.schema === 1 &&
          report.os.startsWith(`${os}/`) &&
          report.configuration?.preset === expected.preset &&
          JSON.stringify(report.configuration.features.toSorted()) ===
            JSON.stringify(expected.features.toSorted()) &&
          report.origin?.sha === sha &&
          !report.origin.dirty,
      );
      const input = compatible.find(({ report }) => report.status === 'passed');
      const canonical = input?.report.configuration
        ? canonicalPackages(input.report.configuration)
        : [];
      const expectedChecks = [
        ...globalChecks,
        ...canonical.flatMap((pkg) => packageChecks(pkg, 'full')),
      ];
      const workspaceComplete =
        !!input?.report.workspace &&
        canonical.length === input.report.workspace.length &&
        canonical.every((pkg) =>
          input.report.workspace!.some(
            (entry) =>
              entry.name === pkg.name &&
              entry.runtime === pkg.runtime &&
              entry.directory === pkg.directory &&
              Object.keys(pkg.scripts).every((key) => entry.scripts[key] === pkg.scripts[key]),
          ),
        );
      const receiptFile = input
        ? path.join(directory, path.dirname(input.file), 'generation.json')
        : '';
      const receipt =
        receiptFile && existsSync(receiptFile)
          ? (JSON.parse(readFileSync(receiptFile, 'utf8')) as {
              schema: number;
              status: string;
              contentId: string;
              os: string;
              origin?: { sha?: string; dirty?: boolean };
              baselineDifferences?: string[];
            })
          : undefined;
      const receiptMatches =
        !!receipt &&
        receipt.schema === 1 &&
        receipt.status === 'passed' &&
        receipt.contentId === input?.report.contentId &&
        receipt.os === input?.report.os &&
        receipt.origin?.sha === sha &&
        receipt.origin.dirty === false &&
        Array.isArray(receipt.baselineDifferences) &&
        receipt.baselineDifferences.length === 0;
      const checks = expectedChecks.map((check) => {
        const result = input?.report.checks.find(
          (result) =>
            result.id === check.id &&
            JSON.stringify(result.command) === JSON.stringify(check.command),
        );
        return {
          ...check,
          status: result?.status ?? 'missing',
          milliseconds: result?.milliseconds ?? 0,
        };
      });
      const passed =
        !!input &&
        workspaceComplete &&
        receiptMatches &&
        checks.length > 0 &&
        checks.every((check) => check.status === 'passed');
      return {
        preset: entry.key,
        os,
        status: passed ? 'passed' : 'blocked',
        reason: passed
          ? 'All canonical checks ran successfully for this exact generation source'
          : 'Missing, failed or stale mandatory execution evidence',
        sha,
        contentId: input?.report.contentId ?? null,
        tools: input?.report.tools ?? null,
        evidence: input?.file ?? null,
        checks,
      };
    });
  });
  const mechanismCases = [
    ...['web', 'api-bindings', 'desktop'].flatMap((preset) =>
      (preset === 'desktop' ? ['linux', 'darwin', 'win32'] : ['linux']).map((os) => ({
        id: `faults-${preset}-${os}`,
        file: 'faults',
        preset,
        os,
      })),
    ),
    { id: 'hooks-linux', file: 'hooks', os: 'linux' },
    { id: 'hooks-win32', file: 'hooks', os: 'win32' },
    { id: 'lifecycle', file: 'lifecycle', os: 'linux' },
    { id: 'sanitization', file: 'sanitization' },
    ...['agent-web-api', 'agent-desktop', 'agent-package-add'].map((id) => ({ id, file: id })),
  ];
  const mechanisms = mechanismCases.map((mechanism) => {
    const files = existsSync(directory)
      ? walk(directory).filter((file) => path.basename(file) === `${mechanism.file}.json`)
      : [];
    const evidence = files.find((file) => {
      const report = JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as {
        schema?: number;
        sha?: string;
        origin?: { sha?: string; dirty?: boolean };
        status?: string;
        os?: string;
        contentId?: string;
        configuration?: ProjectOptions;
        phases?: string[];
        reports?: { id: string; status: string; repaired?: boolean }[];
        rules?: unknown[];
        failures?: unknown[];
        task?: string;
        agent?: { version?: string };
        execution?: string;
        independentContext?: boolean;
        commands?: { phase: string; argv: string[]; exit: number; log: string }[];
        featureSha?: string;
      };
      if (
        report.schema !== 1 ||
        report.status !== 'passed' ||
        !report.contentId ||
        !(report.sha === sha || (report.origin?.sha === sha && report.origin.dirty === false))
      )
        return false;
      if ('os' in mechanism && report.os !== mechanism.os) return false;
      if (mechanism.file === 'faults') {
        const entry = verificationCases.find(
          (entry) => entry.key === ('preset' in mechanism ? mechanism.preset : ''),
        )!;
        const options = projectOptions({
          name: 'matrix',
          scope: '@matrix',
          preset: entry.preset,
          features: entry.features,
        });
        if (
          report.configuration?.preset !== options.preset ||
          JSON.stringify(report.configuration.features.toSorted()) !==
            JSON.stringify(options.features.toSorted())
        )
          return false;
        return phasesComplete(
          report.reports,
          faultCheckIds(canonicalPackages(report.configuration)),
          true,
        );
      }
      if (mechanism.file === 'hooks')
        return (
          !!report.phases &&
          report.phases.length === hookPhases.length &&
          hookPhases.every((phase) => report.phases!.includes(phase))
        );
      if (mechanism.file === 'lifecycle') return phasesComplete(report.reports, lifecyclePhases);
      if (mechanism.file === 'sanitization')
        return !!report.rules?.length && report.failures?.length === 0;
      const required = [
        'setup',
        'doctor',
        'dev',
        'targeted-test',
        'pre-pr',
        'full',
        'build',
        'preflight',
        'commit',
        'push',
      ];
      const commandValid = (phase: string, argv: string[]): boolean => {
        const git = path.basename(argv[0] ?? '').replace(/\.exe$/u, '') === 'git';
        if (phase === 'commit' || phase === 'push') return git && argv.includes(phase);
        if (!argv.some((entry) => ['pnpm', 'pnpm.exe', 'mise'].includes(path.basename(entry))))
          return false;
        const token = (
          {
            setup: 'env:setup',
            doctor: 'env:doctor',
            dev: 'dev',
            'targeted-test': 'test',
            'pre-pr': 'gate:pre-pr',
            full: 'gate:full',
            build: 'build',
            preflight: 'deploy:preflight',
          } as Record<string, string>
        )[phase]!;
        return argv.some(
          (entry) =>
            entry === token ||
            ((phase === 'dev' || phase === 'targeted-test') && entry.startsWith(`${token}:`)) ||
            (phase === 'setup' && entry === 'setup'),
        );
      };
      return (
        report.execution === 'agent' &&
        report.independentContext === true &&
        !!report.task &&
        !!report.agent?.version &&
        /^[a-f0-9]{40}$/u.test(report.featureSha ?? '') &&
        !!report.commands?.length &&
        required.every((phase) =>
          report.commands!.some(
            (entry) =>
              entry.phase === phase &&
              entry.exit === 0 &&
              !!entry.log &&
              commandValid(phase, entry.argv),
          ),
        )
      );
    });
    return {
      id: mechanism.id,
      status: evidence ? 'passed' : 'blocked',
      evidence: evidence ?? null,
      reason: evidence
        ? 'Exact-source complete execution report'
        : 'Required actual execution report missing, incomplete, failed or stale',
    };
  });
  return {
    schema: 1,
    sha,
    status:
      rows.every((row) => row.status === 'passed') &&
      mechanisms.every((entry) => entry.status === 'passed')
        ? 'passed'
        : 'blocked',
    rows,
    mechanisms,
  };
}

if (process.argv[1]?.endsWith(`${path.sep}acceptance.ts`)) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (
    args.length !== 4 ||
    args[0] !== '--evidence' ||
    args[2] !== '--sha' ||
    !/^[a-f0-9]{40}$/u.test(args[3]!)
  )
    throw new Error(
      'Usage: node tools/quality/acceptance.ts --evidence <directory> --sha <generation-source-sha>',
    );
  const report = acceptance(path.resolve(args[1]!), args[3]!);
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/acceptance.json', `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Execution acceptance',
    '',
    `Source SHA: ${report.sha}`,
    `Result: **${report.status}**`,
    '',
    '| Preset | OS | Result | Evidence |',
    '| --- | --- | --- | --- |',
    ...report.rows.map(
      (row) => `| ${row.preset} | ${row.os} | ${row.status} | ${row.evidence ?? 'missing'} |`,
    ),
    '',
    ...report.mechanisms.map(
      (entry) => `- ${entry.id}: ${entry.status}; ${entry.evidence ?? entry.reason}`,
    ),
  ];
  writeFileSync('artifacts/acceptance.md', `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (report.status !== 'passed') process.exitCode = 1;
}
