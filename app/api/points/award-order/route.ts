import { NextResponse } from 'next/server';
import { earnOnlineOrderPoints, findOrderByNo, getLineMember, getMemberPoints, reverseOrderPoints } from '@/lib/member-points';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { isOrderTerminal } from '@/lib/order-status';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number' ? String(body.orderNo).trim() : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    if (!accessToken || accessToken.length > 8192 || !orderNo || (orderId && !/^[A-Za-z0-9_-]{1,128}$/.test(orderId))) {
      return NextResponse.json({ success: false, error: '缺少會員 Token、訂單編號或有效的雲端訂單 key' }, { status: 400 });
    }
    const member = await getLineMember(accessToken);
    const order = await findOrderByNo(orderNo, orderId || undefined);
    if (!order) return NextResponse.json({ success: false, error: '找不到相符的線上訂單' }, { status: 409 });
    if (order.userId !== member.userId) return NextResponse.json({ success: false, error: '訂單會員與登入會員不一致' }, { status: 403 });
    const resolvedOrderId = order.key;
    const result = await earnOnlineOrderPoints({ accessToken, orderNo, orderId: resolvedOrderId });
    if (order && !result.alreadyProcessed) {
      const orderRef = adminDatabaseRef(`orders/${resolvedOrderId}`);
      let cancelledBeforeStatusUpdate = false;
      await orderRef.transaction((current) => {
        cancelledBeforeStatusUpdate = false;
        if (!current) return;
        if (isOrderTerminal(current)) {
          cancelledBeforeStatusUpdate = true;
          return;
        }
        return { ...current, pointsAwardStatus: 'awarded', pointsAwardedAt: new Date().toISOString() };
      });
      if (cancelledBeforeStatusUpdate) {
        await reverseOrderPoints(orderNo, resolvedOrderId);
        await orderRef.update({ pointsAwardStatus: 'reversed' });
        const currentPoints = await getMemberPoints(result.member.userId);
        return NextResponse.json({
          success: true,
          ...result,
          points: 0,
          balance: Math.max(0, Number(currentPoints.balance || 0)),
          reversed: true,
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '線上訂單點數發送失敗';
    const status = /Token|會員|登入/.test(message) ? 401 : /找不到|取消|退款|線上|訂單編號/.test(message) ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
