type OperationContext = {
  surface: 'admin' | 'master' | 'advisor' | 'counter';
  operation: string;
};

/** Diagnostics must never retry a command, expose its payload, or change its result. */
export async function observeServerOperation<T>(
  context: OperationContext,
  operation: () => T | PromiseLike<T>,
  options: { logSuccess?: boolean; slowAfterMs?: number } = {},
): Promise<T> {
  const startedAt = performance.now();
  const emit = (outcome: 'success' | 'error', error?: unknown) => {
    try {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (outcome === 'success' && !options.logSuccess && durationMs < (options.slowAfterMs ?? 1_000)) return;
      const candidate = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const errorCode = typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/.test(candidate) ? candidate : undefined;
      const record = JSON.stringify({
        event: 'vivo_operation',
        surface: context.surface,
        operation: context.operation,
        outcome,
        durationMs,
        ...(errorCode ? { errorCode } : {}),
      });
      if (outcome === 'error') console.error(record);
      else console.info(record);
    } catch {
      // A logging failure must not turn a committed payment into a retryable error.
    }
  };

  let result: T;
  try {
    result = await operation();
  } catch (error) {
    emit('error', error);
    throw error;
  }
  try {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : null;
    emit(error ? 'error' : 'success', error);
  } catch {
    // Inspecting diagnostics also remains separate from the operation result.
  }
  return result;
}
