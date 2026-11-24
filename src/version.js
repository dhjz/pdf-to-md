/**
 * Single source of truth for the runtime version.
 * Kept in sync with package.json; build.js asserts the two never drift.
 */
export const VERSION = '1.1.11';

/** Lowercase alias so consumers can read `PdfToMd.version` / `import { version }`. */
export const version = VERSION;
