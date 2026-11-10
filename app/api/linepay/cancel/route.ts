import { NextResponse } from 'next/server';
import { getLiffReturnUrl } from '@/lib/linepay';

export const runtime = 'nodejs';

/**
 * LINE Pay cancelUrl is a browser redirect, not an authenticated server callback.
 * Never change order/payment/points state from query parameters on this route.
 * A member-initiated cancellation must use the LINE-token-verified /api/cancel-order endpoint.
 */
export async function GET(request: Request) {
  const incomingUrl = new URL(request.url);
  const orderNo = incomingUrl.searchParams.get('orderId');
  const returnUrl = new URL(getLiffReturnUrl());
  returnUrl.searchParams.set('payment', 'cancelled');
  if (orderNo) returnUrl.searchParams.set('orderId', orderNo.slice(0, 160));
  return NextResponse.redirect(returnUrl);
}
