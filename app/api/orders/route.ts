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
    const memberKey = `line_${member.userId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    const memberSnapshot = await adminDatabaseRef(`members/${memberKey}`).get();
    const memberProfile = memberSnapshot.val() as { memberNo?: unknown; memberKey?: unknown } | null;
    const memberNo = typeof memberProfile?.memberNo === 'string' ? memberProfile.memberNo.trim() : '';
    const storedMemberKey = typeof memberProfile?.memberKey === 'string' ? memberProfile.memberKey.trim() : memberKey;
    const snapshot = await adminDatabaseRef('orders').get();
    const orders: Array<Record<string, unknown>> = [];
    snapshot.forEach((child) => {
      const value = child.val();
      if (!value || typeof value !== 'object') return false;
      const order = value as Record<string, unknown>;
      const belongsToMember = order.userId === member.userId
        || (storedMemberKey && order.memberKey === storedMemberKey)
        || (memberNo && order.memberNo === memberNo);
      if (belongsToMember) orders.push({ ...order, id: child.key });
      return false;
    });
    orders.sort((a, b) => new Date(String(b.time || b.createdAt || b.date || 0)).getTime() - new Date(String(a.time || a.createdAt || a.date || 0)).getTime());
    return NextResponse.json({ success: true, orders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '訂單查詢失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 500 });
  }
}
