import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { firebasePost, reservePickupCode } from '@/lib/firebase-server';

export const runtime = 'nodejs';

function text(value: unknown, max = 500) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function dateKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()).replaceAll('-', ''); }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = text(body?.accessToken, 8192).trim();
    const order = body?.order && typeof body.order === 'object' ? body.order as Record<string, unknown> : {};
    const source = text(order.source, 30);
    const userId = text(order.userId, 200) || null;
    let member: { userId: string; displayName?: string; pictureUrl?: string } | null = null;
    if (accessToken) {
      member = await getLineMember(accessToken);
      if (userId && userId !== member.userId) return NextResponse.json({ success: false, error: '訂單會員與登入會員不一致' }, { status: 403 });
    } else if (source === 'LIFF') {
      return NextResponse.json({ success: false, error: 'LINE 登入已失效，請重新開啟點餐頁' }, { status: 401 });
    }
    const items = Array.isArray(order.items) ? order.items.slice(0, 30) : [];
    if (!items.length) return NextResponse.json({ success: false, error: '訂單沒有品項' }, { status: 400 });
    const orderNo = text(order.orderNo, 40) || `WEB-${Date.now().toString(36).slice(-7).toUpperCase()}`;
    const pickupNo = await reservePickupCode(dateKey());
    const orderData = {
      ...order,
      orderNo,
      pickupNo,
      pickupNumber: pickupNo,
      pickupCode: pickupNo,
      userId: member?.userId || userId,
      displayName: member?.displayName || order.displayName || null,
      pictureUrl: member?.pictureUrl || order.pictureUrl || null,
      createdAt: new Date().toISOString(),
    };
    const result = await firebasePost<{ name?: string }>('orders', orderData);
    return NextResponse.json({ success: true, orderNo, pickupNo, orderId: result?.name || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : '建立訂單失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 500 });
  }
}
