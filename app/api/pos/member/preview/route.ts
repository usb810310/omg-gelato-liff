import { NextResponse } from 'next/server';
import { peekMemberQrClaim } from '@/lib/member-points';
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
    await requirePosStaff(request);
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 220) return NextResponse.json({ success: false, error: '請掃描有效的會員條碼' }, { status: 400, headers });
    const member = await peekMemberQrClaim(token);
    return NextResponse.json({ success: true, member }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員條碼查詢失敗';
    const status = /Token|登入|權限/.test(message) ? 401 : 400;
    return NextResponse.json({ success: false, error: message }, { status, headers });
  }
}
