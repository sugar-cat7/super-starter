import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => {
  const environment = mode === 'offline' ? 'local' : (mode ?? 'local');
  if (!['local', 'dev', 'production'].includes(environment))
    throw new Error(`Unknown environment: ${environment}`);
  const required = (key: string) => {
    const value = process.env[key];
    if (!value)
      throw new Error(
        `${key} is required for ${environment}; run deploy:preflight and configure the named environment`,
      );
    return value;
  };
  return {
    worker: {
      name: 'super-starter-api',
      entrypoint,
      compatibilityDate: '2026-10-09',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false,
      env: {
        WRITE_MODE: bindings.text(environment === 'local' ? 'allow' : 'deny'),
        NOTES: bindings.d1({
          id:
            environment === 'local'
              ? 'e250999d-1f4e-4fa6-8cd2-5799da5fd582'
              : required('D1_DATABASE_ID'),
        }),
        NOTE_CACHE: bindings.kv({
          id: environment === 'local' ? 'super-starter-api-local' : required('KV_NAMESPACE_ID'),
        }),
        NOTE_EXPORTS: bindings.r2({
          name: environment === 'local' ? 'super-starter-api-local' : required('R2_BUCKET_NAME'),
        }),
      },
    },
  };
});
