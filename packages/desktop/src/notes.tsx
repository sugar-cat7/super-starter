import { useCallback, useEffect, useMemo, useState } from 'react';
import { launch, type PublicError, type Result } from '@independent-desktop/contracts';
import { NotesPanel, type NotesAdapter } from '@independent-desktop/ui';
import { nativeCount, nativeNotes } from './native';

type Count = () => Promise<Result<number, PublicError>>;

export function DesktopNotes({
  adapter = nativeNotes,
  count = nativeCount,
}: {
  adapter?: NotesAdapter;
  count?: Count;
}) {
  const [revision, setRevision] = useState(0);
  const [label, setLabel] = useState('Counting notes…');
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    setLabel('Counting notes…');
    setFailed(false);
    setRevision((current) => current + 1);
  }, []);
  const observed: NotesAdapter = useMemo(
    () => ({
      list: () => adapter.list(),
      async add(input) {
        const result = await adapter.add(input);
        if (result.ok) refresh();
        return result;
      },
      async remove(id) {
        const result = await adapter.remove(id);
        if (result.ok) refresh();
        return result;
      },
      export: (notes) => adapter.export(notes),
    }),
    [adapter, refresh],
  );

  useEffect(() => {
    let current = true;
    launch(
      async () => {
        const result = await count();
        if (!current) return;
        setFailed(!result.ok);
        setLabel(
          result.ok
            ? `${result.value} ${result.value === 1 ? 'note' : 'notes'}`
            : 'Note count unavailable.',
        );
      },
      () => {
        if (!current) return;
        setFailed(true);
        setLabel('Note count unavailable.');
      },
    );
    return () => {
      current = false;
    };
  }, [count, revision]);

  return (
    <>
      <div className="mx-auto mb-3 max-w-2xl">
        <output aria-label="Note count" aria-live="polite" aria-atomic="true">
          {label}
        </output>
        {failed && (
          <button type="button" className="ml-3 rounded border px-3 py-1" onClick={refresh}>
            Retry note count
          </button>
        )}
      </div>
      <NotesPanel
        adapter={observed}
        storage="Offline sample: notes are kept in memory until this window closes. JSON exports use the save destination you choose."
      />
    </>
  );
}
