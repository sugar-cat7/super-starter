import { describe, expect, it } from 'vitest';
import { noteInput, noteSchema } from './index';

describe('portable communication schemas', () => {
  it('normalizes user text and refuses missing, empty, extra and oversized input', () => {
    expect(noteInput.parse({ text: '  a note  ' })).toEqual({ text: 'a note' });
    expect(noteInput.parse({ text: '\uFEFFa note\uFEFF' })).toEqual({ text: 'a note' });
    expect(noteInput.parse({ text: '\u0085' })).toEqual({ text: '\u0085' });
    expect(noteInput.parse({ text: '\uFEFF\u0085note\u0085\uFEFF' })).toEqual({
      text: '\u0085note\u0085',
    });
    for (const input of [
      {},
      { text: '' },
      { text: '   ' },
      { text: '\uFEFF' },
      { text: 'x'.repeat(1001) },
      { text: 'valid', path: '/tmp/file' },
    ]) {
      expect(noteInput.safeParse(input).success).toBe(false);
    }
  });
  it('checks identifiers and time without relying on a platform SDK', () => {
    expect(noteSchema.safeParse({ id: 'not-a-uuid', text: 'note', createdAt: 1 }).success).toBe(
      false,
    );
    expect(
      noteSchema.parse({ id: '993a848f-d07f-43a2-85f8-333b05292ed4', text: 'note', createdAt: 1 })
        .text,
    ).toBe('note');
  });
  it('preserves maximum text, strict data and safe nonnegative integer time boundaries', () => {
    expect(noteInput.parse({ text: ` ${'x'.repeat(1000)} ` }).text).toHaveLength(1000);
    const note = { id: '993a848f-d07f-43a2-85f8-333b05292ed4', text: 'note', createdAt: 0 };
    expect(noteSchema.parse(note)).toEqual(note);
    for (const createdAt of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(noteSchema.safeParse({ ...note, createdAt }).success).toBe(false);
    expect(noteSchema.safeParse({ ...note, unexpected: true }).success).toBe(false);
  });
});
