import { createHash } from 'node:crypto';
import { adminDatabaseRef } from '@/lib/firebase-admin';

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';
const ELIGIBLE_PRODUCTS = new Set(['OMG獨享杯', 'OMG雙重奏']);

export type LineMember = { userId: string; displayName: string; pictureUrl?: string };
export type MemberPointEntry = {
  delta: number;
  type: 'pos_purchase' | 'order_reward' | 'legacy_line_reward_migration' | 'order_reward_reversal';
  sourceLabel: string;
  createdAt: number;
  orderNo: string;
  channel: 'pos' | 'online' | 'pos_migration';
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
  return (items || []).reduce((total, item) => total + (ELIGIBLE_PRODUCTS.has(normalizeProductName(item.name)) ? quantityOf(item) : 0), 0);
}

async function firebaseJson<T>(path: string) {
  const snapshot = await adminDatabaseRef(path).get();
  return { value: snapshot.val() as T, etag: undefined };
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

export async function consumeMemberQrClaim(token: string, expectedMode: 'member' | 'legacy' = 'member'): Promise<LineMember> {
  const match = /^gelato-member-claim:(member|legacy):([A-Za-z0-9_-]{20,})$/.exec(String(token || '').trim());
  if (!match || match[1] !== expectedMode) throw new Error('會員條碼無效或已過期');
  const claimHash = createHash('sha256').update(match[2]).digest('hex');
  const claimRef = adminDatabaseRef(`memberQrClaims/${claimHash}`);
  const result = await claimRef.transaction((current) => {
    if (!current || current.usedAt || Number(current.expiresAt || 0) < Date.now()) return;
    return { ...current, usedAt: Date.now() };
  });
  if (!result.committed) throw new Error('會員條碼無效或已使用');
  const claim = result.snapshot.val() as { userId?: string } | null;
  if (!claim?.userId) throw new Error('會員條碼資料不完整');
  return { userId: claim.userId, displayName: 'LINE 會員' };
}

export async function peekMemberQrClaim(token: string): Promise<LineMember> {
  const match = /^gelato-member-claim:(member|legacy):([A-Za-z0-9_-]{20,})$/.exec(String(token || '').trim());
  if (!match) throw new Error('會員條碼無效或已過期');
  const claimHash = createHash('sha256').update(match[2]).digest('hex');
  const claim = (await adminDatabaseRef(`memberQrClaims/${claimHash}`).get()).val() as { userId?: string; expiresAt?: number; usedAt?: number } | null;
  if (!claim?.userId || claim.usedAt || Number(claim.expiresAt || 0) < Date.now()) throw new Error('會員條碼無效或已過期');
  return { userId: claim.userId, displayName: 'LINE 會員' };
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
  const member = accessToken.startsWith('gelato-member-claim:')
    ? await consumeMemberQrClaim(accessToken, 'member')
    : await getLineMember(accessToken);
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

  let alreadyProcessed = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    if (entries[entryId]) { alreadyProcessed = true; return account; }
    const entry: MemberPointEntry = { delta: points, type: 'pos_purchase', sourceLabel: '現場購買獨享杯／雙重奏', createdAt: Date.now(), orderNo: orderKey, channel: 'pos', idempotencyKey: entryId };
    return { balance: Math.max(0, Number(account.balance || 0)) + points, updatedAt: Date.now(), entries: { ...entries, [entryId]: entry } };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  const account = result.snapshot.val() as MemberPointsAccount;
  return { member, points: alreadyProcessed ? Number(account.entries?.[entryId]?.delta || 0) : points, balance: Math.max(0, Number(account.balance || 0)), alreadyProcessed };
}

function isTerminalOrderStatus(status?: string) {
  return ['cancelled', 'canceled', 'rejected', 'refunded', 'voided'].includes(String(status || '').toLowerCase());
}

export async function earnOnlineOrderPoints({ accessToken, orderNo }: { accessToken: string; orderNo: string }) {
  const member = await getLineMember(accessToken);
  const order = await findOrderByNo(String(orderNo));
  if (!order) throw new Error('找不到線上訂單');
  if (order.channel !== 'online' && order.source !== 'LIFF') throw new Error('這不是線上會員訂單');
  if (order.userId !== member.userId) throw new Error('訂單會員與登入會員不一致');
  if (order.cancelled || order.rejected || order.voided || order.refunded || isTerminalOrderStatus(order.status)) throw new Error('訂單已取消或退款，不能發送點數');
  const points = calculatePosPoints(order.items);
  if (points <= 0) return { member, points: 0, balance: Math.max(0, Number((await getMemberPoints(member.userId)).balance || 0)), alreadyProcessed: false };

  const orderKey = String(order.orderNo || orderNo);
  const entryId = `order_${createHash('sha256').update(`${member.userId}:${orderKey}`).digest('hex').slice(0, 24)}`;
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  let alreadyProcessed = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    if (entries[entryId]) { alreadyProcessed = true; return account; }
    const entry: MemberPointEntry = { delta: points, type: 'order_reward', sourceLabel: '線上訂單獨享杯／雙重奏集點', createdAt: Date.now(), orderNo: orderKey, channel: 'online', idempotencyKey: entryId };
    return { balance: Math.max(0, Number(account.balance || 0)) + points, updatedAt: Date.now(), entries: { ...entries, [entryId]: entry } };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  const account = result.snapshot.val() as MemberPointsAccount;
  return { member, points: alreadyProcessed ? Number(account.entries?.[entryId]?.delta || 0) : points, balance: Math.max(0, Number(account.balance || 0)), alreadyProcessed };
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
  let points = 0;
  let alreadyReversed = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    const earned = Object.entries(entries).filter(([, entry]) =>
      Number(entry.delta || 0) > 0 && String(entry.orderNo || '') === String(orderNo)
        && (entry.type === 'pos_purchase' || entry.type === 'order_reward'),
    );
    if (!earned.length) return account;
    const reversible = earned.filter(([entryId]) => !entries[`reversal_${entryId}`]);
    if (!reversible.length) { alreadyReversed = true; return account; }
    points = reversible.reduce((sum, [, entry]) => sum + Number(entry.delta || 0), 0);
    const now = Date.now();
    const nextEntries = { ...entries } as Record<string, MemberPointEntry>;
    for (const [entryId, entry] of reversible) {
      nextEntries[`reversal_${entryId}`] = {
        delta: -Math.abs(Number(entry.delta || 0)),
        type: 'order_reward_reversal',
        sourceLabel: '訂單取消／退款，撤銷原集點',
        createdAt: now,
        orderNo: String(orderNo),
        channel: entry.channel || 'pos',
        idempotencyKey: `reversal_${entryId}`,
      };
    }
    return { balance: Math.max(0, Number(account.balance || 0) - points), updatedAt: now, entries: nextEntries };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  const account = result.snapshot.val() as MemberPointsAccount;
  return { points, balance: Math.max(0, Number(account.balance || 0)), alreadyReversed };
}

export async function migrateLegacyLinePoints({ accessToken, points, operator }: { accessToken: string; points: number; operator?: string }) {
  const member = await getLineMember(accessToken);
  const amount = Number(points);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10) throw new Error('舊點卡轉入點數必須是 0 至 10 的整數');
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const entryId = `legacy_${createHash('sha256').update(member.userId).digest('hex').slice(0, 24)}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await firebaseJson<MemberPointsAccount>(path);
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
    await adminDatabaseRef(path).set(next);
    return { member, points: amount, balance: next.balance, alreadyProcessed: false, operator: operator || 'POS' };
  }
  throw new Error('會員點數正在被其他交易更新，請重新操作一次');
}
