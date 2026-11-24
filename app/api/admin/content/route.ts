import { NextResponse } from 'next/server';
import { getFirebaseAdminAuth, adminDatabaseRef } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DataRecord = Record<string, unknown>;
type FlavorInput = { id?: unknown; name?: unknown; desc?: unknown; soldOut?: unknown };
type AnnouncementInput = { id?: unknown; title?: unknown; content?: unknown; active?: unknown };

function isRecord(value: unknown): value is DataRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function apiError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function apiSuccess(data: DataRecord) {
  return NextResponse.json({ success: true, ...data }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function requirePosAdmin(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length > 8192) {
    const error = new Error('請先使用 POS 管理員 Google 帳號登入。');
    Object.assign(error, { statusCode: 401 });
    throw error;
  }

  let decoded;
  try {
    decoded = await getFirebaseAdminAuth().verifyIdToken(token, true);
  } catch {
    const error = new Error('登入憑證已失效，請重新登入。');
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  if (decoded.posAdmin !== true) {
    const error = new Error('此 Google 帳號沒有 posAdmin 管理權限。');
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
  return decoded;
}

function statusForError(error: unknown) {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = Number((error as { statusCode?: unknown }).statusCode);
    if ([400, 401, 403, 413].includes(status)) return status;
  }
  return 500;
}

function plainRecord(value: unknown): DataRecord {
  return isRecord(value) ? value : {};
}

function validateItems<T>(value: unknown, maxCount: number, label: string): T[] {
  if (!Array.isArray(value) || value.length > maxCount) {
    throw Object.assign(new Error(`${label}資料格式錯誤或超過數量上限。`), { statusCode: 400 });
  }
  return value as T[];
}

function validateId(id: unknown) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (value && !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw Object.assign(new Error('資料識別碼格式錯誤。'), { statusCode: 400 });
  }
  return value;
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) {
    throw Object.assign(new Error(`${label}必須為 1 至 ${maxLength} 個字元。`), { statusCode: 400 });
  }
  return text;
}

async function appendAudit(entry: DataRecord) {
  const auditRef = adminDatabaseRef('contentEditorAudit');
  const key = auditRef.push().key;
  if (!key) throw new Error('無法建立內容變更紀錄。');
  await auditRef.transaction((current) => {
    const audit = plainRecord(current);
    const next: DataRecord = { ...audit, [key]: entry };
    const ordered = Object.entries(next).sort((a, b) => Number(plainRecord(a[1]).changedAt || 0) - Number(plainRecord(b[1]).changedAt || 0));
    while (ordered.length > 100) {
      const [oldestKey] = ordered.shift() || [];
      if (oldestKey) delete next[oldestKey];
    }
    return next;
  });
}

export async function GET(request: Request) {
  try {
    const operator = await requirePosAdmin(request);
    const [flavorsSnapshot, announcementsSnapshot] = await Promise.all([
      adminDatabaseRef('todayFlavors').get(),
      adminDatabaseRef('announcements').get(),
    ]);
    return apiSuccess({
      todayFlavors: plainRecord(flavorsSnapshot.val()),
      announcements: plainRecord(announcementsSnapshot.val()),
      operator: { uid: String(operator.uid || ''), email: String(operator.email || '') },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '讀取公告與今日口味失敗。';
    return apiError(message, statusForError(error));
  }
}

export async function PUT(request: Request) {
  try {
    const operator = await requirePosAdmin(request);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 100_000) return apiError('送出的內容過大。', 413);

    const payload: unknown = await request.json().catch(() => null);
    if (!isRecord(payload)) return apiError('請求內容格式錯誤。', 400);
    const kind = payload.kind;
    const changedAt = Date.now();
    const updatedBy = { uid: String(operator.uid || ''), email: String(operator.email || '') };

    if (kind === 'flavors') {
      const items = validateItems<FlavorInput>(payload.items, 100, '今日口味');
      const prepared = items.map((item) => {
        const id = validateId(item?.id);
        const name = requiredText(item?.name, '口味名稱', 80);
        const desc = typeof item?.desc === 'string' ? item.desc.trim() : '';
        if (desc.length > 240) throw Object.assign(new Error('口味說明不可超過 240 個字元。'), { statusCode: 400 });
        if (item?.soldOut !== undefined && typeof item.soldOut !== 'boolean') {
          throw Object.assign(new Error('售完狀態格式錯誤。'), { statusCode: 400 });
        }
        return { id, name, desc, soldOut: item?.soldOut === true };
      });
      const flavorsRef = adminDatabaseRef('todayFlavors');
      const assigned = prepared.map((item) => ({
        ...item,
        id: item.id || flavorsRef.push().key || '',
      }));
      if (assigned.some((item) => !item.id)) throw new Error('無法建立口味識別碼。');
      if (new Set(assigned.map((item) => item.id)).size !== assigned.length) {
        return apiError('今日口味中有重複的資料識別碼，請重新整理後再試。', 400);
      }
      const result = await flavorsRef.transaction((current) => {
        const next: DataRecord = { ...plainRecord(current) };
        assigned.forEach((item, index) => {
          const old = plainRecord(next[item.id]);
          next[item.id] = {
            ...old,
            name: item.name,
            desc: item.desc,
            soldOut: item.soldOut,
            sortOrder: index,
          };
        });
        return next;
      });
      if (!result.committed) throw new Error('今日口味更新未完成，請重新整理後再試。');
      await appendAudit({ kind, changedAt, changedBy: updatedBy, itemCount: assigned.length, itemIds: assigned.map((item) => item.id) });
      return apiSuccess({ kind, updatedAt: changedAt, itemCount: assigned.length });
    }

    if (kind === 'announcements') {
      const items = validateItems<AnnouncementInput>(payload.items, 100, '營業公告');
      const prepared = items.map((item) => {
        const id = validateId(item?.id);
        const title = requiredText(item?.title, '公告標題', 120);
        const content = requiredText(item?.content, '公告內容', 2000);
        if (item?.active !== undefined && typeof item.active !== 'boolean') {
          throw Object.assign(new Error('公告啟用狀態格式錯誤。'), { statusCode: 400 });
        }
        return { id, title, content, active: item?.active !== false };
      });
      const announcementsRef = adminDatabaseRef('announcements');
      const assigned = prepared.map((item) => ({
        ...item,
        id: item.id || announcementsRef.push().key || '',
      }));
      if (assigned.some((item) => !item.id)) throw new Error('無法建立公告識別碼。');
      if (new Set(assigned.map((item) => item.id)).size !== assigned.length) {
        return apiError('公告中有重複的資料識別碼，請重新整理後再試。', 400);
      }
      const result = await announcementsRef.transaction((current) => {
        const next: DataRecord = { ...plainRecord(current) };
        assigned.forEach((item) => {
          const old = plainRecord(next[item.id]);
          next[item.id] = {
            ...old,
            title: item.title,
            content: item.content,
            active: item.active,
            timestamp: changedAt,
          };
        });
        return next;
      });
      if (!result.committed) throw new Error('營業公告更新未完成，請重新整理後再試。');
      await appendAudit({ kind, changedAt, changedBy: updatedBy, itemCount: assigned.length, itemIds: assigned.map((item) => item.id) });
      return apiSuccess({ kind, updatedAt: changedAt, itemCount: assigned.length });
    }

    return apiError('不支援的內容類型。', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : '儲存內容失敗。';
    return apiError(message, statusForError(error));
  }
}
