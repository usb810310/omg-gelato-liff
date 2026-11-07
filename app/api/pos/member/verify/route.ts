import { NextResponse } from 'next/server';
import { getLineMember, getMemberPoints } from '@/lib/member-points';

export const runtime = 'nodejs';

function corsHeaders(request?: Request) {
  const origin = request?.headers.get('origin') || '';
  const allowedOrigin = ['https://omg-pos-systems.pages.dev', 'https://main.omg-pos-systems.pages.dev'].includes(origin) ? origin : 'https://omg-pos-systems.pages.dev';
  return {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  };
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return NextResponse.json({ success: false, error: '缺少會員 Token' }, { status: 400, headers: corsHeaders(request) });
    const member = await getLineMember(token);
    const account = await getMemberPoints(member.userId);
    return NextResponse.json({
      success: true,
      member: { ...member, pointsBalance: Math.max(0, Number(account.balance || 0)) },
      sessionToken: token,
    }, { headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '會員驗證失敗' }, { status: 401, headers: corsHeaders(request) });
  }
}
