import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { adminDatabaseRef } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    if (!accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: '缺少有效的 LINE 登入資訊' }, { status: 401 });
    }
    const member = await getLineMember(accessToken);
    const snapshot = await adminDatabaseRef('orders')
      .orderByChild('userId')
      .equalTo(member.userId)
      .limitToLast(50)
      .get();
    const orders: Array<Record<string, unknown>> = [];
    snapshot.forEach((child) => {
      const value = child.val();
      if (value && typeof value === 'object' && value.userId === member.userId) {
        orders.push({ ...value, id: child.key });
      }
      return false;
    });
    orders.sort((a, b) => new Date(String(b.time || b.createdAt || b.date || 0)).getTime() - new Date(String(a.time || a.createdAt || a.date || 0)).getTime());
    return NextResponse.json({ success: true, orders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '訂單查詢失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 500 });
  }
}
