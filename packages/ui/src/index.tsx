import { useCallback, useEffect, useState } from 'react';
import { noteInput, type Note, type NoteInput } from '@starter/contracts';

export type NotesAdapter = {
  list(this: void): Promise<Note[]>;
  add(this: void, input: NoteInput): Promise<Note>;
  remove(this: void, id: string): Promise<void>;
  export(this: void, notes: readonly Note[]): Promise<void>;
};

export function NotesPanel({ adapter, storage }: { adapter: NotesAdapter; storage: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setNotes(await adapter.list());
    } catch {
      setError('Notes could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  useEffect(() => {
    let current = true;
    void adapter
      .list()
      .then(
        (items) => {
          if (current) setNotes(items);
        },
        () => {
          if (current) setError('Notes could not be loaded. Try again.');
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [adapter]);

  const mutation = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError('The operation failed. Your existing notes have been kept.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Notes" className="mx-auto max-w-2xl rounded-xl border p-6">
      <h1 className="text-3xl font-semibold">Notes</h1>
      <p className="my-3 text-sm">{storage}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = noteInput.safeParse({ text });
          if (!parsed.success) {
            setError('Enter a note between 1 and 1000 characters.');
            return;
          }
          void mutation(async () => {
            const note = await adapter.add(parsed.data);
            setNotes((current) => [...current, note]);
            setText('');
            setAnnouncement('Note added.');
          });
        }}
      >
        <label htmlFor="note-text" className="block font-medium">
          New note
        </label>
        <textarea
          id="note-text"
          name="text"
          readOnly={loading}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={1000}
          aria-describedby="note-hint"
          className="my-2 w-full rounded border p-2"
        />
        <p id="note-hint" className="text-sm">
          Up to 1000 characters. Data is private to this local sample.
        </p>
        <button
          type="submit"
          disabled={loading || busy}
          className="my-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        >
          Add note
        </button>
      </form>
      {loading && <p role="status">Loading notes…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void reload();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && notes.length === 0 && !error && <p>No notes yet. Add your first note.</p>}
      <ul aria-label="Saved notes">
        {notes.map((note) => (
          <li
            key={note.id}
            className="my-3 flex items-center justify-between gap-4 rounded border p-3"
          >
            <p className="whitespace-pre-wrap break-all">{note.text}</p>
            <button
              type="button"
              aria-label={`Delete ${note.text}`}
              disabled={busy}
              onClick={() => {
                void mutation(async () => {
                  await adapter.remove(note.id);
                  setNotes((current) => current.filter((item) => item.id !== note.id));
                  setAnnouncement('Note deleted.');
                });
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={loading || busy}
        onClick={() => {
          void mutation(() => adapter.export(notes));
        }}
        className="rounded border px-4 py-2"
      >
        Export JSON
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
