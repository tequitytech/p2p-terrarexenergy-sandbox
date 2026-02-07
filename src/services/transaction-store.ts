interface PendingTransaction {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
  action: string;
  createdAt: Date;
}

const pendingTransactions = new Map<string, PendingTransaction>();
const CALLBACK_TIMEOUT = parseInt(process.env.CALLBACK_TIMEOUT || '30000', 10);

export async function createPendingTransaction(transactionId: string, action: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTransactions.delete(transactionId);
      reject(new Error(`Timeout waiting for on_${action} callback (${CALLBACK_TIMEOUT}ms)`));
    }, CALLBACK_TIMEOUT);

    pendingTransactions.set(transactionId, { resolve, reject, timeout, action, createdAt: new Date() });
  });
}

export function resolvePendingTransaction(transactionId: string, data: any): boolean {
  const pending = pendingTransactions.get(transactionId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingTransactions.delete(transactionId);
  pending.resolve(data);
  return true;
}

export function hasPendingTransaction(transactionId: string): boolean {
  return pendingTransactions.has(transactionId);
}

export function cancelPendingTransaction(transactionId: string): boolean {
  const pending = pendingTransactions.get(transactionId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingTransactions.delete(transactionId);
  return true;
}

export function getPendingCount(): number {
  return pendingTransactions.size;
}
