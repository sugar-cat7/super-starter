import { z } from 'zod';

export const noteInput = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
export const noteSchema = z
  .object({
    id: z.uuid(),
    text: z.string().min(1).max(1000),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export const notesSchema = z.array(noteSchema);
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export type NoteInput = z.infer<typeof noteInput>;
