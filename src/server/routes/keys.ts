/**
 * keys.ts
 * Express Router exposing the 3 Backend Key Management APIs:
 * - POST /api/keys/check-quota
 * - GET  /api/keys
 * - POST /api/keys/refresh
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  CheckQuotaRequestSchema,
  ListKeysQuerySchema,
  RefreshKeyRequestSchema,
} from '../../shared/contracts';
import type { KeyService } from '../services/key-service';

export function createKeysRouter(keyService: KeyService): Router {
  const router = Router();

  /**
   * POST /api/keys/check-quota
   * Check real-time subscription status and quota for a key or email.
   */
  router.post('/check-quota', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CheckQuotaRequestSchema.parse(req.body);
      const result = await keyService.checkQuota(parsed);
      res.json(result);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: err.issues.map((i) => i.message).join('; '),
          issues: err.issues,
        });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/keys
   * List keys from pool with filtering, pagination, and JSON/Text format options.
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = ListKeysQuerySchema.parse(req.query);
      const result = await keyService.listKeys(query);

      if (query.format === 'text') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(result);
        return;
      }

      res.json(result);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: err.issues.map((i) => i.message).join('; '),
          issues: err.issues,
        });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/keys/refresh
   * Refresh a key via Re-authentication or Provisioning a new key from standby pool.
   */
  router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RefreshKeyRequestSchema.parse(req.body);
      const result = await keyService.refreshKey(parsed);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: err.issues.map((i) => i.message).join('; '),
          issues: err.issues,
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: 'REFRESH_FAILED',
        message: err.message || 'Failed to refresh key',
      });
    }
  });

  return router;
}
