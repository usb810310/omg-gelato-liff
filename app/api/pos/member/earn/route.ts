import { NextResponse } from 'next/server';
import { earnPosPoints } from '@/lib/member-points';
import { requirePosStaff } from '@/lib/pos-auth';

export const runtime = 'nodejs';

function corsHeaders(request?: Request) {
  const origin = request?.headers.get('origin') || '';
  const allowedOrigin = ['https://omg-pos-systems.pages.dev', 'https://main.omg-pos-systems.pages.dev'].includes(origin) ? origin : 'https://omg-pos-systems.pages.dev';
  return {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  };
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  try {
    await requirePosStaff(request);
    const body = await request.json().catch(() => ({}));
    const sessionToken = typeof body?.sessionToken === 'string' ? body.sessionToken.trim() : '';
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number' ? String(body.orderNo).trim() : '';
    if (!sessionToken || !orderNo) {
      return NextResponse.json({ success: false, error: '缺少會員工作階段或訂單編號' }, { status: 400, headers: corsHeaders(request) });
    }
    const result = await earnPosPoints({ accessToken: sessionToken, orderNo });
    return NextResponse.json({ success: true, ...result }, { headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '現場點數發送失敗';
    const status = /Token|會員|登入|權限/.test(message) ? 401 : /找不到|綁定|付款|一致/.test(message) ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: corsHeaders(request) });
  }
}
