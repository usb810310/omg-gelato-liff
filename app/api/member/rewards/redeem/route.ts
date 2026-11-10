import { NextResponse } from 'next/server';
import { issueMemberRewardVoucher, MemberRewardError } from '@/lib/member-points';
import { isMemberRewardType } from '@/lib/member-rewards';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const rewardType = body?.rewardType;
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: 'LINE 登入已失效，請重新開啟會員頁' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!isMemberRewardType(rewardType)) {
      return NextResponse.json({ success: false, error: '兌換獎項無效' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const result = await issueMemberRewardVoucher(accessToken, rewardType, idempotencyKey);
    return NextResponse.json({ success: true, voucher: result.voucher, points: result.points, alreadyProcessed: result.alreadyProcessed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '兌換券建立失敗，請稍後再試';
    const status = error instanceof MemberRewardError ? error.statusCode : /Token|登入|會員/.test(message) ? 401 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
