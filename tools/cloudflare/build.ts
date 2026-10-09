import { pnpm } from '../process.ts';

// Vite owns build/typegen. cf consumes its SDK-generated Build Output directory.
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error('Worker build interrupted'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await pnpm(['exec', 'vp', 'build', '--mode', process.env.STARTER_BUILD_MODE ?? 'offline'], {
    cwd: process.cwd(),
    signal: cancellation.signal,
    // Finish nested cleanup before an owning runner's three-second escalation.
    terminationGraceMs: 1_000,
  });
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
