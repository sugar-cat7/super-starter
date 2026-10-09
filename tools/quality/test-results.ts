export function rustCases(output: string): number {
  const summaries = [
    ...output.matchAll(
      /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/gu,
    ),
  ];
  const passed = summaries.reduce((total, match) => total + Number(match[1]), 0);
  if (
    !passed ||
    summaries.some((match) => [2, 3, 4, 5].some((index) => Number(match[index]) !== 0))
  )
    throw new Error(
      'Required Rust tests must execute cases without failures, ignored or filtered tests',
    );
  return passed;
}

export function nativeCases(reports: unknown[]): number {
  let passed = 0;
  for (const report of reports) {
    const value = report as {
      state?: { passed?: number; failed?: number; skipped?: number };
      suites?: { tests?: { state: string }[] }[];
    };
    const tests = value.suites?.flatMap((suite) => suite.tests ?? []) ?? [];
    if (
      value.state?.failed ||
      value.state?.skipped ||
      tests.some((test) => test.state !== 'passed')
    )
      throw new Error('Required native tests contain failed, skipped or pending cases');
    passed += tests.length;
  }
  if (!passed) throw new Error('Required native tests collected zero cases');
  return passed;
}

export function vitestCases(report: unknown): number {
  const value = report as {
    numTotalTests: number;
    numPassedTests: number;
    numPendingTests: number;
    numTodoTests: number;
    numFailedTests: number;
  };
  if (
    !value.numTotalTests ||
    value.numPassedTests !== value.numTotalTests ||
    value.numPendingTests ||
    value.numTodoTests ||
    value.numFailedTests
  )
    throw new Error('Required test run must execute cases without failed, skipped or todo tests');
  return value.numPassedTests;
}

export function browserCases(report: unknown): number {
  const value = report as {
    stats?: { expected: number; unexpected: number; skipped: number; flaky: number };
  };
  if (!value.stats?.expected || value.stats.unexpected || value.stats.skipped || value.stats.flaky)
    throw new Error(
      'Required browser tests must execute cases without failed, skipped or flaky tests',
    );
  return value.stats.expected;
}
