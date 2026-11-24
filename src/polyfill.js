/**
 * Self-contained Promise.withResolvers polyfill.
 *
 * Kept dependency-free on purpose: the UMD build exports this function so the
 * host can inject the very same source into a pdf.js worker wrapper via
 * `PdfToMd.shimWR.toString()`.
 */
export function shimWR(scope = globalThis) {
  const P = scope && scope.Promise;
  if (!P || typeof P.withResolvers === 'function') return;
  P.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new P((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

shimWR(globalThis);
