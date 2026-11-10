import { NextResponse } from 'next/server';
import { MemberRewardError, redeemMemberRewardQrClaim } from '@/lib/member-points';
import { requirePosStaff } from '@/lib/pos-auth';

export const runtime = 'nodejs';

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowedOrigin = ['https://omg-pos-systems.pages.dev', 'https://main.omg-pos-systems.pages.dev'].includes(origin) ? origin : 'https://omg-pos-systems.pages.dev';
  return { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store' };
}

export function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: corsHeaders(request) }); }

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  try {
    const staff = await requirePosStaff(request);
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!token || token.length > 160) return NextResponse.json({ success: false, error: '請掃描有效的會員兌換券條碼' }, { status: 400, headers });
    const result = await redeemMemberRewardQrClaim(token, String(staff.uid || ''), idempotencyKey);
    return NextResponse.json({ success: true, ...result }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '兌換券核銷失敗';
    const status = error instanceof MemberRewardError ? error.statusCode : /Token|登入|權限/.test(message) ? 401 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers });
  }
}
