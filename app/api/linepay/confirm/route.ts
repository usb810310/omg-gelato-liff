import { NextResponse } from 'next/server';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { completeLinePayRefund, callLinePay, findOrderByNo, getLiffReturnUrl, updateOrder } from '@/lib/linepay';
import { reverseOrderPoints } from '@/lib/member-points';
import { getPaymentDisplayStatus, isOrderCancelled, isOrderRefunded, isOrderRejected, isOrderTerminal } from '@/lib/order-status';
import { buildPaymentSuccessCard, pushLineMessage } from '@/lib/line-notify';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const incomingUrl = new URL(request.url);
  const orderNo = incomingUrl.searchParams.get('orderId');
  const transactionId = incomingUrl.searchParams.get('transactionId');
  const returnUrl = new URL(getLiffReturnUrl());
  returnUrl.searchParams.set('orderNo', orderNo || '');
  returnUrl.searchParams.set('orderId', orderNo || '');

  async function notifyPaymentSuccess(order: Awaited<ReturnType<typeof findOrderByNo>>) {
    const recipientUserId = typeof order?.userId === 'string' ? order.userId.trim() : '';
    if (!recipientUserId || order?.paymentSuccessNotifiedAt) return;
    try {
      await pushLineMessage(recipientUserId, buildPaymentSuccessCard(order || {}));
      await updateOrder(order!, { paymentSuccessNotifiedAt: new Date().toISOString() });
    } catch (notificationError) {
      console.error('LINE Pay 已成功，但付款成功小卡推送失敗:', notificationError);
    }
  }

  async function reconcileAfterConfirmError(order: NonNullable<Awaited<ReturnType<typeof findOrderByNo>>>, transactionId: string) {
    const statusResponse = await callLinePay<{ returnCode?: string | number; info?: { payInfo?: unknown[] } }>({
      method: 'GET',
      path: `/v4/payments/requests/${encodeURIComponent(transactionId)}/check`,
      timeoutMs: 20000,
      acceptReturnCodes: ['0110', '0121', '0123'],
    });
    const statusCode = String(statusResponse.returnCode || '');
    if (statusCode === '0110') {
      const confirmed = await callLinePay<{ info?: { transactionId?: string | number; payInfo?: unknown[] } }>({
        method: 'POST',
        path: `/v4/payments/${encodeURIComponent(transactionId)}/confirm`,
        body: { amount: Number(order.total || 0), currency: 'TWD' },
        timeoutMs: 45000,
      });
      const patch = {
        payment: '已付款',
        paymentStatus: 'paid',
        linePayTransactionId: String(confirmed.info?.transactionId || transactionId),
        linePayConfirmedAt: new Date().toISOString(),
        linePayResult: confirmed.info?.payInfo || null,
        linePayError: null,
      };
      await updateOrder(order, patch);
      return { state: 'paid' as const, order: { ...order, ...patch } };
    }
    if (statusCode === '0123') {
      const patch = {
        payment: '已付款',
        paymentStatus: 'paid',
        linePayTransactionId: transactionId,
        linePayConfirmedAt: new Date().toISOString(),
        linePayResult: statusResponse.info?.payInfo || null,
        linePayError: null,
      };
      await updateOrder(order, patch);
      return { state: 'paid' as const, order: { ...order, ...patch } };
    }
    if (statusCode === '0121') {
      await updateOrder(order, { payment: '付款失敗', paymentStatus: 'failed', linePayError: '顧客取消付款或付款等待逾時', paymentFailedAt: new Date().toISOString() });
      return { state: 'failed' as const, order };
    }
    return { state: 'processing' as const, order };
  }

  try {
    if (!orderNo || !transactionId) {
      returnUrl.searchParams.set('payment', 'failed');
      returnUrl.searchParams.set('message', 'LINE Pay 回傳資料不完整');
      return NextResponse.redirect(returnUrl);
    }

    const order = await findOrderByNo(orderNo);
    if (!order) {
      returnUrl.searchParams.set('payment', 'failed');
      returnUrl.searchParams.set('message', '找不到對應訂單');
      return NextResponse.redirect(returnUrl);
    }
    // 顧客取消、店家拒單或退款完成後，即使舊的 LINE Pay 回呼晚到，也不能再寫回 paid。
    if (isOrderTerminal(order)) {
      returnUrl.searchParams.set('payment', isOrderRefunded(order) ? 'refunded' : 'cancelled');
      returnUrl.searchParams.set('message', isOrderRefunded(order) ? '訂單已退款，無法完成付款' : '訂單已取消，無法完成付款');
      return NextResponse.redirect(returnUrl);
    }
    if (getPaymentDisplayStatus(order) === '已付款') {
      returnUrl.searchParams.set('payment', 'success');
      await notifyPaymentSuccess(order);
      return NextResponse.redirect(returnUrl);
    }

    const amount = Number(order.total || 0);
    const linePayResponse = await callLinePay<{ info?: { transactionId?: string | number; orderId?: string; payInfo?: unknown[] } }>({
      method: 'POST',
      path: `/v4/payments/${encodeURIComponent(transactionId)}/confirm`,
      body: { amount, currency: 'TWD' },
      timeoutMs: 45000,
    });
    const confirmedTransactionId = String(linePayResponse.info?.transactionId || transactionId);
    const confirmedAt = new Date().toISOString();
    const orderRef = adminDatabaseRef(`orders/${order.key}`);
    const transition = await orderRef.transaction((current) => {
      if (!current) return;
      if (isOrderTerminal(current)) {
        const alreadyRefunded = isOrderRefunded(current);
        const hasOrderTerminalState = isOrderCancelled(current) || isOrderRejected(current) || alreadyRefunded;
        return {
          ...current,
          ...(!hasOrderTerminalState ? { status: 'cancelled', voided: true, cancelledBy: 'customer', cancelledAt: confirmedAt } : {}),
          linePayTransactionId: confirmedTransactionId,
          linePayConfirmedAt: confirmedAt,
          linePayResult: linePayResponse.info?.payInfo || null,
          ...(alreadyRefunded ? {} : { paymentStatus: 'refund_pending', refundStatus: 'pending' }),
        };
      }
      return {
        ...current,
        payment: '已付款',
        paymentStatus: 'paid',
        linePayTransactionId: confirmedTransactionId,
        linePayConfirmedAt: confirmedAt,
        linePayResult: linePayResponse.info?.payInfo || null,
      };
    });
    if (!transition.committed) throw new Error('訂單狀態更新失敗，請稍後確認付款狀態');

    const updatedOrder = { key: order.key, ...(transition.snapshot.val() || {}) } as NonNullable<typeof order>;
    if (isOrderTerminal(updatedOrder)) {
      try {
        await reverseOrderPoints(orderNo, updatedOrder.key);
      } catch (reverseError) {
        console.error('付款確認與取消競速後點數回收失敗:', reverseError);
      }
      if (isOrderRefunded(updatedOrder)) {
        returnUrl.searchParams.set('payment', 'refunded');
        returnUrl.searchParams.set('message', '訂單已取消，款項已退款');
        return NextResponse.redirect(returnUrl);
      }
      try {
        const refundResult = await completeLinePayRefund(updatedOrder, confirmedTransactionId);
        if (refundResult.pending) {
          returnUrl.searchParams.set('payment', 'cancelled');
          returnUrl.searchParams.set('message', 'LINE Pay 退款仍在處理中，請稍後確認');
          return NextResponse.redirect(returnUrl);
        }
        returnUrl.searchParams.set('payment', 'refunded');
        returnUrl.searchParams.set('message', '訂單已取消，LINE Pay 款項已自動退款');
      } catch (refundError) {
        const message = refundError instanceof Error ? refundError.message : 'LINE Pay 自動退款失敗';
        await updateOrder(updatedOrder, {
          linePayTransactionId: confirmedTransactionId,
          paymentStatus: 'refund_failed',
          refundStatus: 'failed',
          refundError: message,
          refundFailedAt: new Date().toISOString(),
        });
        returnUrl.searchParams.set('payment', 'cancelled');
        returnUrl.searchParams.set('message', `訂單已取消，但 LINE Pay 退款尚未完成：${message}`);
      }
      return NextResponse.redirect(returnUrl);
    }

    await notifyPaymentSuccess({ ...updatedOrder, payment: '已付款', paymentStatus: 'paid' });
    returnUrl.searchParams.set('payment', 'success');
    return NextResponse.redirect(returnUrl);
  } catch (error) {
    console.error('LINE Pay confirm failed:', error);
    if (orderNo) {
      try {
        const failedOrder = await findOrderByNo(orderNo);
        if (failedOrder && transactionId && !isOrderTerminal(failedOrder) && getPaymentDisplayStatus(failedOrder) !== '已付款') {
          try {
            const reconciled = await reconcileAfterConfirmError(failedOrder, String(transactionId));
            if (reconciled.state === 'paid') {
              await notifyPaymentSuccess(reconciled.order);
              returnUrl.searchParams.set('payment', 'success');
              returnUrl.searchParams.set('message', '付款已完成');
            } else if (reconciled.state === 'failed') {
              returnUrl.searchParams.set('payment', 'failed');
              returnUrl.searchParams.set('message', '付款未完成，請重新選擇付款方式');
            } else {
              await updateOrder(failedOrder, { payment: '付款處理中', paymentStatus: 'processing', linePayError: error instanceof Error ? error.message : '付款確認結果待查詢' });
              returnUrl.searchParams.set('payment', 'processing');
              returnUrl.searchParams.set('message', '付款結果確認中，請稍後重新整理訂單');
            }
            return NextResponse.redirect(returnUrl);
          } catch (reconcileError) {
            console.error('LINE Pay 付款結果查詢失敗，保留處理中狀態:', reconcileError);
            await updateOrder(failedOrder, { payment: '付款處理中', paymentStatus: 'processing', linePayError: error instanceof Error ? error.message : '付款確認結果待查詢' });
            returnUrl.searchParams.set('payment', 'processing');
            returnUrl.searchParams.set('message', '付款結果確認中，請稍後重新整理訂單');
            return NextResponse.redirect(returnUrl);
          }
        }
      } catch (updateError) {
        console.error('Failed to reconcile payment status:', updateError);
      }
    }
    returnUrl.searchParams.set('payment', 'failed');
    returnUrl.searchParams.set('message', error instanceof Error ? error.message : '付款確認失敗');
    return NextResponse.redirect(returnUrl);
  }
}
