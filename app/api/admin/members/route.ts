import { NextResponse } from 'next/server';
import { getFirebaseAdminAuth, adminDatabaseRef } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DataRecord = Record<string, unknown>;

function isRecord(value: unknown): value is DataRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown, maxLength = 200) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, maxLength) : '';
}

function apiError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function requirePosAdmin(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length > 8192) throw Object.assign(new Error('請先使用 POS 管理員帳號登入。'), { statusCode: 401 });

  let decoded;
  try {
    decoded = await getFirebaseAdminAuth().verifyIdToken(token, true);
  } catch {
    throw Object.assign(new Error('登入憑證已失效，請重新登入。'), { statusCode: 401 });
  }
  if (decoded.posAdmin !== true) throw Object.assign(new Error('此 Google 帳號沒有 posAdmin 管理權限。'), { statusCode: 403 });
}

function maskPhone(value: unknown) {
  const phone = text(value, 40);
  if (!phone) return '';
  const visible = phone.slice(-4);
  return `${'•'.repeat(Math.max(4, phone.length - visible.length))}${visible}`;
}

function asTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const dateOnly = Date.parse(`${value}T12:00:00+08:00`);
      if (Number.isFinite(dateOnly)) return dateOnly;
    }
  }
  return 0;
}

function safeNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function memberIdentifier(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

function safePointEntries(value: unknown) {
  if (!isRecord(value)) return [];
  return Object.values(value)
    .filter(isRecord)
    .map((entry) => ({
      delta: safeNumber(entry.delta),
      type: text(entry.type, 60),
      sourceLabel: text(entry.sourceLabel, 120),
      createdAt: asTimestamp(entry.createdAt),
      orderNo: text(entry.orderNo, 60) || null,
      channel: text(entry.channel, 40) || null,
      ruleLabel: text(entry.ruleLabel, 120) || null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}

function summarizeOrder(order: DataRecord) {
  const rawItems = Array.isArray(order.items) ? order.items : [];
  const items = rawItems.slice(0, 30).filter(isRecord).map((item) => ({
    name: text(item.name, 100) || '商品',
    quantity: Math.max(0, safeNumber(item.qty ?? item.quantity ?? 1)),
  }));
  const timestamp = asTimestamp(order.time ?? order.createdAt ?? order.paidAt ?? order.date);
  return {
    orderNo: text(order.orderNo, 60) || '—',
    timestamp,
    total: safeNumber(order.total ?? order.totalAmount ?? order.amount),
    paymentStatus: text(order.paymentStatus ?? order.payment ?? (order.paid === true ? '已付款' : ''), 60),
    status: text(order.status ?? order.orderStatus, 60),
    items,
  };
}

function queryKeyForOrder(field: string, value: string, criteria: Array<[string, string]>) {
  if (value && !criteria.some(([existingField, existingValue]) => existingField === field && existingValue === value)) {
    criteria.push([field, value]);
  }
}

export async function POST(request: Request) {
  try {
    await requirePosAdmin(request);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 2000) return apiError('查詢內容過大。', 413);
    const body: unknown = await request.json().catch(() => null);
    const search = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
    if (search.length < 3 || search.length > 120) {
      return apiError('請輸入完整會員編號或電話（3 至 120 個字元）。', 400);
    }

    const membersRef = adminDatabaseRef('members');
    const [byNumber, byPhone] = await Promise.all([
      membersRef.orderByChild('memberNo').equalTo(search).limitToFirst(2).get(),
      membersRef.orderByChild('phone').equalTo(search).limitToFirst(2).get(),
    ]);
    const matches = new Map<string, DataRecord>();
    [byNumber, byPhone].forEach((snapshot) => {
      snapshot.forEach((child) => {
        const value = child.val();
        if (child.key && isRecord(value)) matches.set(child.key, value);
        return false;
      });
    });
    if (!matches.size) return apiError('找不到符合的會員；請確認會員編號或完整電話格式。', 404);
    if (matches.size > 1) return apiError('此查詢符合多筆會員資料，請改用唯一的會員編號。', 409);

    const [memberKey, profile] = [...matches.entries()][0];
    const storedMemberKey = text(profile.memberKey, 120) || memberKey;
    const lineUserId = text(profile.lineUserId ?? profile.userId, 160);
    const pointKey = lineUserId
      ? `line_${memberIdentifier(lineUserId)}`
      : storedMemberKey;
    const pointsSnapshot = /^[A-Za-z0-9_-]{1,180}$/.test(pointKey)
      ? await adminDatabaseRef(`memberPoints/${encodeURIComponent(pointKey)}`).get()
      : null;
    const pointsAccount = pointsSnapshot?.val();
    const pointsRecord = isRecord(pointsAccount) ? pointsAccount : {};
    const pointsBalance = Math.max(0, safeNumber(pointsRecord.balance ?? profile.pointsBalance));
    const pointEntries = safePointEntries(pointsRecord.entries);

    const memberNo = text(profile.memberNo, 60);
    const phone = text(profile.phone, 40);
    const orderCriteria: Array<[string, string]> = [];
    if (lineUserId) {
      queryKeyForOrder('userId', lineUserId, orderCriteria);
    }
    queryKeyForOrder('memberNo', memberNo, orderCriteria);

    const orderSnapshots = await Promise.all(orderCriteria.map(async ([field, value]) => {
      return adminDatabaseRef('orders').orderByChild(field).equalTo(value).limitToLast(50).get();
    }));
    const orders = new Map<string, DataRecord>();
    orderSnapshots.forEach((snapshot) => {
      snapshot.forEach((child) => {
        const value = child.val();
        if (child.key && isRecord(value)) orders.set(child.key, value);
        return false;
      });
    });
    const recentOrders = [...orders.values()]
      .map(summarizeOrder)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);

    return NextResponse.json({
      success: true,
      member: {
        memberNo: memberNo || '—',
        displayName: text(profile.displayName, 120) || '未提供姓名',
        phone: maskPhone(phone) || '未提供',
        memberType: text(profile.memberType, 40) || '—',
        createdAt: asTimestamp(profile.createdAt),
        pointsBalance,
        pointsUpdatedAt: asTimestamp(pointsRecord.updatedAt),
      },
      recentPoints: pointEntries,
      recentOrders,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員查詢失敗。';
    const status = error && typeof error === 'object' && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : 500;
    if ([400, 401, 403, 409, 413].includes(status)) return apiError(message, status);
    console.error('管理後台會員查詢失敗:', error);
    return apiError('會員資料暫時無法查詢，請稍後再試。', 500);
  }
}
