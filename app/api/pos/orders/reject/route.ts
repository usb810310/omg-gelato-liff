import { NextResponse } from 'next/server';
import { rejectOrderByStaff } from '@/lib/linepay';
import { requirePosStaff } from '@/lib/pos-auth';

export const runtime = 'nodejs';
function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowed = ['https://omg-pos-systems.pages.dev', 'https://main.omg-pos-systems.pages.dev'].includes(origin) ? origin : 'https://omg-pos-systems.pages.dev';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  };
}
export function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
export async function POST(request: Request) {
  const headers = corsHeaders(request);
  try {
    const staff = await requirePosStaff(request);
    const body = await request.json().catch(() => ({}));
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number' ? String(body.orderNo).trim() : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    if (!orderNo || (orderId && !/^[A-Za-z0-9_-]{1,128}$/.test(orderId))) return NextResponse.json({ success: false, error: '缺少有效的訂單編號' }, { status: 400, headers });
    const result = await rejectOrderByStaff(orderNo, orderId || undefined, staff.email || staff.uid);
    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : '拒單處理失敗';
    const status = /登入|權限|Token/.test(message) ? 401 : /找不到|已處理|已接單|付款處理/.test(message) ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status, headers });
  }
}
