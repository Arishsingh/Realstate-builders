import type { AppError, AppErrorCode, Result } from '../src/shared/types';

/** An error with a code the UI knows how to explain. */
export class AppFailure extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppFailure) return { code: err.code, message: err.message };
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const netCode = e?.cause?.code ?? e?.code;
  if (e?.name === 'TimeoutError' || ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(netCode))) {
    return { code: 'NETWORK', message: 'Network error: could not reach the server. Check your internet connection and try again.' };
  }
  return { code: 'UNKNOWN', message: e?.message || String(err) };
}

export async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: toAppError(err) };
  }
}
