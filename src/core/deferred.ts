export type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

/** A promise with its settle functions exposed — `Promise.withResolvers` for Node 20. */
export function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  let reject: ((reason: unknown) => void) | undefined
  const promise = new Promise<T>((onValue, onError) => {
    resolve = onValue
    reject = onError
  })
  // the executor runs synchronously, so both are assigned by now
  return {promise, resolve: resolve!, reject: reject!}
}
