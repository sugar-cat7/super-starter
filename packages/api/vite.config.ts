import { defineConfig } from 'vite-plus';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    cloudflare({
      persistState: {
        path: `${process.env.STARTER_STATE_ROOT ?? fileURLToPath(new URL('../../.state', import.meta.url).href)}/api`,
      },
      inspectorPort: false,
      experimental: { newConfig: { cfBuildOutput: true } },
    }),
  ],
  server: { port: Number(process.env.STARTER_PORT ?? 8787), strictPort: true },
});
