import { createHmac, randomUUID } from 'node:crypto';
import { getPaymentDisplayStatus, isOrderTerminal } from '@/lib/order-status';

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
  const databaseUrl = process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL;
  const response = await fetch(`${databaseUrl}/orders.json`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('無法讀取 Firebase 訂單資料');
  const data = (await response.json()) as Record<string, Omit<FirebaseOrder, 'key'>> | null;
  const match = Object.entries(data || {}).find(([, order]) => String(order?.orderNo) === String(orderNo));
  return match ? ({ key: match[0], ...match[1] } as FirebaseOrder) : null;
}

export async function updateOrder(order: FirebaseOrder, patch: Record<string, unknown>) {
  const databaseUrl = process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL;
  const response = await fetch(`${databaseUrl}/orders/${encodeURIComponent(order.key)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('無法更新 Firebase 訂單狀態');
}

export class OrderCancellationError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'OrderCancellationError';
  }
}

export async function cancelWaitingOrder(orderNo: string, userId: string) {
  const databaseUrl = process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL;
  const ordersResponse = await fetch(`${databaseUrl}/orders.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!ordersResponse.ok) throw new Error('無法讀取 Firebase 訂單資料');

  const orders = (await ordersResponse.json()) as Record<string, Omit<FirebaseOrder, 'key'>> | null;
  const match = Object.entries(orders || {}).find(([, order]) =>
    String(order?.orderNo) === orderNo && order?.userId === userId,
  );
  if (!match) throw new OrderCancellationError('找不到這筆訂單', 404);

  const [key] = match;
  const orderUrl = `${databaseUrl}/orders/${encodeURIComponent(key)}.json`;
  const response = await fetch(orderUrl, {
    headers: { 'X-Firebase-ETag': 'true' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('無法讀取 Firebase 訂單資料');

  const etag = response.headers.get('ETag');
  const order = (await response.json()) as FirebaseOrder | null;
  if (!order || order.userId !== userId || String(order.orderNo) !== orderNo) {
    throw new OrderCancellationError('找不到這筆訂單', 404);
  }
  if (!etag) throw new Error('無法確認訂單最新狀態');

  const status = String(order.status || '').trim();
  if (isOrderTerminal(order) || !['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status)) {
    throw new OrderCancellationError('店家已接單或訂單已處理，請洽客服人員協助取消', 409);
  }

  const paymentStatus = getPaymentDisplayStatus(order);
  if (paymentStatus === '已付款') {
    throw new OrderCancellationError('此訂單已付款，請洽客服人員辦理取消與退款', 409);
  }
  if (paymentStatus === '付款處理中') {
    throw new OrderCancellationError('此訂單付款處理中，請洽客服人員協助取消', 409);
  }

  const updateResponse = await fetch(orderUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify({
      ...order,
      status: 'cancelled',
      voided: true,
      cancelledBy: 'customer',
      cancelledAt: new Date().toISOString(),
      paymentStatus: 'cancelled',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (updateResponse.status === 412) {
    throw new OrderCancellationError('訂單狀態已更新，請重新整理後確認；如店家已接單，請洽客服人員', 409);
  }
  if (!updateResponse.ok) throw new Error('無法更新 Firebase 訂單狀態');
}

export type { FirebaseOrder };
