import { noteSchema, notesSchema, type Note } from '@starter/contracts';
import type { NotesAdapter } from '@starter/ui';

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
  return response;
}

export const browserNotes: NotesAdapter = {
  async list() {
    return notesSchema.parse(await (await request('/api/notes')).json());
  },
  async add(input) {
    return noteSchema.parse(
      await (
        await request('/api/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).json(),
    );
  },
  async remove(id) {
    await request(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async export(notes: readonly Note[]) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }),
    );
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'notes.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};
