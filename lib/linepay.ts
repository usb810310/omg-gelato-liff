import { createHmac, randomUUID } from 'node:crypto';
import { getPaymentDisplayStatus, isOrderTerminal } from '@/lib/order-status';
import { reverseOrderPoints } from '@/lib/member-points';
import { adminDatabaseRef } from '@/lib/firebase-admin';

type LinePayConfig = {
  channelId: string;
  channelSecret: string;
  baseUrl: string;
  merchantDeviceProfileId?: string;
};

type FirebaseOrder = {
  key: string;
  orderNo?: string | number;
  userId?: string | null;
  total?: number | string;
  status?: string;
  payment?: string;
  paymentStatus?: string;
  linePayTransactionId?: string | number | null;
  refundStatus?: string;
  refunded?: boolean;
  refundedAt?: string;
  refundCompletedAt?: string;
  paymentRefundedAt?: string;
  voided?: boolean;
  rejected?: boolean;
  cancelledBy?: string;
  items?: Array<{ name?: string; price?: number; qty?: number; flavorDisplay?: string }>;
  [key: string]: unknown;
};

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';

export function getLinePayConfig(): LinePayConfig {
  const channelId = process.env.LINEPAY_CHANNEL_ID;
  const channelSecret = process.env.LINEPAY_CHANNEL_SECRET;
  if (!channelId || !channelSecret) {
    throw new Error('LINE Pay API 憑證尚未設定，請設定 LINEPAY_CHANNEL_ID 與 LINEPAY_CHANNEL_SECRET');
  }
  return {
    channelId,
    channelSecret,
    baseUrl: process.env.LINEPAY_API_BASE || 'https://api-pay.line.me',
    merchantDeviceProfileId: process.env.LINEPAY_MERCHANT_DEVICE_PROFILE_ID,
  };
}

export function getPublicSiteUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '');
  if (configured) return configured;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

export function getLiffReturnUrl() {
  return process.env.NEXT_PUBLIC_LIFF_URL || 'https://liff.line.me/2011536222-v4OvTSup';
}

function encodeLargeIntegers(text: string) {
  return text.replace(/:\s*(\d{16,})(?=\s*[,}])/g, ': "$1"');
}

export async function callLinePay<T>({
  method,
  path,
  body,
  timeoutMs = 40000,
}: {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}) {
  const config = getLinePayConfig();
  const nonce = randomUUID();
  const rawBody = body ? JSON.stringify(body) : '';
  const signature = createHmac('sha256', config.channelSecret)
    .update(config.channelSecret + path + rawBody + nonce)
    .digest('base64');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-LINE-Authorization': signature,
    'X-LINE-Authorization-Nonce': nonce,
    'X-LINE-ChannelId': config.channelId,
  };
  if (config.merchantDeviceProfileId) {
    headers['X-LINE-MerchantDeviceProfileId'] = config.merchantDeviceProfileId;
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: method === 'POST' ? rawBody : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const rawResponse = await response.text();
  let data: T & { returnCode?: string; returnMessage?: string; statusMessage?: string };
  try {
    data = JSON.parse(encodeLargeIntegers(rawResponse));
  } catch {
    throw new Error(`LINE Pay 回應格式錯誤（HTTP ${response.status}）`);
  }
  if (!response.ok || data.returnCode !== '0000') {
    const message = data.returnMessage || data.statusMessage || 'LINE Pay API 錯誤';
    throw new Error(`${message}（${data.returnCode || `HTTP ${response.status}`}）`);
  }
  return data;
}

export async function findOrderByNo(orderNo: string | number) {
  const data = (await adminDatabaseRef('orders').get()).val() as Record<string, Omit<FirebaseOrder, 'key'>> | null;
  const match = Object.entries(data || {}).find(([, order]) => String(order?.orderNo) === String(orderNo));
  return match ? ({ key: match[0], ...match[1] } as FirebaseOrder) : null;
}

export async function updateOrder(order: FirebaseOrder, patch: Record<string, unknown>) {
  await adminDatabaseRef(`orders/${order.key}`).update(patch);
}

async function refundLinePayOrder(order: FirebaseOrder) {
  const transactionId = String(order.linePayTransactionId || '').trim();
  if (!transactionId) throw new Error('找不到 LINE Pay 交易編號，無法自動退款');
  await callLinePay({
    method: 'POST',
    path: `/v4/payments/${encodeURIComponent(transactionId)}/refund`,
    body: {},
    timeoutMs: 45000,
  });
}

async function completeLinePayRefund(order: FirebaseOrder) {
  await refundLinePayOrder(order);
  const now = new Date().toISOString();
  await updateOrder(order, {
    payment: '已退款',
    paymentStatus: 'refunded',
    refundStatus: 'refunded',
    refunded: true,
    refundedAt: now,
    refundCompletedAt: now,
    paymentRefundedAt: now,
  });
}

export class OrderCancellationError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'OrderCancellationError';
  }
}

export async function cancelWaitingOrder(orderNo: string, userId: string) {
  const orders = (await adminDatabaseRef('orders').get()).val() as Record<string, Omit<FirebaseOrder, 'key'>> | null;
  const match = Object.entries(orders || {}).find(([, order]) => String(order?.orderNo) === orderNo && order?.userId === userId);
  if (!match) throw new OrderCancellationError('找不到這筆訂單', 404);
  const [key] = match;
  const orderRef = adminDatabaseRef(`orders/${key}`);
  const snapshot = await orderRef.get();
  const order = snapshot.val() as FirebaseOrder | null;
  if (!order || order.userId !== userId || String(order.orderNo) !== orderNo) {
    throw new OrderCancellationError('找不到這筆訂單', 404);
  }
  const existingRefundStatus = String(order.refundStatus || '').toLowerCase();
  if (order.cancelledBy === 'customer' && existingRefundStatus === 'failed') {
    try {
      await completeLinePayRefund(order);
      return { refunded: true, retried: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LINE Pay 自動退款失敗';
      await updateOrder(order, { refundStatus: 'failed', refundError: message, refundFailedAt: new Date().toISOString() });
      throw new OrderCancellationError(`訂單已取消，但自動退款仍未完成：${message}`, 502);
    }
  }
  const status = String(order.status || '').trim();
  if (isOrderTerminal(order) || !['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status)) {
    throw new OrderCancellationError('店家已接單或訂單已處理，請洽客服人員協助取消', 409);
  }
  const paymentStatus = getPaymentDisplayStatus(order);
  if (paymentStatus === '付款處理中') throw new OrderCancellationError('此訂單付款處理中，請洽客服人員協助取消', 409);
  const isPaid = paymentStatus === '已付款';
  if (isPaid && String(order.refundStatus || '').toLowerCase() === 'pending') {
    throw new OrderCancellationError('此訂單退款處理中，請稍後重新整理確認', 409);
  }
  if (isPaid && String(order.refundStatus || '').toLowerCase() === 'refunded') {
    throw new OrderCancellationError('此訂單已取消並完成退款', 409);
  }

  const result = await orderRef.transaction((current) => {
    const latest = current as FirebaseOrder | null;
    if (!latest || latest.userId !== userId || String(latest.orderNo) !== orderNo) return;
    const latestStatus = String(latest.status || '').trim();
    if (isOrderTerminal(latest) || !['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(latestStatus)) return;
    return {
      ...latest,
      status: 'cancelled',
      voided: true,
      cancelledBy: 'customer',
      cancelledAt: new Date().toISOString(),
      paymentStatus: isPaid ? 'refund_pending' : 'cancelled',
      refundStatus: isPaid ? 'pending' : null,
    };
  });
  if (!result.committed) throw new OrderCancellationError('訂單狀態已更新，請重新整理後確認；如店家已接單，請洽客服人員', 409);
  try {
    await reverseOrderPoints(orderNo);
  } catch (error) {
    console.error('顧客取消後撤銷點數失敗:', error);
  }
  if (isPaid) {
    const cancelledOrder = { ...order, status: 'cancelled', voided: true, cancelledBy: 'customer', paymentStatus: 'refund_pending' };
    try {
      await completeLinePayRefund(cancelledOrder);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LINE Pay 自動退款失敗';
      await updateOrder(order, {
        paymentStatus: 'refund_failed',
        refundStatus: 'failed',
        refundError: message,
        refundFailedAt: new Date().toISOString(),
      });
      throw new OrderCancellationError(`訂單已取消，但自動退款尚未完成：${message}`, 502);
    }
  }
  return { refunded: isPaid, retried: false };
}
export type { FirebaseOrder };
