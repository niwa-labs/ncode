/**
 * Canonical request-snapshot boundary (W04, bridge to W03 C3 RequestSnapshot).
 *
 * The pin's agent loop calls `prepareRequest` immediately before EVERY
 * conversational provider request — including the first one of a run (the pin
 * itself treats `prepareNextTurn` as the skip stage for a first request, not
 * `prepareRequest`). This module turns that native hook into the port plan's
 * C-obligation «обязательный canonical snapshot на каждом prepareRequest,
 * включая first/retry/virtual-model switch»: one immutable snapshot per
 * LOGICAL request, minted from the host's W02-backed projection (W03
 * `ProjectionService.snapshot()`), logged per the logging spec, and reused
 * verbatim by physical transport retries of the same request.
 *
 * The structural types below are intentionally narrower than the W03 exports
 * (`@mavis/context-projection` `RequestSnapshot`/`ProjectionRevision`): a W03
 * snapshot object satisfies them without agent-core taking a package
 * dependency on the projection layer. Object identity is never assumed —
 * revision identity is the address (W03 contract).
 */

import type { PrepareRequest, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiTurnRunnerLogger } from './types.js';

/** Revision identity of a canonical snapshot (W03 `ProjectionRevision`, structural). */
export interface CanonicalRequestRevision {
  readonly conversationId: string;
  readonly rootId: string;
  readonly head: number;
  readonly watermark: number;
  readonly schemaVersion: number;
  readonly editVersion: number;
  readonly windowBytes: number;
}

/** Model route a snapshot was resolved for (W03 `RequestSnapshotRoute`, structural). */
export interface CanonicalRequestRoute {
  readonly provider: string;
  readonly modelId: string;
}

/** One immutable canonical snapshot per logical provider request (W03 `RequestSnapshot`, structural). */
export interface CanonicalRequestSnapshot {
  readonly requestId: string;
  readonly sessionId: string;
  readonly revision: CanonicalRequestRevision;
  readonly tokenEstimate: number;
  readonly route: CanonicalRequestRoute | null;
}

/** Context handed to the host supplier at each prepareRequest boundary. */
export interface PrepareRequestSnapshotContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** Deterministic logical-request id minted by this boundary; retries reuse it. */
  readonly requestId: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  /** 0-based logical request counter within this run (first request = 0). */
  readonly requestIndex: number;
  readonly phase: 'first' | 'next';
}

/**
 * Host supplier over the W02 storage adapter + W03 projection. Returns the
 * immutable snapshot for this logical request, or `undefined` when the host
 * bridge cannot serve one (degradation is logged, never thrown through the
 * request path).
 */
export type PrepareRequestSnapshotSupplier = (
  context: PrepareRequestSnapshotContext,
) => Promise<CanonicalRequestSnapshot | undefined> | CanonicalRequestSnapshot | undefined;

export interface RequestSnapshotBoundary {
  /** Native pin hook: called by the loop before every conversational request. Absent on the legacy path. */
  readonly prepareRequest: PrepareRequest | undefined;
  /** Snapshots in request order (empty until the host wired a supplier). */
  readonly snapshots: () => readonly CanonicalRequestSnapshot[];
}

export function createRequestSnapshotBoundary(options: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly logger: PiTurnRunnerLogger;
  readonly supplier?: PrepareRequestSnapshotSupplier;
}): RequestSnapshotBoundary {
  const { sessionId, turnId, logger, supplier } = options;
  const recorded: CanonicalRequestSnapshot[] = [];
  if (!supplier) {
    return {
      // Legacy path (no durable/projection bridge wired): the hook stays absent
      // from the Agent config so behavior is byte-identical to before.
      prepareRequest: undefined,
      snapshots: () => recorded,
    };
  }

  const prepareRequest: PrepareRequest = async (request) => {
    const requestIndex = recorded.length;
    const context: PrepareRequestSnapshotContext = {
      sessionId,
      turnId,
      requestId: `${turnId}#req${requestIndex}`,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      requestIndex,
      phase: requestIndex === 0 ? 'first' : 'next',
    };
    try {
      const snapshot = await supplier(context);
      if (!snapshot || snapshot.requestId !== context.requestId) {
        // The supplier must adopt the boundary-minted request id: retries and
        // observers correlate snapshots by it. A foreign id is a bridge defect.
        logger.warn?.(
          {
            event: 'turn_request_snapshot_rejected',
            session_id: sessionId,
            turn_id: turnId,
            request_id: context.requestId,
            reason: !snapshot ? 'supplier_returned_undefined' : 'request_id_mismatch',
          },
          '[pi-turn-runner] canonical request snapshot rejected; request proceeds without one',
        );
        return;
      }
      const previous = recorded[recorded.length - 1];
      recorded.push(snapshot);
      logger.info?.(
        {
          event: 'turn_request_snapshot',
          session_id: sessionId,
          turn_id: turnId,
          request_id: snapshot.requestId,
          request_index: context.requestIndex,
          phase: context.phase,
          provider: snapshot.route?.provider ?? request.model.provider,
          model_id: snapshot.route?.modelId ?? request.model.id,
          revision_head: snapshot.revision.head,
          revision_watermark: snapshot.revision.watermark,
          revision_edit_version: snapshot.revision.editVersion,
          window_bytes: snapshot.revision.windowBytes,
          token_estimate: snapshot.tokenEstimate,
          ...(previous?.route && snapshot.route && routeChanged(previous.route, snapshot.route)
            ? { route_changed: true }
            : {}),
        },
        '[pi-turn-runner] canonical request snapshot taken at prepareRequest',
      );
    } catch (error) {
      // Observability/admission bridge failures degrade to a snapshot-less
      // request; they must never abort or mutate the turn (logging never
      // throws through correctness).
      logger.warn?.(
        {
          event: 'turn_request_snapshot_failed',
          session_id: sessionId,
          turn_id: turnId,
          request_id: context.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        '[pi-turn-runner] canonical request snapshot supplier threw; request proceeds without one',
      );
    }
    return;
  };

  return { prepareRequest, snapshots: () => [...recorded] };
}

function routeChanged(previous: CanonicalRequestRoute, current: CanonicalRequestRoute): boolean {
  return previous.provider !== current.provider || previous.modelId !== current.modelId;
}
