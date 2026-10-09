import { describe, expect, it } from 'vitest';
import { noteSchema, notesSchema } from '@starter/contracts';

const origin = process.env.STARTER_TEST_ORIGIN;
if (!origin) throw new Error('Use pnpm test:runtime to start real workerd before HTTP tests');

describe('Web Worker and same-origin API', () => {
  it('returns server-rendered HTML and communicates through the selected transport', async () => {
    const html = await fetch(new URL('/', origin));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('New note');
    const added = await fetch(new URL('/api/notes', origin), {
      method: 'POST',
      body: JSON.stringify({ text: 'Same-origin note' }),
    });
    expect(added.status).toBe(201);
    const note = noteSchema.parse(await added.json());
    expect(
      notesSchema.parse(await (await fetch(new URL('/api/notes', origin))).json()),
    ).toContainEqual(note);
    const removed = await fetch(new URL(`/api/notes/${note.id}`, origin), { method: 'DELETE' });
    await removed.arrayBuffer();
    expect(removed.status).toBe(204);
  });
});
