import { invoke } from '@tauri-apps/api/core';
import { noteSchema, notesSchema } from '@starter/contracts';
import type { NotesAdapter } from '@starter/ui';

export const nativeNotes: NotesAdapter = {
  async list() {
    return notesSchema.parse(await invoke<unknown>('list_notes'));
  },
  async add(input) {
    return noteSchema.parse(await invoke<unknown>('add_note', { text: input.text }));
  },
  async remove(id) {
    await invoke<void>('delete_note', { id });
  },
  async export() {
    await invoke<string | null>('export_notes');
  },
};
