import { NextResponse } from 'next/server';
import { cancelWaitingOrder, OrderCancellationError } from '@/lib/linepay';

export const runtime = 'nodejs';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://omg-gelato79.pages.dev',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

type LineIdToken = {
  userId?: string;
};

async function verifyLineAccessToken(accessToken: string) {
  const response = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  return (await response.json()) as LineIdToken;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  try {
    const payload: unknown = await request.json().catch(() => null);
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const orderNo = typeof body?.orderNo === 'string' || typeof body?.orderNo === 'number'
      ? String(body.orderNo).trim()
      : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
    if (!orderNo || (orderId && !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) || !accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: '缺少有效的訂單或登入資訊' }, { status: 400, headers: corsHeaders });
    }

    const lineUser = await verifyLineAccessToken(accessToken);
    if (!lineUser?.userId) {
      return NextResponse.json({ success: false, error: '登入驗證已失效，請重新開啟 LINE 頁面' }, { status: 401, headers: corsHeaders });
    }

    const result = await cancelWaitingOrder(orderNo, orderId || undefined, lineUser.userId);
    return NextResponse.json({
      success: true,
      refunded: Boolean(result?.refunded),
      refundPending: Boolean(result?.refundPending),
      retried: Boolean(result?.retried),
      pointsReversalPending: Boolean(result?.pointsReversalPending),
    }, { headers: corsHeaders });
  } catch (error) {
    if (error instanceof OrderCancellationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode, headers: corsHeaders });
    }
    console.error('顧客取消訂單失敗:', error);
    const message = error instanceof Error ? error.message : '取消訂單失敗，請稍後再試';
    return NextResponse.json({ success: false, error: message }, { status: 500, headers: corsHeaders });
  }
}
