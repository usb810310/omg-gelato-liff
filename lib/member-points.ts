import { createHash } from 'node:crypto';

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';
const ELIGIBLE_PRODUCTS = new Set(['OMG獨享杯', 'OMG雙重奏']);

export type LineMember = { userId: string; displayName: string; pictureUrl?: string };
export type MemberPointEntry = {
  delta: number;
  type: 'pos_purchase';
  sourceLabel: string;
  createdAt: number;
  orderNo: string;
  channel: 'pos';
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
