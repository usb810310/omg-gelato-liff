export type OrderStateRecord = {
  status?: unknown;
  payment?: unknown;
  paymentStatus?: unknown;
  refundStatus?: unknown;
  refunded?: unknown;
  refundedAt?: unknown;
  refundCompletedAt?: unknown;
  paymentRefundedAt?: unknown;
  voided?: unknown;
  rejected?: unknown;
  cancelledBy?: unknown;
};

const CANCELLED_ORDER_STATUSES = new Set(['cancelled', 'canceled', '已取消', '取消']);
const REJECTED_ORDER_STATUSES = new Set(['rejected', '拒單', '拒絕', '店家無法接單']);
const CANCELLED_PAYMENT_STATUSES = new Set(['cancelled', 'canceled', 'voided', '已取消', '取消']);
const PAID_STATUSES = new Set(['paid', '已付款', '已確認']);
const PROCESSING_STATUSES = new Set(['processing', '付款處理中']);
const FAILED_STATUSES = new Set(['failed', '付款失敗']);
const REFUNDED_STATUSES = new Set(['refunded', 'refund_completed', 'refund_succeeded', '已退款', '退款完成', '退款成功']);

function normalize(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function isTruthy(value: unknown) {
  return value === true || value === 1 || normalize(value) === 'true';
}

export function isOrderCancelled(order: OrderStateRecord) {
  return isTruthy(order.voided)
    || normalize(order.cancelledBy) === 'customer'
    || CANCELLED_ORDER_STATUSES.has(normalize(order.status));
}

export function isOrderRejected(order: OrderStateRecord) {
  return isTruthy(order.rejected) || REJECTED_ORDER_STATUSES.has(normalize(order.status));
}

export function isOrderRefunded(order: OrderStateRecord) {
  const refundStatus = normalize(order.refundStatus);
  const paymentStatus = normalize(order.paymentStatus);
  const payment = normalize(order.payment);
  return isTruthy(order.refunded)
    || Boolean(order.refundedAt || order.refundCompletedAt || order.paymentRefundedAt)
    || REFUNDED_STATUSES.has(refundStatus)
    || REFUNDED_STATUSES.has(paymentStatus)
    || REFUNDED_STATUSES.has(payment);
}

export function isPaymentCancelled(order: OrderStateRecord) {
  return CANCELLED_PAYMENT_STATUSES.has(normalize(order.paymentStatus))
    || CANCELLED_PAYMENT_STATUSES.has(normalize(order.payment));
}

export function isOrderTerminal(order: OrderStateRecord) {
  return isOrderCancelled(order) || isOrderRejected(order) || isOrderRefunded(order) || isPaymentCancelled(order);
}

export function getPaymentDisplayStatus(order: OrderStateRecord) {
  // 退款與取消是終態，必須先於舊資料殘留的 paid 判斷。
  if (isOrderRefunded(order)) return '已退款';
  if (isOrderCancelled(order) || isOrderRejected(order) || isPaymentCancelled(order)) return '已取消';

  const paymentStatus = normalize(order.paymentStatus);
  const payment = normalize(order.payment);
  if (PAID_STATUSES.has(paymentStatus) || PAID_STATUSES.has(payment)) return '已付款';
  if (PROCESSING_STATUSES.has(paymentStatus) || PROCESSING_STATUSES.has(payment)) return '付款處理中';
  if (FAILED_STATUSES.has(paymentStatus) || FAILED_STATUSES.has(payment)) return '付款失敗';
  return '尚未付款';
}
