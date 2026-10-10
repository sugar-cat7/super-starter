import { z } from 'zod/mini';

// HTML maxlength and the native adapter use UTF-16 units; Zod maxLength counts code points.
const noteLength = z.superRefine<string>((text, context) => {
  if (text.length > 1000)
    context.addIssue({ code: 'too_big', origin: 'string', maximum: 1000, inclusive: true });
});

export const noteInput = z.strictObject({
  text: z.string().check(z.trim(), z.minLength(1), noteLength),
});
export const noteSchema = z.strictObject({
  id: z.uuid(),
  text: z.string().check(z.minLength(1), noteLength),
  createdAt: z.int().check(z.gte(0)),
});
export const notesSchema = z.array(noteSchema);
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export type NoteInput = z.infer<typeof noteInput>;
