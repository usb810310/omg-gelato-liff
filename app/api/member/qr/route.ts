import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { adminDatabaseRef } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
const IN_STORE_MEMBER_QR_ENABLED = false;

export async function POST(request: Request) {
  try {
    if (!IN_STORE_MEMBER_QR_ENABLED) {
      return NextResponse.json({ success: false, error: '門市會員 QR 尚未開放' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const mode = body?.mode === 'legacy' ? 'legacy' : 'member';
    if (!accessToken || accessToken.length > 8192) {
      return NextResponse.json({ success: false, error: '缺少有效的 LINE 登入資訊' }, { status: 401 });
    }
    const member = await getLineMember(accessToken);
    const claim = randomBytes(32).toString('base64url');
    const claimHash = createHash('sha256').update(claim).digest('hex');
    await adminDatabaseRef(`memberQrClaims/${claimHash}`).set({
      userId: member.userId,
      mode,
      createdAt: Date.now(),
      expiresAt: Date.now() + 90_000,
      usedAt: null,
    });
    return NextResponse.json({ success: true, token: `gelato-member-claim:${mode}:${claim}` }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員條碼產生失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|登入|會員/.test(message) ? 401 : 500 });
  }
}
