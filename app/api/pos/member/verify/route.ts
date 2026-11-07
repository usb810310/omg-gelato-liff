import { NextResponse } from 'next/server';
import { getLineMember, getMemberPoints } from '@/lib/member-points';

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
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return NextResponse.json({ success: false, error: '缺少會員 Token' }, { status: 400, headers: corsHeaders });
    const member = await getLineMember(token);
    const account = await getMemberPoints(member.userId);
    return NextResponse.json({
      success: true,
      member: { ...member, pointsBalance: Math.max(0, Number(account.balance || 0)) },
      sessionToken: token,
    }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '會員驗證失敗' }, { status: 401, headers: corsHeaders });
  }
}
