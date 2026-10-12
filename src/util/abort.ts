/** `promise`, or a rejection as soon as `signal` aborts — the work itself keeps going for whoever else waits on it. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, {once: true})
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
