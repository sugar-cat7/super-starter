import { describe, expect, it } from 'vitest';
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
});
