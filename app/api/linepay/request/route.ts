import { NextResponse } from 'next/server';
import { callLinePay, findOrderByNo, getLiffReturnUrl, getPublicSiteUrl, updateOrder } from '@/lib/linepay';
import { getPaymentDisplayStatus, isOrderTerminal } from '@/lib/order-status';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (process.env.LINEPAY_ONLINE_ENABLED !== 'true') {
    return NextResponse.json({ success: false, error: '線上 LINE Pay 暫停使用，請現場付款' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const { orderNo, userId } = body as { orderNo?: string | number; userId?: string };
    if (!orderNo || !userId) {
      return NextResponse.json({ success: false, error: '缺少 orderNo 或 userId' }, { status: 400 });
    }

    const order = await findOrderByNo(orderNo);
    if (!order) return NextResponse.json({ success: false, error: '找不到這筆訂單' }, { status: 404 });
    if (order.userId && order.userId !== userId) {
      return NextResponse.json({ success: false, error: '無權限操作這筆訂單' }, { status: 403 });
    }
    if (isOrderTerminal(order) || getPaymentDisplayStatus(order) === '已付款') {
      return NextResponse.json({ success: false, error: '這筆訂單目前無法付款' }, { status: 409 });
    }

    // 同一筆訂單只允許一個 LINE Pay 交易。若第一次付款已建立交易，
    // 重新點擊付款時先查詢原交易，避免再次 request 觸發 LINE Pay 1172。
    const existingTransactionId = String(order.linePayTransactionId || '').trim();
    if (existingTransactionId && ['付款處理中', '付款失敗'].includes(getPaymentDisplayStatus(order))) {
      try {
        const statusResponse = await callLinePay<{ returnCode?: string | number; info?: { payInfo?: unknown[] } }>({
          method: 'GET',
          path: `/v4/payments/requests/${encodeURIComponent(existingTransactionId)}/check`,
          timeoutMs: 20000,
          acceptReturnCodes: ['0110', '0121', '0123'],
        });
        const statusCode = String(statusResponse.returnCode || '');
        if (statusCode === '0110') {
          const confirmed = await callLinePay<{ info?: { transactionId?: string | number; payInfo?: unknown[] } }>({
            method: 'POST',
            path: `/v4/payments/${encodeURIComponent(existingTransactionId)}/confirm`,
            body: { amount: Number(order.total || 0), currency: 'TWD' },
            timeoutMs: 45000,
          });
          await updateOrder(order, {
            payment: '已付款',
            paymentStatus: 'paid',
            linePayTransactionId: String(confirmed.info?.transactionId || existingTransactionId),
            linePayConfirmedAt: new Date().toISOString(),
            linePayResult: confirmed.info?.payInfo || null,
          });
          return NextResponse.json({ success: true, alreadyConfirmed: true, orderNo: String(orderNo) });
        }
        if (statusCode === '0123') {
          await updateOrder(order, {
            payment: '已付款',
            paymentStatus: 'paid',
            linePayConfirmedAt: new Date().toISOString(),
            linePayResult: statusResponse.info?.payInfo || null,
          });
          return NextResponse.json({ success: true, alreadyConfirmed: true, orderNo: String(orderNo) });
        }
      } catch (statusError) {
        console.error('LINE Pay 既有交易狀態查詢失敗，保留付款處理中:', statusError);
      }
      return NextResponse.json({
        success: false,
        paymentPending: true,
        error: '這筆訂單已有付款流程，請稍候重新整理訂單狀態，不要重複付款。',
      }, { status: 409 });
    }

    const amount = Number(order.total || 0);
    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: '訂單金額不正確' }, { status: 400 });
    }

    const products = (order.items || []).map((item, index) => ({
      id: `item-${index + 1}`,
      name: item.name || 'Gelato',
      quantity: Number(item.qty || 1),
      price: Number(item.price || 0),
      ...(item.flavorDisplay ? { options: item.flavorDisplay } : {}),
    }));
    const packages = [{
      id: 'gelato-store',
      amount,
      products: products.length ? products : [{ id: 'gelato-order', name: `On My Gelato 訂單 ${orderNo}`, quantity: 1, price: amount }],
    }];
    const siteUrl = getPublicSiteUrl();
    const requestBody = {
      amount,
      currency: 'TWD',
      orderId: String(orderNo),
      packages,
      redirectUrls: {
        confirmUrl: `${siteUrl}/api/linepay/confirm`,
        cancelUrl: `${siteUrl}/api/linepay/cancel`,
      },
    };

    // Verify Firebase can record the in-flight state before creating a LINE Pay transaction.
    await updateOrder(order, {
      payment: '付款處理中',
      paymentStatus: 'processing',
      paymentProvider: 'LINE_PAY',
    });

    const linePayResponse = await callLinePay<{ info?: { paymentUrl?: { web?: string; app?: string }; transactionId?: string | number } }>({
      method: 'POST',
      path: '/v4/payments/request',
      body: requestBody,
      timeoutMs: 15000,
    });
    const info = linePayResponse.info;
    const paymentUrl = info?.paymentUrl?.app || info?.paymentUrl?.web;
    if (!paymentUrl || !info?.transactionId) throw new Error('LINE Pay 未回傳付款網址或交易編號');

    try {
      await updateOrder(order, {
        linePayTransactionId: String(info.transactionId),
        paymentRequestedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Keep the payment URL usable; the confirm callback can reconcile by order number.
      console.error('LINE Pay request created but transaction details were not persisted:', {
        orderNo: String(orderNo),
        transactionId: String(info.transactionId),
        error,
      });
    }

    return NextResponse.json({
      success: true,
      paymentUrl,
      webPaymentUrl: info.paymentUrl?.web || paymentUrl,
      appPaymentUrl: info.paymentUrl?.app || paymentUrl,
      transactionId: String(info.transactionId),
      orderNo: String(orderNo),
      returnUrl: getLiffReturnUrl(),
    });
  } catch (error) {
    console.error('LINE Pay request failed:', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'LINE Pay 付款請求失敗' }, { status: 500 });
  }
}
