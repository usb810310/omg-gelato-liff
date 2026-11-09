import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { firebasePost, reservePickupCode } from '@/lib/firebase-server';

export const runtime = 'nodejs';
const PRICE_TABLE: Record<string, number> = { 'OMG獨享杯': 100, 'OMG雙重奏': 120, 'OMG分享盒': 420 };
function text(value: unknown, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function dateKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()).replaceAll('-', ''); }
function safeItems(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error('訂單品項無效');
  return value.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const name = text(item.name, 40);
    const price = PRICE_TABLE[name];
    const qty = Number(item.qty ?? item.quantity ?? 0);
    if (!price || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('訂單品項或數量無效');
    return { name, price, qty, flavorDisplay: text(item.flavorDisplay, 240) };
  });
}
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = text(body?.accessToken, 8192);
    const order = body?.order && typeof body.order === 'object' ? body.order as Record<string, unknown> : {};
    const requestedSource = text(order.source, 30);
    const userId = text(order.userId, 200) || null;
    let member: { userId: string; displayName?: string; pictureUrl?: string } | null = null;
    if (accessToken) {
      member = await getLineMember(accessToken);
      if (userId && userId !== member.userId) return NextResponse.json({ success: false, error: '訂單會員與登入會員不一致' }, { status: 403 });
    } else if (requestedSource === 'LIFF') {
      return NextResponse.json({ success: false, error: 'LINE 登入已失效，請重新開啟點餐頁' }, { status: 401 });
    }
    const items = safeItems(order.items);
    const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const orderNo = `WEB-${Date.now().toString(36).slice(-7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const pickupNo = await reservePickupCode(dateKey());
    const orderData = {
      orderNo, channel: 'online', pickupNo, pickupNumber: pickupNo, pickupCode: pickupNo,
      userId: member?.userId || null, displayName: member?.displayName || null, pictureUrl: member?.pictureUrl || null,
      time: new Date().toISOString(), date: new Date().toISOString().slice(0, 10), items, subtotal: total, total,
      payment: text(order.payment, 30) === 'LINE Pay' ? 'LINE Pay' : '現場付款', paymentStatus: 'unpaid',
      paymentMethod: text(order.paymentMethod, 40) === 'ONSITE_LINEPAY' ? 'ONSITE_LINEPAY' : 'ONSITE_CASH',
      paymentNote: text(order.paymentNote, 80), remark: text(order.remark, 240), pickupRemark: text(order.pickupRemark, 240),
      customerNote: text(order.customerNote, 120), source: member ? 'LIFF' : 'WEB_GUEST', status: 'waiting_accept', voided: false,
      memberNo: text(order.memberNo, 40) || null, memberKey: text(order.memberKey, 120) || null, phone: text(order.phone, 30) || null,
      memberType: member ? 'line' : 'guest', pointsAwardStatus: member ? 'pending' : 'disabled', createdAt: new Date().toISOString(),
    };
    const result = await firebasePost<{ name?: string }>('orders', orderData);
    return NextResponse.json({ success: true, orderNo, pickupNo, orderId: result?.name || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : '建立訂單失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 400 });
  }
}
