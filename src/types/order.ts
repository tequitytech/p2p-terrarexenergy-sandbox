export enum OrderType {
    BUYER = "buyer",
    SELLER = "seller",
}

export enum OrderStatus {
    INITIATED = "INITIATED",
    PAID = "PAID",
    PENDING = "pending", // Used in payment txn
    SCHEDULED = "SCHEDULED",
    DELIVERED = "DELIVERED",
    CANCELLED = "CANCELLED",
}

export interface IOrder {
    _id?: any;
    transactionId: string;
    userId: string;
    userPhone?: string;
    type: OrderType;
    status: OrderStatus;
    createdAt: Date;
    updatedAt: Date;

    // Buyer specific
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
    txnPayId?: any; // MongoDB ObjectId string
    meterId?: string;
    sourceMeterId?: string;
    messageId?: string;
    items?: any;
    order?: any; // Full Beckn order details from on_confirm
    paymentId?: string;
    settlementId?: string;

    // Seller specific
    orderStatus?: string; // Legacy field used in getSellerOrders/updateSellerOrderStatus
}

export interface BuyerOrder extends IOrder {
    type: OrderType.BUYER;
}

export interface SellerOrder extends IOrder {
    type: OrderType.SELLER;
}
