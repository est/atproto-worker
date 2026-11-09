/**
 * SHA-256 helper (CLI-side).
 *
 * Historically this wrapped `node:crypto`, which made `cli/mst.js` unusable in
 * a browser/Worker bundle. It now re-exports the WebCrypto implementation from
 * `src/shared.js` so the whole MST/CID path is portable while preserving the
 * existing `import { sha256 } from './sha.js'` call sites.
 */

export { sha256 } from '../src/shared.js'
