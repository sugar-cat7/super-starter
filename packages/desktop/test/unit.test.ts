import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeNotes } from '../src/native';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn<typeof invoke>() }));
describe('typed native adapter (renderer unit tests, separate from native E2E)', () => {
  it('checks backend data and propagates an IPC failure', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([{ id: 'invalid' }]);
    await expect(nativeNotes.list()).rejects.toThrow('Invalid');
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(nativeNotes.add({ text: 'note' })).rejects.toThrow('IPC unavailable');
  });
  it('never sends a caller-supplied save path to the backend', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await nativeNotes.export([]);
    expect(invoke).toHaveBeenLastCalledWith('export_notes');
  });
});
