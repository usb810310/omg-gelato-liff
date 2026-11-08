import { NextResponse } from 'next/server';
import { getLineMember } from '@/lib/member-points';
import { firebaseGet, firebasePut } from '@/lib/firebase-server';

export const runtime = 'nodejs';

function clean(value: unknown, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = clean(body?.accessToken, 8192);
    const existingKey = clean(body?.memberKey, 120);
    const guest = !accessToken;
    let userId = '';
    let memberKey = existingKey;
    let memberType: 'line' | 'guest' = 'guest';
    let lineMember: { userId: string; displayName?: string; pictureUrl?: string } | null = null;
    if (accessToken) {
      lineMember = await getLineMember(accessToken);
      userId = lineMember.userId;
      memberKey = `line_${userId.replace(/[^A-Za-z0-9_-]/g, '')}`;
      memberType = 'line';
    }
    if (!memberKey || !/^(line|guest)_[A-Za-z0-9_-]+$/.test(memberKey)) return NextResponse.json({ success: false, error: '會員識別資料無效' }, { status: 400 });
    const existing = await firebaseGet<Record<string, unknown> | null>(`members/${encodeURIComponent(memberKey)}`) || {};
    if (memberType === 'guest' && existing.lineUserId) return NextResponse.json({ success: false, error: '會員識別資料不一致' }, { status: 403 });
    const profile = {
      ...existing,
      memberNo: clean(existing.memberNo) || `M${Date.now().toString(36).slice(-6).toUpperCase()}`,
      memberKey,
      memberType,
      lineUserId: userId || existing.lineUserId || null,
      displayName: lineMember?.displayName || clean(body?.displayName) || existing.displayName || null,
      pictureUrl: lineMember?.pictureUrl || clean(body?.pictureUrl, 1000) || existing.pictureUrl || null,
      phone: clean(body?.phone) || existing.phone || null,
      pointsBalance: Number(existing.pointsBalance || 0),
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await firebasePut(`members/${encodeURIComponent(memberKey)}`, profile);
    return NextResponse.json({ success: true, profile }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員資料更新失敗';
    return NextResponse.json({ success: false, error: message }, { status: /Token|會員/.test(message) ? 401 : 500 });
  }
}
