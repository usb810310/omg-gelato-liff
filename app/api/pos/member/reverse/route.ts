import { NextResponse } from 'next/server';
import { reverseOrderPoints } from '@/lib/member-points';
import { requirePosStaff } from '@/lib/pos-auth';

export const runtime = 'nodejs';

function headers(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowed = ['https://omg-pos-systems.pages.dev', 'https://main.omg-pos-systems.pages.dev'].includes(origin)
    ? origin : 'https://omg-pos-systems.pages.dev';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  };
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: headers(request) });
}

export async function POST(request: Request) {
  try {
    await requirePosStaff(request);
    const body = await request.json().catch(() => ({}));
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number'
      ? String(body.orderNo).trim() : '';
    if (!orderNo) return NextResponse.json({ success: false, error: '缺少訂單編號' }, { status: 400, headers: headers(request) });
    const result = await reverseOrderPoints(orderNo);
    return NextResponse.json({ success: true, ...result }, { headers: headers(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '點數撤銷失敗';
    return NextResponse.json({ success: false, error: message }, { status: 409, headers: headers(request) });
  }
}
