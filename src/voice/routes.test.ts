/**
 * Tests for voice/routes.ts
 * 
 * Covers: POST /voice/intent
 */

import express from 'express';
import request from 'supertest';
import { voiceRoutes } from './routes';

// Mock the intent service (uses OpenAI)
jest.mock('./intent-service', () => ({
    classifyIntent: jest.fn()
}));

import { classifyIntent } from './intent-service';

const mockedClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;

describe('voice/routes', () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();

        app = express();
        app.use(express.json());

        // Mount with auth middleware simulation
        app.use('/api/voice', (req: any, res, next) => {
            req.user = { phone: '9876543210', userId: 'user-123' };
            next();
        }, voiceRoutes());
    });

    describe('POST /voice/intent', () => {
        it('should classify intent successfully', async () => {
            mockedClassifyIntent.mockResolvedValue({
                intent: 'buy_energy',
                confidence: 0.92,
                detected_language: 'en',
                entities: [
                    { name: 'quantity', value: 10 },
                    { name: 'price', value: 7.5 }
                ]
            });

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: 'I want to buy 10 units at 7.5 rupees' })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.intent).toBe('buy_energy');
            expect(response.body.data.confidence).toBe(0.92);
            expect(response.body.data.entities).toBeDefined();
        });

        it('should return low_confidence flag when confidence < 0.5', async () => {
            mockedClassifyIntent.mockResolvedValue({
                intent: 'unknown',
                confidence: 0.35,
                detected_language: 'en',
                entities: []
            });

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: 'hello world' })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.low_confidence).toBe(true);
        });

        it('should return 400 for empty text', async () => {
            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: '' })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe('VALIDATION_ERROR');
        });

        it('should return 400 for missing text field', async () => {
            const response = await request(app)
                .post('/api/voice/intent')
                .send({})
                .expect(400);

            expect(response.body.success).toBe(false);
        });

        it('should return 400 when text exceeds 50 words', async () => {
            const longText = 'word '.repeat(51);

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: longText })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error.message).toContain('50 word');
        });

        it('should return 503 when LLM service is unavailable', async () => {
            mockedClassifyIntent.mockRejectedValue(new Error('OpenAI API timeout'));

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: 'buy energy please' })
                .expect(503);

            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe('LLM_SERVICE_UNAVAILABLE');
        });

        it('should detect language from input', async () => {
            mockedClassifyIntent.mockResolvedValue({
                intent: 'buy_energy',
                confidence: 0.88,
                detected_language: 'hi',
                entities: [{ name: 'quantity', value: 5 }]
            });

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: 'मुझे 5 यूनिट चाहिए' })
                .expect(200);

            expect(response.body.data.detected_language).toBe('hi');
        });

        it('should include entity units in response', async () => {
            mockedClassifyIntent.mockResolvedValue({
                intent: 'sell_energy',
                confidence: 0.95,
                detected_language: 'en',
                entities: [
                    { name: 'quantity', value: 20 },
                    { name: 'price', value: 8 }
                ]
            });

            const response = await request(app)
                .post('/api/voice/intent')
                .send({ text: 'sell 20 units at 8 rupees' })
                .expect(200);

            expect(response.body.data.entities.quantity).toHaveProperty('unit');
            expect(response.body.data.entities.price).toHaveProperty('unit');
        });
    });
});
