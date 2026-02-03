import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { classifyIntent } from './intent-service';

const intentRequestSchema = z.object({
  text: z.string().min(1, 'Text is required').refine(
    (val) => val.trim().split(/\s+/).length <= 50,
    { message: 'Input text exceeds 50 word limit' }
  )
});

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues[0]?.message || 'Request validation failed',
          details: result.error.issues.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        }
      });
    }
    next();
  };
}

export function voiceRoutes(): Router {
  const router = Router();

  router.post('/intent', validateBody(intentRequestSchema), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const { text } = req.body;

    try {
      const result = await classifyIntent(text);
      const latencyMs = Date.now() - startTime;

      // Convert entities array to object keyed by name
      // time_window value can be structured { start, end } or string
      const entities: Record<string, { value: string | { start: string; end: string }; type: string }> = {};
      for (const e of result.entities) {
        entities[e.name] = { value: e.value, type: e.type };
      }

      // Logging (privacy: no input text logged)
      console.log('[voice/intent]', {
        timestamp: new Date().toISOString(),
        user_id: (req as any).user?.phone || 'unknown',
        intent: result.intent,
        confidence: result.confidence,
        language: result.detected_language,
        entity_count: result.entities.length,
        latency_ms: latencyMs
      });

      return res.json({
        success: true,
        data: {
          intent: result.intent,
          confidence: result.confidence,
          low_confidence: result.confidence < 0.5,
          detected_language: result.detected_language,
          entities
        }
      });
    } catch (error: any) {
      console.error('[voice/intent] Error:', error.message);

      return res.status(503).json({
        success: false,
        error: {
          code: 'LLM_SERVICE_UNAVAILABLE',
          message: 'Intent classification service temporarily unavailable'
        }
      });
    }
  });

  return router;
}
