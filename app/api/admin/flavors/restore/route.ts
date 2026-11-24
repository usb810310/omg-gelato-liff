import { NextResponse } from 'next/server';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { LineAdminAuthError, requireLineAdmin } from '@/lib/line-admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIRMATION_PHRASE = 'RESTORE_ALL';
type FlavorRecord = Record<string, unknown>;

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function errorStatus(error: unknown) {
  return error instanceof LineAdminAuthError ? error.statusCode : 500;
}

export async function POST(request: Request) {
  try {
    const lineUserId = await requireLineAdmin(request);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 1024) return jsonError('請求內容過大。', 413);

    const payload: unknown = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonError('請求內容格式錯誤。', 400);
    }
    const confirmation = (payload as Record<string, unknown>).confirmation;
    if (confirmation !== CONFIRMATION_PHRASE) {
      return jsonError(`全部上架需明確確認，confirmation 必須是 ${CONFIRMATION_PHRASE}。`, 400);
    }

    const flavorsRef = adminDatabaseRef('todayFlavors');
    const result = await flavorsRef.transaction((current: unknown) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return;
      const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
      for (const [key, value] of Object.entries(next)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const flavor = value as FlavorRecord;
        next[key] = { ...flavor, soldOut: false };
      }
      return next;
    });

    if (!result.committed) return jsonError('沒有可更新的今日口味資料，或更新未完成。', 409);

    const flavors = result.snapshot.val();
    const updatedCount = flavors && typeof flavors === 'object' && !Array.isArray(flavors)
      ? Object.values(flavors as Record<string, unknown>).filter((value) => value && typeof value === 'object' && !Array.isArray(value)).length
      : 0;
    const changedAt = Date.now();

    try {
      const auditRef = adminDatabaseRef('contentEditorAudit').push();
      await auditRef.set({
        kind: 'batch-restore-all-flavors',
        changedAt,
        changedBy: { provider: 'line', userId: lineUserId },
        itemCount: updatedCount,
      });
    } catch (auditError) {
      console.error('[admin/flavors/restore] Audit log write failed after successful update', auditError);
    }

    return NextResponse.json({ success: true, action: 'restore-all', updatedCount, changedAt }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '全部上架失敗。';
    return jsonError(message, errorStatus(error));
  }
}
