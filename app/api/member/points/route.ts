import { NextResponse } from 'next/server';
import { getLineMember, getMemberPoints } from '@/lib/member-points';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    if (!accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: '缺少有效的 LINE 登入資訊' }, { status: 401 });
    }
    const member = await getLineMember(accessToken);
    const points = await getMemberPoints(member.userId);
    return NextResponse.json({ success: true, points }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員點數查詢失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 500 });
  }
}
