/**
 * Single seam between the history-import CLI and the canonical-history
 * authority in `@mavis/local-runtime-v2` (`./canonical-history`, an already
 * declared package export).
 *
 * The CLI must not restate the canonical envelope decoder or the revision
 * algorithm: the durable provider VALIDATES every seed commit against
 * `canonicalActiveHistoryRevision`, so an importer computing revisions with
 * anything else would write commits the runtime refuses (or, worse, accepts
 * records the decoder rejects). Both symbols are re-exported unchanged — the
 * module graph of `local-runtime-v2/src/infra/file/*` reaches nothing from
 * this adapter, so the import adds no cycle. The package-level dependency is
 * declared in `packages/v2-adapter/package.json` devDependencies.
 *
 * @module
 */

import {
  canonicalActiveHistoryRevision,
  decodeCanonicalHistoryEnvelope,
} from '@mavis/local-runtime-v2/canonical-history';

export { canonicalActiveHistoryRevision, decodeCanonicalHistoryEnvelope };
