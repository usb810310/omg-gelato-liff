import { createHash } from 'node:crypto';

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';
const ELIGIBLE_PRODUCTS = new Set(['OMG獨享杯', 'OMG雙重奏']);

export type LineMember = { userId: string; displayName: string; pictureUrl?: string };
export type MemberPointEntry = {
  delta: number;
  type: 'pos_purchase' | 'order_reward' | 'legacy_line_reward_migration' | 'order_reward_reversal';
  sourceLabel: string;
  createdAt: number;
  orderNo: string;
  channel: 'pos' | 'pos_migration';
  idempotencyKey: string;
};
export type MemberPointsAccount = {
  balance?: number;
  updatedAt?: number;
  entries?: Record<string, MemberPointEntry>;
};
export type PointOrderItem = { name?: unknown; qty?: unknown; quantity?: unknown };
export type PointOrder = {
  key: string;
  orderNo?: string | number;
  userId?: string;
  status?: string;
  paymentStatus?: string;
  payment?: string;
  paid?: boolean;
  cancelled?: boolean;
  rejected?: boolean;
  voided?: boolean;
  refunded?: boolean;
  refundStatus?: string;
  items?: PointOrderItem[];
  source?: string;
  channel?: string;
};

function databaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL).replace(/\/$/, '');
}

function memberKey(userId: string) {
  return `line_${userId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function normalizeProductName(value: unknown) {
  return String(value ?? '').replace(/[\s　]/g, '').trim();
}

function quantityOf(item: PointOrderItem) {
  const value = Number(item.qty ?? item.quantity ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function calculatePosPoints(items: PointOrderItem[] | undefined) {
  return (items || []).reduce((total, item) => {
    return total + (ELIGIBLE_PRODUCTS.has(normalizeProductName(item.name)) ? quantityOf(item) : 0);
  }, 0);
}

export async function getLineMember(accessToken: string): Promise<LineMember> {
  const token = String(accessToken || '').trim();
  if (!token || token.length > 8192) throw new Error('會員 Token 無效');
  const response = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('會員 Token 已失效，請讓顧客重新開啟會員 QR Code');
  const profile = await response.json() as { userId?: string; displayName?: string; pictureUrl?: string };
  if (!profile.userId) throw new Error('LINE 會員資料不完整');
  return { userId: profile.userId, displayName: profile.displayName || 'LINE 會員', pictureUrl: profile.pictureUrl };
}

async function firebaseJson<T>(path: string, init?: RequestInit & { etag?: boolean }) {
  const headers = new Headers(init?.headers);
  if (init?.etag) headers.set('X-Firebase-ETag', 'true');
  const response = await fetch(`${databaseUrl()}/${path.replace(/^\//, '')}.json`, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Firebase 讀寫失敗（${response.status}）`);
  return { value: await response.json() as T, etag: response.headers.get('ETag') };
}

export async function getMemberPoints(userId: string) {
  const result = await firebaseJson<MemberPointsAccount>(`memberPoints/${encodeURIComponent(memberKey(userId))}`);
  return result.value || { balance: 0, entries: {} };
}

export async function findOrderByNo(orderNo: string) {
  const result = await firebaseJson<Record<string, Omit<PointOrder, 'key'>> | null>('orders');
  const match = Object.entries(result.value || {}).find(([, order]) => String(order?.orderNo) === orderNo);
  return match ? ({ key: match[0], ...match[1] } as PointOrder) : null;
}

function orderIsSettled(order: PointOrder) {
  if (order.cancelled || order.rejected || order.voided || order.refunded) return false;
  const refund = String(order.refundStatus || '').toLowerCase();
  if (['refunded', 'refund', 'success', 'succeeded', 'completed'].includes(refund)) return false;
  const status = String(order.status || '').toLowerCase();
  if (['cancelled', 'canceled', 'rejected', 'refunded', 'voided'].includes(status)) return false;
  const payment = String(order.paymentStatus || '').toLowerCase();
  if (order.payment === '現場付款') return ['completed', 'complete', '已完成', 'paid', ''].includes(status) || order.paid === true;
  return order.paid === true || ['paid', 'success', 'succeeded', 'completed'].includes(payment);
}

export async function earnPosPoints({ accessToken, orderNo }: { accessToken: string; orderNo: string }) {
  const member = await getLineMember(accessToken);
  const order = await findOrderByNo(orderNo);
  if (!order) throw new Error('找不到現場訂單，請先完成交易同步');
  if (order.userId && order.userId !== member.userId) throw new Error('訂單會員與掃描會員不一致');
  if (!order.userId) throw new Error('這筆訂單尚未綁定會員，請重新結帳並掃描會員');
  if (!orderIsSettled(order)) throw new Error('訂單尚未完成付款，暫時不能發送點數');

  const points = calculatePosPoints(order.items);
  if (points <= 0) return { member, points: 0, balance: Math.max(0, Number((await getMemberPoints(member.userId)).balance || 0)), alreadyProcessed: false };

  const orderKey = String(order.orderNo || orderNo);
  const entryId = `pos_${createHash('sha256').update(`${member.userId}:${orderKey}`).digest('hex').slice(0, 24)}`;
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await firebaseJson<MemberPointsAccount>(path, { etag: true });
    const account = current.value || { balance: 0, entries: {} };
    const entries = account.entries || {};
    if (entries[entryId]) {
      return { member, points: Number(entries[entryId].delta || 0), balance: Math.max(0, Number(account.balance || 0)), alreadyProcessed: true };
    }
    const entry: MemberPointEntry = {
      delta: points,
      type: 'pos_purchase',
      sourceLabel: '現場購買獨享杯／雙重奏',
      createdAt: Date.now(),
      orderNo: orderKey,
      channel: 'pos',
      idempotencyKey: entryId,
    };
    const next = { balance: Math.max(0, Number(account.balance || 0)) + points, updatedAt: Date.now(), entries: { ...entries, [entryId]: entry } };
    const headers = new Headers({ 'Content-Type': 'application/json', 'If-Match': current.etag || '*' });
    const response = await fetch(`${databaseUrl()}/${path}.json`, { method: 'PUT', headers, body: JSON.stringify(next), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.status === 412) continue;
    if (!response.ok) throw new Error(`Firebase 點數寫入失敗（${response.status}）`);
    return { member, points, balance: next.balance, alreadyProcessed: false };
  }
  throw new Error('會員點數正在被其他交易更新，請重新操作一次');
}

export async function reverseOrderPoints(orderNo: string) {
  const order = await findOrderByNo(String(orderNo));
  if (!order) throw new Error('找不到要撤銷點數的訂單');
  const status = String(order.status || '').toLowerCase();
  const refund = String(order.refundStatus || '').toLowerCase();
  const terminal = order.cancelled || order.rejected || order.voided || order.refunded
    || ['cancelled', 'canceled', 'rejected', 'refunded', 'voided'].includes(status)
    || ['refunded', 'refund', 'success', 'succeeded', 'completed'].includes(refund);
  if (!terminal) throw new Error('訂單尚未取消或退款，不能撤銷點數');
  if (!order.userId) return { points: 0, alreadyReversed: false };

  const path = `memberPoints/${encodeURIComponent(memberKey(order.userId))}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await firebaseJson<MemberPointsAccount>(path, { etag: true });
    const account = current.value || { balance: 0, entries: {} };
    const entries = account.entries || {};
    const earned = Object.entries(entries).filter(([, entry]) =>
      Number(entry.delta || 0) > 0 && String(entry.orderNo || '') === String(orderNo)
        && (entry.type === 'pos_purchase' || entry.type === 'order_reward'),
    );
    if (!earned.length) return { points: 0, alreadyReversed: false };
    const reversible = earned.filter(([entryId]) => !entries[`reversal_${entryId}`]);
    if (!reversible.length) return { points: 0, alreadyReversed: true };
    const points = reversible.reduce((sum, [, entry]) => sum + Number(entry.delta || 0), 0);
    const now = Date.now();
    const nextEntries = { ...entries } as Record<string, MemberPointEntry>;
    for (const [entryId, entry] of reversible) {
      nextEntries[`reversal_${entryId}`] = {
        delta: -Math.abs(Number(entry.delta || 0)),
        type: 'order_reward_reversal',
        sourceLabel: '訂單取消／退款，撤銷原集點',
        createdAt: now,
        orderNo: String(orderNo),
        channel: entry.channel === 'pos' ? 'pos' : 'pos_migration',
        idempotencyKey: `reversal_${entryId}`,
      };
    }
    const next = { balance: Math.max(0, Number(account.balance || 0) - points), updatedAt: now, entries: nextEntries };
    const response = await fetch(`${databaseUrl()}/${path}.json`, {
      method: 'PUT',
      headers: new Headers({ 'Content-Type': 'application/json', 'If-Match': current.etag || '*' }),
      body: JSON.stringify(next), cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    if (response.status === 412) continue;
    if (!response.ok) throw new Error(`Firebase 點數撤銷失敗（${response.status}）`);
    return { points, balance: next.balance, alreadyReversed: false };
  }
  throw new Error('會員點數正在被其他交易更新，請重新操作一次');
}

export async function migrateLegacyLinePoints({ accessToken, points, operator }: { accessToken: string; points: number; operator?: string }) {
  const member = await getLineMember(accessToken);
  const amount = Number(points);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10) throw new Error('舊點卡轉入點數必須是 0 至 10 的整數');
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const entryId = `legacy_${createHash('sha256').update(member.userId).digest('hex').slice(0, 24)}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await firebaseJson<MemberPointsAccount>(path, { etag: true });
    const account = current.value || { balance: 0, entries: {} };
    const entries = account.entries || {};
    if (entries[entryId]) {
      return { member, points: Number(entries[entryId].delta || 0), balance: Math.max(0, Number(account.balance || 0)), alreadyProcessed: true };
    }
    const now = Date.now();
    const entry: MemberPointEntry = {
      delta: amount,
      type: 'legacy_line_reward_migration',
      sourceLabel: 'LINE 官方內建集點卡移轉',
      createdAt: now,
      orderNo: `legacy-migration-${member.userId}`,
      channel: 'pos_migration',
      idempotencyKey: entryId,
    };
    const next = { balance: Math.max(0, Number(account.balance || 0)) + amount, updatedAt: now, entries: { ...entries, [entryId]: entry } };
    const headers = new Headers({ 'Content-Type': 'application/json', 'If-Match': current.etag || '*' });
    const response = await fetch(`${databaseUrl()}/${path}.json`, { method: 'PUT', headers, body: JSON.stringify(next), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.status === 412) continue;
    if (!response.ok) throw new Error(`Firebase 舊點卡移轉寫入失敗（${response.status}）`);
    return { member, points: amount, balance: next.balance, alreadyProcessed: false, operator: operator || 'POS' };
  }
  throw new Error('會員點數正在被其他交易更新，請重新操作一次');
}
