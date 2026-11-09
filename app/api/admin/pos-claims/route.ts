import { NextResponse } from 'next/server';
import { getFirebaseAdminAuth } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

const ALLOWED_EMAILS = new Set(['usb810310@gmail.com', 'onmygelato@gmail.com']);

export async function POST(request: Request) {
  const setupToken = process.env.POS_CLAIMS_SETUP_TOKEN;
  if (!setupToken || request.headers.get('x-pos-claims-token') !== setupToken) {
    return NextResponse.json({ success: false, error: '未授權' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const emails = Array.isArray(body?.emails) ? body.emails.map((value: unknown) => String(value).trim().toLowerCase()) : [];
  const requested: string[] = emails.length ? emails : [...ALLOWED_EMAILS];
  if (requested.some((email: string) => !ALLOWED_EMAILS.has(email))) {
    return NextResponse.json({ success: false, error: '帳號不在 POS 允許清單' }, { status: 400 });
  }
  const auth = getFirebaseAdminAuth();
  const updated: string[] = [];
  for (const email of requested) {
    const user = await auth.getUserByEmail(email);
    const existing = user.customClaims || {};
    await auth.setCustomUserClaims(user.uid, { ...existing, posStaff: true, posAdmin: true });
    updated.push(email);
  }
  return NextResponse.json({ success: true, updated, claims: { posStaff: true, posAdmin: true } }, { headers: { 'Cache-Control': 'no-store' } });
}
