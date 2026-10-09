import { pnpm } from '../process.ts';

// Vite owns build/typegen. cf consumes its SDK-generated Build Output directory.
await pnpm(['exec', 'vp', 'build', '--mode', process.env.STARTER_BUILD_MODE ?? 'offline'], {
  cwd: process.cwd(),
});
