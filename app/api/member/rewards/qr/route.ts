import { NextResponse } from 'next/server';
import { createMemberRewardQrClaim, MemberRewardError } from '@/lib/member-points';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const voucherId = typeof body?.voucherId === 'string' ? body.voucherId.trim() : '';
    if (!accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: 'LINE 登入已失效，請重新開啟會員頁' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    const result = await createMemberRewardQrClaim(accessToken, voucherId);
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '兌換券條碼產生失敗，請稍後再試';
    const status = error instanceof MemberRewardError ? error.statusCode : /Token|登入|會員/.test(message) ? 401 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
