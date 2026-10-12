// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Err,
  Ok,
  publicFailure,
  failure,
  type Note,
  type Result,
  type PublicError,
} from '@independent-native/contracts';
import type { NotesAdapter } from '@independent-native/ui';
import { DesktopNotes } from '../src/notes';

afterEach(cleanup);

function fixture() {
  let notes: Note[] = [];
  const adapter: NotesAdapter = {
    list: () => Promise.resolve(Ok(notes)),
    add: (input) => {
      const note = { id: crypto.randomUUID(), text: input.text, createdAt: Date.now() };
      notes = [...notes, note];
      return Promise.resolve(Ok(note));
    },
    remove: (id) => {
      notes = notes.filter((note) => note.id !== id);
      return Promise.resolve(Ok(undefined));
    },
    export: () => Promise.resolve(Ok(undefined)),
  };
  const count = vi.fn<() => Promise<Result<number, PublicError>>>(() =>
    Promise.resolve(Ok(notes.length)),
  );
  return { adapter, count };
}

describe('Desktop native count indicator (renderer regression)', () => {
  it('announces native count and refreshes it after successful add/delete', async () => {
    const { adapter, count } = fixture();
    const user = userEvent.setup();
    render(<DesktopNotes adapter={adapter} count={count} />);
    const status = screen.getByRole('status', { name: 'Note count' });
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    await waitFor(() => expect(status.textContent).toBe('0 notes'));
    await user.type(screen.getByRole('textbox', { name: 'New note' }), 'Count me');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(status.textContent).toBe('1 note'));
    await user.click(screen.getByRole('button', { name: 'Delete Count me' }));
    await waitFor(() => expect(status.textContent).toBe('0 notes'));
    expect(count).toHaveBeenCalledTimes(3);
  });

  it('shows count failure without a false zero, preserves notes, and offers accessible retry', async () => {
    const { adapter } = fixture();
    await adapter.add({ text: 'Kept note' });
    const count = vi
      .fn<() => Promise<Result<number, PublicError>>>()
      .mockResolvedValueOnce(Err(publicFailure(failure('state_unavailable'))))
      .mockResolvedValueOnce(Ok(1));
    const user = userEvent.setup();
    render(<DesktopNotes adapter={adapter} count={count} />);
    const status = screen.getByRole('status', { name: 'Note count' });
    await waitFor(() => expect(status.textContent).toBe('Note count unavailable.'));
    expect(screen.getByText('Kept note')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry note count' });
    retry.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(status.textContent).toBe('1 note'));
    expect(count).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Retry note count' })).toBeNull();
  });
});
