import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  AIOStreamResponse,
  config as appConfig,
  createLogger,
  StremioTransformer,
} from '@aiostreams/core';
import { stremioStreamRateLimiter } from '../../middlewares/ratelimit.js';
import { trackResource } from '../../middlewares/analytics.js';

const router: Router = Router();

const logger = createLogger('server');

router.use(stremioStreamRateLimiter);
router.use(trackResource('stream'));

// ── Stream result cache ────────────────────────────────────────────────────
// Caches the fully-processed, transformed Stremio response so repeat requests
// for the same (user, type, id) skip the entire pipeline — addon fetches,
// service wrapping, filtering, dedup, sorting, precompute, formatting, etc.
//
// A dedicated in-memory Map (rather than the generic Cache class) avoids
// structuredClone overhead on large stream arrays and keeps the hot path
// allocation-free. The TTL is deliberately short (30s default) because stream
// availability changes over time; the cache absorbs rapid Stremio refreshes
// and back-to-back episode clicks without returning truly stale data.

interface CachedStreamResult {
  response: AIOStreamResponse;
  expiresAt: number;
}

const streamResultCache = new Map<string, CachedStreamResult>();
const STREAM_RESULT_CACHE_TTL_MS =
  (Number(process.env['STREAM_RESULT_CACHE_TTL']) || 30) * 1000;
const STREAM_RESULT_CACHE_MAX_ENTRIES = 1000;

function streamResultCacheKey(type: string, id: string, uuid?: string): string {
  return `${uuid ?? 'anon'}:${type}:${id}`;
}

function streamResultCacheGet(key: string): AIOStreamResponse | undefined {
  const entry = streamResultCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    streamResultCache.delete(key);
    return undefined;
  }
  // Refresh LRU recency (re-insert at end).
  streamResultCache.delete(key);
  streamResultCache.set(key, entry);
  return entry.response;
}

function streamResultCacheSet(
  key: string,
  response: AIOStreamResponse
): void {
  // Evict the oldest entry when at capacity.
  if (streamResultCache.size >= STREAM_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = streamResultCache.keys().next().value;
    if (oldest !== undefined) streamResultCache.delete(oldest);
  }
  streamResultCache.set(key, {
    response,
    expiresAt: Date.now() + STREAM_RESULT_CACHE_TTL_MS,
  });
}

// Periodic stale-entry eviction (belt-and-suspenders with lazy eviction).
const cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of streamResultCache) {
    if (now >= entry.expiresAt) streamResultCache.delete(key);
  }
}, 30_000);
cacheCleanupTimer.unref?.();

interface StreamParams {
  type: string;
  id: string;
}

router.get(
  '/:type/:id.json',
  async (
    req: Request<StreamParams>,
    res: Response<AIOStreamResponse>,
    next: NextFunction
  ) => {
    // Check if we have user data (set by middleware in authenticated routes)
    if (!req.userData) {
      // Return a response indicating configuration is needed
      res.status(200).json(
        StremioTransformer.createDynamicError('stream', {
          errorDescription: 'Please configure the addon first',
        })
      );
      return;
    }

    const { type, id } = req.params;

    // Try the result cache first. Stremio often re-requests the same
    // (type, id) when a user refreshes or clicks back-and-forth.
    const cacheKey = streamResultCacheKey(type, id, req.userData.uuid);
    const cached = streamResultCacheGet(cacheKey);
    if (cached) {
      logger.debug({ type, id }, 'stream result cache hit');
      res.status(200).json(cached);
      return;
    }

    const transformer = new StremioTransformer(req.userData);

    const provideSetting = appConfig.api.provideStreamData;
    const provideStreamData =
      provideSetting === null
        ? (req.headers['user-agent']?.includes('AIOStreams/') ?? false)
        : typeof provideSetting === 'boolean'
          ? provideSetting
          : provideSetting.includes(req.requestIp || '');

    try {
      const aiostreams = await new AIOStreams(req.userData).initialise();

      const disableAutoplay = await aiostreams.shouldStopAutoPlay(type, id);

      const response = await aiostreams.getStreams(id, type);
      const streamContext = aiostreams.getStreamContext();

      if (!streamContext) {
        throw new Error('Stream context not available');
      }

      const transformedResponse = await transformer.transformStreams(
        response,
        streamContext.toFormatterContext(response.data.streams),
        { provideStreamData, disableAutoplay }
      );

      // Cache the fully-processed result before responding so subsequent
      // requests skip the entire pipeline.
      streamResultCacheSet(cacheKey, transformedResponse);

      res.status(200).json(transformedResponse);
    } catch (error) {
      let errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let errors = [
        {
          description: errorMessage,
        },
      ];
      if (transformer.showError('stream', errors)) {
        logger.error(
          `Unexpected error during stream retrieval: ${errorMessage}`,
          error
        );
        res.status(200).json(
          StremioTransformer.createDynamicError('stream', {
            errorDescription: errorMessage,
          })
        );
        return;
      }
      next(error);
    }
  }
);

export default router;
