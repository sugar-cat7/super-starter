import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeNotes, nativeCount } from '../src/native';
import { failure, publicFailure } from '@independent-native/contracts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn<typeof invoke>() }));
describe('typed native adapter (renderer unit tests, separate from native E2E)', () => {
  it('checks backend data and propagates an IPC failure', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([{ id: 'invalid' }]);
    await expect(nativeNotes.list()).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(nativeNotes.add({ text: 'note' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });
  it('validates native count payloads and preserves public failures', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    await expect(nativeCount()).resolves.toEqual({ ok: true, value: 0 });
    await expect(nativeCount()).resolves.toEqual({ ok: true, value: 2 });
    expect(invoke).toHaveBeenLastCalledWith('count_notes', {
      telemetry: { traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u) },
    });
    for (const invalid of [-1, 0.5, '2', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      vi.mocked(invoke).mockResolvedValueOnce(invalid);
      await expect(nativeCount()).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
    }
    const error = publicFailure(failure('state_unavailable'));
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(nativeCount()).resolves.toEqual({ ok: false, error });
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(nativeCount()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });
  it('never sends a caller-supplied save path to the backend', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await nativeNotes.export([]);
    expect(invoke).toHaveBeenLastCalledWith('export_notes', {
      telemetry: { traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u) },
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls.at(-1))).not.toContain('path');
  });
});
