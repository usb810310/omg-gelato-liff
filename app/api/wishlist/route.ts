import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { firebasePost } from '@/lib/firebase-server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    const wishText = typeof body?.wishText === 'string' ? body.wishText.trim().slice(0, 100) : '';
    if (!wishText || wishText.length < 2) return NextResponse.json({ success: false, error: '請輸入至少 2 個字' }, { status: 400 });
    if (!accessToken) return NextResponse.json({ success: false, error: '請從 LINE 登入後再許願' }, { status: 401 });
    const member = await getLineMember(accessToken);
    const wish = { userId: member.userId, displayName: member.displayName, wishText, flavor: wishText, timestamp: Date.now(), status: 'pending' };
    const result = await firebasePost<{ name?: string }>('wishlist', wish);
    return NextResponse.json({ success: true, id: result?.name || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : '許願失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|會員|登入/.test(message) ? 401 : 500 });
  }
}
