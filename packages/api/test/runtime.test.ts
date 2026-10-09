import { describe, expect, it } from 'vitest';
import { noteSchema, notesSchema } from '@starter/contracts';

const origin = process.env.STARTER_TEST_ORIGIN;
if (!origin) throw new Error('Use pnpm test:runtime to start real workerd before HTTP tests');
const fetchLocal = (route: string, init?: RequestInit) => fetch(new URL(route, origin), init);

describe('real workerd HTTP contract', () => {
  it('serves health, validates input and completes CRUD', async () => {
    expect((await fetchLocal('/health')).status).toBe(200);
    const invalid = await fetchLocal('/api/notes', { method: 'POST', body: '{"text":""}' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input' } });
    const added = await fetchLocal('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ text: 'Runtime note' }),
    });
    expect(added.status).toBe(201);
    const note = noteSchema.parse(await added.json());
    const listed = await fetchLocal('/api/notes');
    expect(listed.headers.get('x-storage-mode')).toBe('persistent-d1');
    expect(notesSchema.parse(await listed.json())).toContainEqual(note);
    expect((await fetchLocal(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetchLocal(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetchLocal('/api/notes/not-a-uuid', { method: 'DELETE' })).status).toBe(400);
  });
  it('exercises only the selected KV and R2 bindings, and refuses absent features', async () => {
    for (const [feature, selected] of [
      ['kv', true],
      ['r2', true],
    ] as const) {
      const response = await fetchLocal(`/extensions/${feature}`, {
        method: 'POST',
        body: JSON.stringify({ key: 'runtime-test', value: 'stored locally' }),
      });
      expect(response.status).toBe(selected ? 200 : 404);
      const read = await fetchLocal(`/extensions/${feature}?key=runtime-test`);
      expect(read.status).toBe(selected ? 200 : 404);
      expect(await read.json()).toMatchObject(
        selected ? { value: 'stored locally' } : { error: { code: 'not_found' } },
      );
    }
  });
});
