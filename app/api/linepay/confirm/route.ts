import { NextResponse } from 'next/server';
import { callLinePay, findOrderByNo, getLiffReturnUrl, updateOrder } from '@/lib/linepay';
import { getPaymentDisplayStatus, isOrderRefunded, isOrderTerminal } from '@/lib/order-status';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const incomingUrl = new URL(request.url);
  const orderNo = incomingUrl.searchParams.get('orderId');
  const transactionId = incomingUrl.searchParams.get('transactionId');
  const returnUrl = new URL(getLiffReturnUrl());
  returnUrl.searchParams.set('orderId', orderNo || '');

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
      return NextResponse.redirect(returnUrl);
    }

    const amount = Number(order.total || 0);
    const linePayResponse = await callLinePay<{ info?: { transactionId?: string | number; orderId?: string; payInfo?: unknown[] } }>({
      method: 'POST',
      path: `/v4/payments/${encodeURIComponent(transactionId)}/confirm`,
      body: { amount, currency: 'TWD' },
      timeoutMs: 45000,
    });

    await updateOrder(order, {
      payment: '已付款',
      paymentStatus: 'paid',
      linePayTransactionId: String(linePayResponse.info?.transactionId || transactionId),
      linePayConfirmedAt: new Date().toISOString(),
      linePayResult: linePayResponse.info?.payInfo || null,
    });
    returnUrl.searchParams.set('payment', 'success');
    return NextResponse.redirect(returnUrl);
  } catch (error) {
    console.error('LINE Pay confirm failed:', error);
    if (orderNo) {
      try {
        const failedOrder = await findOrderByNo(orderNo);
        if (failedOrder && !isOrderTerminal(failedOrder) && getPaymentDisplayStatus(failedOrder) !== '已付款') {
          await updateOrder(failedOrder, {
            payment: '付款失敗',
            paymentStatus: 'failed',
            linePayError: error instanceof Error ? error.message : '付款確認失敗',
            paymentFailedAt: new Date().toISOString(),
          });
        }
      } catch (updateError) {
        console.error('Failed to update failed payment status:', updateError);
      }
    }
    returnUrl.searchParams.set('payment', 'failed');
    returnUrl.searchParams.set('message', error instanceof Error ? error.message : '付款確認失敗');
    return NextResponse.redirect(returnUrl);
  }
}
