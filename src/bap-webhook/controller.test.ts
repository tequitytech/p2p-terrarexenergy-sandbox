/**
 * Tests for bap-webhook/controller.ts
 * 
 * Covers: onSelect, onInit, onConfirm, onStatus, onUpdate, onRating, onSupport, onTrack, onCancel
 * All external services mocked
 */

import { Request, Response } from 'express';
import { mockRequest, mockResponse } from '../test-utils';

// Mock dependencies
jest.mock('../services/order-service', () => ({
    orderService: {
        saveBuyerOrder: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.mock('../services/transaction-store', () => ({
    hasPendingTransaction: jest.fn(),
    resolvePendingTransaction: jest.fn()
}));

jest.mock('../services/settlement-store', () => ({
    settlementStore: {
        createSettlement: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.mock('../services/notification-service', () => ({
    notificationService: {
        sendOrderConfirmation: jest.fn().mockResolvedValue(undefined)
    }
}));

import {
    onSelect, onInit, onConfirm, onStatus,
    onUpdate, onRating, onSupport, onTrack, onCancel
} from './controller';
import { orderService } from '../services/order-service';
import { hasPendingTransaction, resolvePendingTransaction } from '../services/transaction-store';
import { settlementStore } from '../services/settlement-store';
import { notificationService } from '../services/notification-service';

const mockedHasPending = hasPendingTransaction as jest.MockedFunction<typeof hasPendingTransaction>;
const mockedResolvePending = resolvePendingTransaction as jest.MockedFunction<typeof resolvePendingTransaction>;

describe('bap-webhook/controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const createWebhookRequest = (action: string, transactionId: string, message: any = {}, error?: any) => {
        return mockRequest({
            context: {
                transaction_id: transactionId,
                action,
                bpp_id: 'test-bpp',
                bpp_uri: 'https://test-bpp.com'
            },
            message,
            error
        });
    };

    describe('onSelect', () => {
        it('should return ACK for valid on_select', () => {
            const req = createWebhookRequest('on_select', 'txn-123', { quotes: [] });
            const { res, status, json } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onSelect(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
            expect(json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should resolve pending transaction if exists', () => {
            const req = createWebhookRequest('on_select', 'txn-pending', { quotes: [] });
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(true);

            onSelect(req as Request, res as Response);

            expect(mockedResolvePending).toHaveBeenCalledWith('txn-pending', expect.objectContaining({
                context: expect.any(Object),
                message: expect.any(Object)
            }));
        });

        it('should handle error in on_select', () => {
            const req = createWebhookRequest('on_select', 'txn-err', {}, { code: 'ITEM_NOT_FOUND' });
            const { res, status } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onSelect(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
        });
    });

    describe('onInit', () => {
        it('should return ACK for valid on_init', () => {
            const req = createWebhookRequest('on_init', 'txn-init', { order: {} });
            const { res, status, json } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onInit(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
            expect(json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should resolve pending transaction', () => {
            const req = createWebhookRequest('on_init', 'txn-init-pending', { order: {} });
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(true);

            onInit(req as Request, res as Response);

            expect(mockedResolvePending).toHaveBeenCalledWith('txn-init-pending', expect.any(Object));
        });
    });

    describe('onConfirm', () => {
        it('should return ACK and create settlement for valid on_confirm', async () => {
            const order = {
                'beckn:orderItems': [
                    { 'beckn:quantity': { unitQuantity: 10 }, 'beckn:orderedItem': 'item-1' }
                ],
                'beckn:orderAttributes': { utilityIdSeller: 'BESCOM' }
            };
            const req = createWebhookRequest('on_confirm', 'txn-confirm', { order });
            const { res, status, json } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onConfirm(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
            expect(json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(orderService.saveBuyerOrder).toHaveBeenCalled();
            expect(settlementStore.createSettlement).toHaveBeenCalled();
        });

        it('should not create settlement when error present', async () => {
            const req = createWebhookRequest('on_confirm', 'txn-err', {}, { code: 'PAYMENT_FAILED' });
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onConfirm(req as Request, res as Response);

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(settlementStore.createSettlement).not.toHaveBeenCalled();
        });

        it('should resolve pending transaction', () => {
            const req = createWebhookRequest('on_confirm', 'txn-pending', { order: {} });
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(true);

            onConfirm(req as Request, res as Response);

            expect(mockedResolvePending).toHaveBeenCalledWith('txn-pending', expect.any(Object));
        });

        it('should calculate total quantity from multiple order items', async () => {
            const order = {
                'beckn:orderItems': [
                    { 'beckn:quantity': { unitQuantity: 5 } },
                    { 'beckn:quantity': { unitQuantity: 10 } },
                    { 'beckn:quantity': { unitQuantity: 3 } }
                ]
            };
            const req = createWebhookRequest('on_confirm', 'txn-multi', { order });
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onConfirm(req as Request, res as Response);

            await new Promise(resolve => setTimeout(resolve, 100));

            // Total should be 18
            expect(settlementStore.createSettlement).toHaveBeenCalledWith(
                'txn-multi',
                expect.any(String),
                18,
                'BUYER',
                expect.any(String),
                null
            );
        });
    });

    describe('onStatus', () => {
        it('should return ACK for on_status', () => {
            const req = createWebhookRequest('on_status', 'txn-status', { order: { status: 'IN_PROGRESS' } });
            const { res, status, json } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onStatus(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
            expect(json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    describe('onUpdate', () => {
        it('should return ACK for on_update', () => {
            const req = createWebhookRequest('on_update', 'txn-update', { order: {} });
            const { res, status, json } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onUpdate(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
            expect(json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should resolve pending transaction', () => {
            const req = createWebhookRequest('on_update', 'txn-upd-pending', {});
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(true);

            onUpdate(req as Request, res as Response);

            expect(mockedResolvePending).toHaveBeenCalled();
        });
    });

    describe('onRating', () => {
        it('should return ACK for on_rating', () => {
            const req = createWebhookRequest('on_rating', 'txn-rate', { rating: 5 });
            const { res, status } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onRating(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
        });
    });

    describe('onSupport', () => {
        it('should return ACK for on_support', () => {
            const req = createWebhookRequest('on_support', 'txn-support', {});
            const { res, status } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onSupport(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
        });
    });

    describe('onTrack', () => {
        it('should return ACK for on_track', () => {
            const req = createWebhookRequest('on_track', 'txn-track', { tracking: {} });
            const { res, status } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onTrack(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
        });
    });

    describe('onCancel', () => {
        it('should return ACK for on_cancel', () => {
            const req = createWebhookRequest('on_cancel', 'txn-cancel', { cancellation: {} });
            const { res, status } = mockResponse();

            mockedHasPending.mockReturnValue(false);

            onCancel(req as Request, res as Response);

            expect(status).toHaveBeenCalledWith(200);
        });

        it('should resolve pending cancel transaction', () => {
            const req = createWebhookRequest('on_cancel', 'txn-cancel-pending', {});
            const { res } = mockResponse();

            mockedHasPending.mockReturnValue(true);

            onCancel(req as Request, res as Response);

            expect(mockedResolvePending).toHaveBeenCalled();
        });
    });
});
