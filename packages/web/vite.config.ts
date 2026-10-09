import { defineConfig } from 'vite-plus';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      inspectorPort: false,
      persistState: {
        path: `${process.env.STARTER_STATE_ROOT ?? fileURLToPath(new URL('../../.state', import.meta.url).href)}/web`,
      },
      experimental: { newConfig: { cfBuildOutput: true } },
    }),
    tanstackStart({ router: { quoteStyle: 'single', semicolons: true } }),
    react(),
    tailwind(),
  ],
  server: { port: Number(process.env.STARTER_PORT ?? 5173), strictPort: true },
});
