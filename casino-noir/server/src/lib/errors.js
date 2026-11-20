export class AppError extends Error {
  constructor(code, message, status = 400, extra = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (code, message, status, extra) => { throw new AppError(code, message, status, extra); };

/** Validate with zod; throws a 400 with a readable Russian message. */
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    fail('VALIDATION', `Проверьте поле «${i.path.join('.') || 'запрос'}»: ${i.message}`, 400);
  }
  return r.data;
}
