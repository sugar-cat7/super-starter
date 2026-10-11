import { describe, expect, it, vi } from 'vitest';
import { handleNotes } from '../src/notes';

describe('API validation and safe publication defaults', () => {
  it('refuses writes in a deployment environment before touching storage', async () => {
    const response = await handleNotes(
      new Request('https://sample.invalid/api/notes', {
        method: 'POST',
        body: '{"text":"blocked"}',
      }),
      { WRITE_MODE: 'deny' },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'writes_disabled' } });
  });
  it('returns a predictable invalid JSON error without reflecting the request body', async () => {
    const response = await handleNotes(
      new Request('https://sample.invalid/api/notes', { method: 'POST', body: 'PRIVATE-TEXT' }),
      { WRITE_MODE: 'allow' },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('PRIVATE-TEXT');
    expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]+$/u);
  });
  it.each(['rejection', 'declared_failure'])(
    'normalizes D1 %s before HTTP projection and correlates the private-safe binding span',
    async (mode) => {
      const payloads: string[] = [];
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('Expected an OTLP JSON request');
        payloads.push(init.body);
        return Promise.resolve(Response.json({}));
      });
      try {
        const database = {
          prepare: () => ({
            all: () =>
              mode === 'rejection'
                ? Promise.reject(new Error('PRIVATE-SQL-DO-NOT-EXPORT'))
                : Promise.resolve({ success: false, error: 'PRIVATE-SQL-DO-NOT-EXPORT' }),
          }),
        } as unknown as D1Database;
        const response = await handleNotes(new Request('https://sample.invalid/api/notes'), {
          WRITE_MODE: 'allow',
          NOTES: database,
          OTEL_ENDPOINT: 'http://127.0.0.1:4318',
        });
        const body = (await response.json()) as { error: { code: string; diagnosticId: string } };
        // Storage failure has an unknown outcome, rather than a proven retryable network failure.
        expect(response.status).toBe(500);
        expect(body.error.code).toBe('internal_error');
        expect(body.error.diagnosticId).toMatch(/^[a-f0-9]{32}$/u);
        expect(response.headers.get('x-diagnostic-id')).toBe(body.error.diagnosticId);
        expect(response.headers.get('x-error-code')).toBe(body.error.code);
        const wire = payloads.join('\n');
        expect(wire).toContain('binding.d1.read');
        expect(wire).toContain('storage_failed');
        expect(wire).toContain(body.error.diagnosticId);
        expect(wire).not.toContain('PRIVATE-SQL');
        expect(JSON.stringify(body)).not.toContain('PRIVATE-SQL');
        const traces = JSON.parse(
          payloads.find((payload) => payload.includes('resourceSpans'))!,
        ) as {
          resourceSpans: {
            scopeSpans: {
              spans: {
                name: string;
                spanId: string;
                parentSpanId?: string;
                attributes: { key: string; value: { stringValue: string } }[];
              }[];
            }[];
          }[];
        };
        const spans = traces.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        );
        expect(spans).toHaveLength(2);
        const http = spans.find((span) => span.name === 'http.request')!;
        expect(spans.find((span) => span.name === 'binding.d1.read')!.parentSpanId).toBe(
          http.spanId,
        );
        for (const span of spans)
          expect(
            span.attributes.find((attr) => attr.key === 'app.diagnostic.id')!.value.stringValue,
          ).toBe(body.error.diagnosticId);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
