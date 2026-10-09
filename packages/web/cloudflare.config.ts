import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/server.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => {
  const environment = mode === 'offline' ? 'local' : (mode ?? 'local');
  if (!['local', 'dev', 'production'].includes(environment))
    throw new Error(`Unknown environment: ${environment}`);
  return {
    worker: {
      name: 'super-starter-web',
      entrypoint,
      compatibilityDate: '2026-10-09',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false,
      env: {
        WRITE_MODE: bindings.text(environment === 'local' ? 'allow' : 'deny'),
        API: bindings.worker({ worker: 'super-starter-api' }),
      },
    },
  };
});
