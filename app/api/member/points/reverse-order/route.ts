import { NextResponse } from 'next/server';
import { findOrderByNo, getLineMember, reverseOrderPoints } from '@/lib/member-points';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { isOrderTerminal } from '@/lib/order-status';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const payload: unknown = await request.json().catch(() => null);
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
    const orderNo = typeof body.orderNo === 'string' || typeof body.orderNo === 'number'
      ? String(body.orderNo).trim()
      : '';
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
    if (!accessToken || accessToken.length > 8192 || !orderNo || (orderId && !/^[A-Za-z0-9_-]{1,128}$/.test(orderId))) {
      return NextResponse.json({ success: false, error: '缺少有效的會員登入或訂單資訊' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const member = await getLineMember(accessToken);
    let resolvedOrderId = orderId;
    if (!resolvedOrderId) {
      const snapshot = await adminDatabaseRef('orders').orderByChild('userId').equalTo(member.userId).get();
      const matches: string[] = [];
      snapshot.forEach((child) => {
        const candidate = child.val() as { orderNo?: string | number } | null;
        if (candidate && String(candidate.orderNo) === orderNo && child.key) matches.push(child.key);
        return false;
      });
      if (matches.length > 1) {
        return NextResponse.json({ success: false, error: '此訂單編號對應多筆會員訂單，請重新整理後重試' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      resolvedOrderId = matches[0] || '';
    }
    if (!resolvedOrderId) return NextResponse.json({ success: false, error: '找不到屬於此會員的訂單' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const order = await findOrderByNo(orderNo, resolvedOrderId);
    if (!order || order.userId !== member.userId) {
      return NextResponse.json({ success: false, error: '找不到屬於此會員的訂單' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!isOrderTerminal(order)) {
      return NextResponse.json({ success: false, error: '訂單尚未取消、拒單或退款，不能回收點數' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }

    const result = await reverseOrderPoints(orderNo, resolvedOrderId);
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員點數回收失敗';
    const status = /Token|登入|會員/.test(message) ? 401 : 409;
    return NextResponse.json({ success: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
