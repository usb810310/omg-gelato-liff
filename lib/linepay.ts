import { createHmac, randomUUID } from 'node:crypto';
import { getPaymentDisplayStatus, isOrderRefunded, isOrderRejected, isOrderTerminal } from '@/lib/order-status';
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
  acceptReturnCodes = [],
}: {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  acceptReturnCodes?: string[];
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
  let data: T & { returnCode?: string; resultCode?: string | number; returnMessage?: string; statusMessage?: string };
  try {
    data = JSON.parse(encodeLargeIntegers(rawResponse));
  } catch {
    throw new Error(`LINE Pay 回應格式錯誤（HTTP ${response.status}）`);
  }
  const returnCode = String(data.returnCode ?? data.resultCode ?? '');
  if (!response.ok || (returnCode !== '0000' && !acceptReturnCodes.includes(returnCode))) {
    const message = data.returnMessage || data.statusMessage || 'LINE Pay API 錯誤';
    throw new Error(`${message} (${returnCode || `HTTP ${response.status}`})`);
  }
  return data;
}

export async function findOrderByNo(orderNo: string | number) {
  const data = (await adminDatabaseRef('orders').get()).val() as Record<string, Omit<FirebaseOrder, 'key'>> | null;
  const matches = Object.entries(data || {}).filter(([, order]) => String(order?.orderNo) === String(orderNo));
  if (matches.length > 1) throw new Error('訂單編號對應多筆訂單，為避免操作錯單已停止處理');
  const match = matches[0];
  return match ? ({ ...match[1], key: match[0] } as FirebaseOrder) : null;
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

export async function completeLinePayRefund(order: FirebaseOrder, transactionId?: string) {
  const refundOrder = transactionId ? { ...order, linePayTransactionId: transactionId } : order;
  const orderRef = adminDatabaseRef(`orders/${order.key}`);
  const attemptStartedAt = Date.now();
  let alreadyRefunded = false;
  let anotherRefundIsInProgress = false;
  const claim = await orderRef.transaction((current) => {
    alreadyRefunded = false;
    anotherRefundIsInProgress = false;
    if (!current) return;
    const latest = current as FirebaseOrder;
    if (isOrderRefunded(latest)) {
      alreadyRefunded = true;
      return;
    }
    const previousAttemptAt = Number(latest.refundAttemptStartedAt || 0);
    if (String(latest.refundStatus || '').toLowerCase() === 'pending'
      && previousAttemptAt > 0 && attemptStartedAt - previousAttemptAt < REFUND_RETRY_DELAY_MS) {
      anotherRefundIsInProgress = true;
      return;
    }
    return {
      ...latest,
      linePayTransactionId: transactionId || latest.linePayTransactionId || refundOrder.linePayTransactionId || null,
      paymentStatus: 'refund_pending',
      refundStatus: 'pending',
      refundAttemptStartedAt: attemptStartedAt,
      refundError: null,
    };
  });
  if (alreadyRefunded) return { refunded: true, pending: false };
  if (!claim.committed) {
    if (anotherRefundIsInProgress) return { refunded: false, pending: true };
    throw new Error('退款狀態更新失敗，請稍後重試');
  }
  const claimedOrder = { ...refundOrder, ...(claim.snapshot.val() || {}), key: order.key } as FirebaseOrder;
  try {
    await refundLinePayOrder(claimedOrder);
  } catch (error) {
    // LINE Pay code 1165 means this transaction has already been refunded.
    if (!(error instanceof Error) || !error.message.includes('(1165)')) throw error;
  }
  const now = new Date().toISOString();
  await updateOrder(claimedOrder, {
    linePayTransactionId: claimedOrder.linePayTransactionId || null,
    payment: '已退款',
    paymentStatus: 'refunded',
    refundStatus: 'refunded',
    refunded: true,
    refundedAt: now,
    refundCompletedAt: now,
    paymentRefundedAt: now,
    refundAttemptStartedAt: null,
    refundError: null,
  });
  return { refunded: true, pending: false };
}

const REFUND_RETRY_DELAY_MS = 5 * 60 * 1000;

export class OrderCancellationError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'OrderCancellationError';
  }
}

export async function cancelWaitingOrder(orderNo: string, orderId: string | undefined, userId: string) {
  let resolvedOrderId = orderId;
  if (resolvedOrderId && !/^[A-Za-z0-9_-]{1,128}$/.test(resolvedOrderId)) {
    throw new OrderCancellationError('雲端訂單 key 格式錯誤', 400);
  }
  if (!resolvedOrderId) {
    const snapshot = await adminDatabaseRef('orders').orderByChild('userId').equalTo(userId).get();
    const matches: string[] = [];
    snapshot.forEach((child) => {
      const candidate = child.val() as FirebaseOrder | null;
      if (candidate && String(candidate.orderNo) === orderNo && child.key) matches.push(child.key);
      return false;
    });
    if (matches.length > 1) throw new OrderCancellationError('此訂單編號對應多筆會員訂單，請重新整理後重試', 409);
    resolvedOrderId = matches[0];
  }
  if (!resolvedOrderId) throw new OrderCancellationError('找不到這筆訂單', 404);
  const orderRef = adminDatabaseRef(`orders/${resolvedOrderId}`);
  const snapshot = await orderRef.get();
  const orderData = snapshot.val() as Omit<FirebaseOrder, 'key'> | null;
  const order = orderData ? { ...orderData, key: resolvedOrderId } as FirebaseOrder : null;
  if (!order || order.userId !== userId || String(order.orderNo) !== orderNo) {
    throw new OrderCancellationError('找不到這筆訂單', 404);
  }
  const existingRefundStatus = String(order.refundStatus || '').toLowerCase();
  if (isOrderTerminal(order)) {
    let pointsReversalPending = false;
    const reversalStatus = String(order.pointsReversalStatus || '').toLowerCase();
    const shouldRetryPointsReversal = !['reversed', 'not_required'].includes(reversalStatus);
    if (shouldRetryPointsReversal) {
      try {
        await reverseOrderPoints(orderNo, order.key);
      } catch (error) {
        pointsReversalPending = true;
        console.error('重試已取消訂單點數回收失敗:', error);
      }
    }
    if (order.cancelledBy === 'customer' && ['failed', 'pending'].includes(existingRefundStatus)) {
      try {
        const refundResult = await completeLinePayRefund(order);
        return { refunded: refundResult.refunded, refundPending: refundResult.pending, retried: true, pointsReversalPending };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'LINE Pay 自動退款失敗';
        await updateOrder(order, { refundStatus: 'failed', refundError: message, refundFailedAt: new Date().toISOString() });
        throw new OrderCancellationError(`訂單已取消，但自動退款仍未完成：${message}`, 502);
      }
    }
    if (order.cancelledBy === 'customer' || shouldRetryPointsReversal) {
      return {
        refunded: existingRefundStatus === 'refunded' || order.refunded === true,
        refundPending: existingRefundStatus === 'pending',
        retried: true,
        pointsReversalPending,
      };
    }
    throw new OrderCancellationError('訂單已處理，無需再次取消', 409);
  }
  const status = String(order.status || '').trim();
  if (isOrderTerminal(order) || !['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status)) {
    throw new OrderCancellationError('店家已接單或訂單已處理，請洽客服人員協助取消', 409);
  }
  const paymentStatus = getPaymentDisplayStatus(order);
  if (paymentStatus === '付款處理中') throw new OrderCancellationError('此訂單付款處理中，請洽客服人員協助取消', 409);
  const isPaidAtRead = paymentStatus === '已付款';
  if (isPaidAtRead && String(order.refundStatus || '').toLowerCase() === 'pending') {
    throw new OrderCancellationError('此訂單退款處理中，請稍後重新整理確認', 409);
  }
  if (isPaidAtRead && String(order.refundStatus || '').toLowerCase() === 'refunded') {
    throw new OrderCancellationError('此訂單已取消並完成退款', 409);
  }

  let isPaid = false;
  let paymentProcessingAtCancellation = false;
  const result = await orderRef.transaction((current) => {
    isPaid = false;
    paymentProcessingAtCancellation = false;
    const latest = current as FirebaseOrder | null;
    if (!latest || latest.userId !== userId || String(latest.orderNo) !== orderNo) return;
    const latestStatus = String(latest.status || '').trim();
    if (isOrderTerminal(latest) || !['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(latestStatus)) return;
    const latestPaymentStatus = getPaymentDisplayStatus(latest);
    if (latestPaymentStatus === '付款處理中') {
      paymentProcessingAtCancellation = true;
      return;
    }
    isPaid = latestPaymentStatus === '已付款';
    return {
      ...latest,
      status: 'cancelled',
      voided: true,
      cancelledBy: 'customer',
      cancelledAt: new Date().toISOString(),
      paymentStatus: isPaid ? 'refund_pending' : 'cancelled',
      refundStatus: isPaid ? 'pending' : null,
      pointsReversalStatus: 'pending',
      pointsReversalError: null,
    };
  });
  if (!result.committed) {
    if (paymentProcessingAtCancellation) throw new OrderCancellationError('此訂單付款處理中，請洽客服人員協助取消', 409);
    throw new OrderCancellationError('訂單狀態已更新，請重新整理後確認；如店家已接單，請洽客服人員', 409);
  }
  let pointsReversalPending = false;
  try {
    await reverseOrderPoints(orderNo, order.key);
  } catch (error) {
    pointsReversalPending = true;
    console.error('顧客取消後撤銷點數失敗:', error);
  }
  if (isPaid) {
    const cancelledOrder = { key: order.key, ...(result.snapshot.val() || {}) } as FirebaseOrder;
    try {
      const refundResult = await completeLinePayRefund(cancelledOrder);
      if (refundResult.pending) return { refunded: false, refundPending: true, retried: false, pointsReversalPending };
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
  return { refunded: isPaid, retried: false, pointsReversalPending };
}

export async function rejectOrderByStaff(orderNo: string, orderId: string | undefined, operator: string) {
  let order: FirebaseOrder | null = null;
  if (orderId) {
    const snapshot = await adminDatabaseRef(`orders/${orderId}`).get();
    const value = snapshot.val() as Omit<FirebaseOrder, 'key'> | null;
    if (value && String(value.orderNo) === String(orderNo)) order = { ...value, key: orderId } as FirebaseOrder;
  } else {
    order = await findOrderByNo(orderNo);
  }
  if (!order) throw new OrderCancellationError('找不到這筆訂單', 404);
  if (isOrderRejected(order)) {
    const refundStatus = String(order.refundStatus || '').trim().toLowerCase();
    const paymentStatus = String(order.paymentStatus || '').trim().toLowerCase();
    const needsRefundRetry = Boolean(order.linePayTransactionId)
      && !isOrderRefunded(order)
      && (['', 'failed', 'pending'].includes(refundStatus) || ['paid', '已付款', '已確認'].includes(paymentStatus));
    if (!needsRefundRetry) throw new OrderCancellationError('此訂單已處理，不能重複拒單', 409);
    try {
      const refundResult = await completeLinePayRefund(order);
      return { rejected: true, refunded: refundResult.refunded, refundPending: refundResult.pending, retried: true, pointsReversalPending: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LINE Pay 自動退款失敗';
      await updateOrder(order, { paymentStatus: 'refund_failed', refundStatus: 'failed', refundError: message, refundFailedAt: new Date().toISOString() });
      throw new OrderCancellationError(`訂單已拒絕，但自動退款尚未完成：${message}`, 502);
    }
  }
  if (isOrderTerminal(order)) throw new OrderCancellationError('此訂單已處理，不能重複拒單', 409);
  const currentStatus = String(order.status || '').trim();
  if (!['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(currentStatus)) {
    throw new OrderCancellationError('此訂單已接單或正在處理，不能拒單', 409);
  }
  const now = new Date().toISOString();
  let isPaid = false;
  let processingPayment = false;
  const orderRef = adminDatabaseRef(`orders/${order.key}`);
  const transition = await orderRef.transaction((current) => {
    const latest = current as FirebaseOrder | null;
    if (!latest || String(latest.orderNo) !== String(orderNo) || isOrderTerminal(latest)) return;
    const status = String(latest.status || '').trim();
    if (!['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status)) return;
    if (getPaymentDisplayStatus(latest) === '付款處理中') { processingPayment = true; return; }
    isPaid = getPaymentDisplayStatus(latest) === '已付款';
    return {
      ...latest,
      channel: latest.channel || 'online',
      status: 'rejected', rejected: true, processed: true,
      rejectedAt: now, rejectedBy: operator || 'POS',
      voided: true, paymentStatus: isPaid ? 'refund_pending' : 'cancelled',
      refundStatus: isPaid ? 'pending' : null,
      pointsReversalStatus: 'pending', pointsReversalError: null,
    };
  });
  if (!transition.committed) {
    if (processingPayment) throw new OrderCancellationError('此訂單付款處理中，請稍後再拒單', 409);
    throw new OrderCancellationError('訂單狀態已變更，請重新整理後確認', 409);
  }
  const rejectedOrder = { key: order.key, ...(transition.snapshot.val() || {}) } as FirebaseOrder;
  let pointsReversalPending = false;
  try { await reverseOrderPoints(orderNo, order.key); }
  catch (error) { pointsReversalPending = true; console.error('店家拒單後點數回收失敗:', error); }
  if (!isPaid) return { rejected: true, refunded: false, refundPending: false, pointsReversalPending };
  try {
    const refundResult = await completeLinePayRefund(rejectedOrder);
    return { rejected: true, refunded: refundResult.refunded, refundPending: refundResult.pending, pointsReversalPending };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LINE Pay 自動退款失敗';
    await updateOrder(rejectedOrder, { paymentStatus: 'refund_failed', refundStatus: 'failed', refundError: message, refundFailedAt: new Date().toISOString() });
    throw new OrderCancellationError(`訂單已拒絕，但自動退款尚未完成：${message}`, 502);
  }
}

export type { FirebaseOrder };
