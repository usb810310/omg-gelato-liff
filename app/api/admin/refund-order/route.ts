import { NextResponse } from 'next/server';
import { callLinePay, findOrderByNo, updateOrder } from '@/lib/linepay';
import { getPaymentDisplayStatus, isOrderRefunded } from '@/lib/order-status';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const expected = process.env.MANUAL_REFUND_TOKEN || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: '未授權' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const orderNo = String(body.orderNo || '').trim();
    const expectedAmount = Number(body.amount || 0);
    if (orderNo !== 'WEB-W9Z08OR-T7F3G' || expectedAmount !== 100) {
      return NextResponse.json({ success: false, error: '補退款資料不符合指定訂單' }, { status: 400 });
    }

    const order = await findOrderByNo(orderNo);
    if (!order) return NextResponse.json({ success: false, error: '找不到訂單' }, { status: 404 });
    if (isOrderRefunded(order) || String(order.refundStatus || '').toLowerCase() === 'refunded') {
      return NextResponse.json({ success: true, alreadyRefunded: true, orderNo, amount: expectedAmount });
    }
    if (getPaymentDisplayStatus(order) !== '已付款' || String(order.paymentStatus || '').toLowerCase() !== 'paid') {
      return NextResponse.json({ success: false, error: '訂單不是可補退款的已付款狀態' }, { status: 409 });
    }
    if (String(order.status || '').toLowerCase() !== 'rejected') {
      return NextResponse.json({ success: false, error: '訂單不是店家拒單狀態' }, { status: 409 });
    }
    const transactionId = String(order.linePayTransactionId || '').trim();
    if (!transactionId) return NextResponse.json({ success: false, error: '缺少 LINE Pay 交易編號' }, { status: 409 });
    if (Number(order.total || 0) !== expectedAmount) {
      return NextResponse.json({ success: false, error: '退款金額與訂單金額不一致' }, { status: 409 });
    }

    await updateOrder(order, { refundStatus: 'pending', refundStartedAt: new Date().toISOString() });
    try {
      await callLinePay({ method: 'POST', path: `/v4/payments/${encodeURIComponent(transactionId)}/refund`, body: {}, timeoutMs: 45000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LINE Pay 退款失敗';
      await updateOrder(order, { refundStatus: 'failed', refundError: message, refundFailedAt: new Date().toISOString() });
      return NextResponse.json({ success: false, error: message, refundStatus: 'failed' }, { status: 502 });
    }

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
    return NextResponse.json({ success: true, refunded: true, orderNo, amount: expectedAmount, transactionId });
  } catch (error) {
    console.error('手動補退款失敗:', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '手動補退款失敗' }, { status: 500 });
  }
}
