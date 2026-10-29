import { NextResponse } from 'next/server';
import { getLiffReturnUrl } from '@/lib/linepay';

const allowedOrigins = new Set([
  'https://my-liff-app-xi.vercel.app',
  'https://omg-gelato-omg-liff.vercel.app',
  'https://omg-gelato-git-main-omg-liff.vercel.app',
  'https://omg-gelato79.pages.dev',
]);

function getCorsHeaders(request: Request) {
  const origin = request.headers.get('origin');
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  });
  if (origin && allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

export function OPTIONS(request: Request) {
  const headers = getCorsHeaders(request);
  const origin = request.headers.get('origin');
  const status = origin && !allowedOrigins.has(origin) ? 403 : 204;
  return new NextResponse(null, { status, headers });
}

type IncomingItem = {
  name?: string;
  qty?: number;
  price?: number;
  flavorDisplay?: string;
};

function buildPickupLabel(pickupDay?: string, pickupTime?: string) {
  if (pickupDay && pickupTime) {
    return `${pickupDay === 'tomorrow' ? '明天' : '今天'} ${pickupTime}`;
  }
  return '';
}

export async function POST(request: Request) {
  const corsHeaders = getCorsHeaders(request);
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return NextResponse.json(
      { success: false, error: '不允許的網站來源' },
      { status: 403, headers: corsHeaders },
    );
  }
  try {
    const body = await request.json();
    const {
      orderText,
      orderNo,
      pickupNo,
      pickupNumber,
      userId,
      items = [],
      total,
      pickupDay,
      pickupTime,
      payMethod,
      customerNote,
    } = body;
    const recipientUserId = typeof userId === 'string' ? userId.trim() : '';
    const isLinePayPending = payMethod === 'onsite_linepay';

    const safeOrderText = orderText?.trim() || '';
    const customerPickupNumber = pickupNumber || pickupNo || '待分配';
    const pickupLabel = buildPickupLabel(pickupDay, pickupTime);

    const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const liveOrderUrl = new URL(getLiffReturnUrl());
    liveOrderUrl.searchParams.set('orderNo', String(orderNo || ''));

    if (!CHANNEL_ACCESS_TOKEN) {
      return NextResponse.json(
        { success: false, error: 'LINE 環境變數未設定' },
        { status: 500, headers: corsHeaders },
      );
    }

    const itemRows: Record<string, unknown>[] = [];
    let itemCount = 0;
    (Array.isArray(items) ? (items as IncomingItem[]) : []).forEach((item, index) => {
      if (index > 0) {
        itemRows.push({ type: 'separator', margin: 'md', color: '#E5E5E5' });
      }
      const qty = item.qty && item.qty > 1 ? ` × ${item.qty}` : '';
      itemCount += item.qty || 1;
      const lineTotal = item.price != null ? Number(item.price) * (item.qty || 1) : null;
      itemRows.push({
        type: 'box',
        layout: 'horizontal',
        margin: 'md',
        contents: [
          { type: 'text', text: `${item.name || '冰淇淋'}${qty}`, size: 'md', weight: 'bold', color: '#202938', wrap: false, flex: 5 },
          ...(lineTotal != null
            ? [{ type: 'text', text: `$${lineTotal.toFixed(0)}`, size: 'md', weight: 'bold', color: '#202938', align: 'end', gravity: 'center', flex: 2 }]
            : []),
        ],
      });
      if (item.flavorDisplay) {
        const flavorText = item.flavorDisplay.split(/\s*\+\s*/).join('＋');
        itemRows.push({ type: 'text', text: flavorText, size: 'sm', color: '#667085', wrap: false, margin: 'xs' });
      }
    });
    if (!itemRows.length && safeOrderText) {
      itemRows.push({ type: 'text', text: safeOrderText, size: 'sm', color: '#667085', wrap: false, margin: 'md' });
    }
    const totalValue = total != null ? Number(total) : 0;
    const pickupTimeText = pickupLabel ? `${pickupLabel} 取餐` : '取餐時間未提供';

    const customerCard = {
      type: 'flex',
      altText: `您已送出訂單${pickupLabel ? `，${pickupLabel}取餐` : ''}，取餐號碼 ${customerPickupNumber}`,
      contents: {
        type: 'bubble',
        size: 'mega',
        body: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '20px',
          spacing: 'none',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              paddingAll: '14px',
              backgroundColor: '#F2F6FC',
              cornerRadius: '12px',
              contents: [
                { type: 'text', text: isLinePayPending ? 'ORDER CREATED · PAYMENT PENDING' : 'ORDER RECEIVED', size: 'xs', weight: 'bold', color: '#66758A', wrap: false },
                { type: 'text', text: isLinePayPending ? '訂單已建立，請完成付款' : '您已送出訂單', size: 'lg', weight: 'bold', color: '#202938', wrap: false, margin: 'sm' },
                { type: 'text', text: isLinePayPending ? '請依照頁面完成 LINE Pay 付款' : pickupTimeText, size: 'md', weight: 'bold', color: '#2F5BEA', wrap: true, margin: 'sm' },
              ],
            },
            { type: 'text', text: `線上訂單編號：${orderNo || '—'}`, size: 'xs', color: '#667085', wrap: false, margin: 'lg' },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'lg',
              alignItems: 'center',
              contents: [
                { type: 'text', text: '取餐號碼', size: 'sm', weight: 'bold', color: '#667085', wrap: false, flex: 1 },
                { type: 'text', text: String(customerPickupNumber), size: 'xxl', weight: 'bold', color: '#2F5BEA', align: 'end', wrap: false, flex: 2 },
              ],
            },
            { type: 'separator', margin: 'lg', color: '#DCE3EC' },
            ...itemRows,
            { type: 'separator', margin: 'lg', color: '#DCE3EC' },
            ...(customerNote ? [{ type: 'text', text: `顧客備註：${String(customerNote).slice(0, 120)}`, size: 'sm', color: '#8B5E3C', wrap: true, margin: 'md' }] : []),
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'lg',
              alignItems: 'center',
              contents: [
                { type: 'text', text: `共 ${itemCount} 項`, size: 'sm', color: '#667085', wrap: false, flex: 1 },
                { type: 'text', text: `合計 $${totalValue.toFixed(0)}`, size: 'lg', weight: 'bold', color: '#202938', align: 'end', wrap: false, flex: 1 },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '12px',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'md',
              color: '#2F5BEA',
              action: { type: 'uri', label: '查看訂單', uri: liveOrderUrl.toString() },
            },
          ],
        },
      },
    };

    let customerError: string | null = null;

    if (!recipientUserId) {
      return NextResponse.json(
        { success: true, notified: false, warning: '找不到 LINE userId，無法傳送聊天室小卡；請從 LINE 重新開啟訂購頁。' },
        { headers: corsHeaders },
      );
    }

    if (recipientUserId) {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ to: recipientUserId, messages: [customerCard] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('❌ 通知客人失敗:', JSON.stringify(err));
        customerError = err.message || `通知客人失敗（HTTP ${res.status}）`;
      }
    }

    return NextResponse.json({ success: !customerError, notified: !customerError, warning: customerError }, { headers: corsHeaders, status: customerError ? 502 : 200 });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : '未知錯誤';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders },
    );
  }
}
