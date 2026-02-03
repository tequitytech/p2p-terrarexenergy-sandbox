export interface EnergyRequest {
  _id?: string;
  userId: string;
  userName: string;
  isVerifiedBeneficiary: boolean;
  beneficiaryType?: 'social' | 'known';
  requiredEnergy: number;
  purpose: string;
  startTime: string; // ISO Stringw
  endTime: string; // ISO String
  status: 'PENDING' | 'FULFILLED' | 'CANCELLED' | 'PAYMENT_PENDING';
  createdAt: Date;
  updatedAt: Date;
  fulfilledBy?: string; // Seller/Provider ID if fulfilled
  transactionId?: string; // If linked to a transaction
}

export interface CreateEnergyRequestDTO {
  requiredEnergy: number;
  purpose: string;
  startTime: string;
  endTime: string;
}
