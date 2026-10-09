import { z } from 'zod/mini';

export const noteInput = z.strictObject({
  text: z.string().check(z.trim(), z.minLength(1), z.maxLength(1000)),
});
export const noteSchema = z.strictObject({
  id: z.uuid(),
  text: z.string().check(z.minLength(1), z.maxLength(1000)),
  createdAt: z.int().check(z.gte(0)),
});
export const notesSchema = z.array(noteSchema);
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export type NoteInput = z.infer<typeof noteInput>;
