import { NextResponse } from 'next/server';
import { earnPosPoints } from '@/lib/member-points';

export const runtime = 'nodejs';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://omg-pos-systems.pages.dev',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionToken = typeof body?.sessionToken === 'string' ? body.sessionToken.trim() : '';
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number' ? String(body.orderNo).trim() : '';
    if (!sessionToken || !orderNo) {
      return NextResponse.json({ success: false, error: '缺少會員工作階段或訂單編號' }, { status: 400, headers: corsHeaders });
    }
    const result = await earnPosPoints({ accessToken: sessionToken, orderNo });
    return NextResponse.json({ success: true, ...result }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '現場點數發送失敗';
    const status = /Token|會員/.test(message) ? 401 : /找不到|綁定|付款|一致/.test(message) ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers: corsHeaders });
  }
}
