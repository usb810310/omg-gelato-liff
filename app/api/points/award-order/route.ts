import { NextResponse } from 'next/server';
import { earnOnlineOrderPoints } from '@/lib/member-points';
import { findOrderByNo, updateOrder } from '@/lib/linepay';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number' ? String(body.orderNo).trim() : '';
    if (!accessToken || !orderNo) return NextResponse.json({ success: false, error: '缺少會員 Token 或訂單編號' }, { status: 400 });
    const result = await earnOnlineOrderPoints({ accessToken, orderNo });
    const order = await findOrderByNo(orderNo);
    if (order && !result.alreadyProcessed) await updateOrder(order, { pointsAwardStatus: 'awarded', pointsAwardedAt: new Date().toISOString() });
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '線上訂單點數發送失敗';
    const status = /Token|會員|登入/.test(message) ? 401 : /找不到|取消|退款|線上/.test(message) ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
