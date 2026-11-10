import { createHash, randomBytes } from 'node:crypto';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { isOrderTerminal } from '@/lib/order-status';
import { DEFAULT_POS_POINT_RULES, isDouble11CampaignAt, parsePosPointRules, resolvePosPointMultiplier } from '@/lib/pos-point-rules';
import { isMemberRewardType, MEMBER_REWARD_OPTIONS, type MemberRewardType } from '@/lib/member-rewards';

const ELIGIBLE_PRODUCTS = new Set(['OMG獨享杯', 'OMG雙重奏']);

export type LineMember = { userId: string; displayName: string; pictureUrl?: string };
export type MemberPointEntry = {
  delta: number;
  type: 'pos_purchase' | 'order_reward' | 'legacy_line_reward_migration' | 'order_reward_reversal' | 'reward_redemption';
  sourceLabel: string;
  createdAt: number;
  orderNo?: string;
  orderId?: string;
  channel: 'pos' | 'online' | 'pos_migration' | 'member';
  idempotencyKey: string;
  basePoints?: number;
  multiplier?: number;
  ruleSource?: 'manual' | 'campaign' | 'standard';
  ruleLabel?: string;
};
export type MemberRewardVoucher = {
  id: string;
  rewardType: MemberRewardType;
  title: string;
  pointsCost: number;
  status: 'issued' | 'redeemed';
  issuedAt: number;
  redeemedAt?: number;
  redeemedBy?: string;
  redemptionIdempotencyKey?: string;
};
export type MemberPointsAccount = {
  balance?: number;
  updatedAt?: number;
  entries?: Record<string, MemberPointEntry>;
  rewardVouchers?: Record<string, MemberRewardVoucher>;
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
  refundedAt?: string;
  refundCompletedAt?: string;
  paymentRefundedAt?: string;
  refundStatus?: string;
  cancelledBy?: string;
  pointsAwardStatus?: string;
  pointsReversalStatus?: string;
  isTest?: boolean;
  time?: string;
  paidAt?: string;
  completedAt?: string;
  createdAt?: string | number;
  date?: string;
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

export async function consumeMemberQrClaim(token: string, expectedMode: 'member' | 'legacy' = 'member', orderNo?: string, orderId?: string): Promise<LineMember> {
  const match = /^gelato-member-claim:(member|legacy):([A-Za-z0-9_-]{20,})$/.exec(String(token || '').trim());
  if (!match || match[1] !== expectedMode) throw new Error('會員條碼無效或已過期');
  const claimHash = createHash('sha256').update(match[2]).digest('hex');
  const claimRef = adminDatabaseRef(`memberQrClaims/${claimHash}`);
  const retryUntil = Date.now() + 15 * 60 * 1000;
  const result = await claimRef.transaction((current) => {
    if (!current) return;
    if (current.usedAt) {
      if (orderNo && orderId
        && String(current.usedForOrderNo || '') === String(orderNo)
        && String(current.usedForOrderId || '') === String(orderId)
        && Number(current.usedRetryUntil || 0) >= Date.now()) return current;
      return;
    }
    if (Number(current.expiresAt || 0) < Date.now()) return;
    const now = Date.now();
    return {
      ...current,
      usedAt: now,
      ...(orderNo ? { usedForOrderNo: String(orderNo) } : {}),
      ...(orderId ? { usedForOrderId: String(orderId) } : {}),
      ...(orderNo && orderId ? { usedRetryUntil: retryUntil } : {}),
    };
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

export async function findOrderByNo(orderNo: string, orderId?: string) {
  if (orderId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) return null;
    const snapshot = await adminDatabaseRef(`orders/${orderId}`).get();
    const order = snapshot.val() as Omit<PointOrder, 'key'> | null;
    if (!order || String(order.orderNo) !== String(orderNo)) return null;
    return { ...order, key: orderId } as PointOrder;
  }
  const result = await firebaseJson<Record<string, Omit<PointOrder, 'key'>> | null>('orders');
  const matches = Object.entries(result.value || {}).filter(([, order]) => String(order?.orderNo) === String(orderNo));
  if (matches.length > 1) throw new Error('訂單編號對應多筆記錄，請重新整理後以雲端訂單 key 操作');
  const match = matches[0];
  return match ? ({ key: match[0], ...match[1] } as PointOrder) : null;
}

async function isUniqueOrderNoForId(orderNo: string, orderId: string) {
  const snapshot = await adminDatabaseRef('orders').get();
  const orders = snapshot.val() as Record<string, { orderNo?: string | number }> | null;
  let matchCount = 0;
  let matchedId = '';
  for (const [key, order] of Object.entries(orders || {})) {
    if (String(order?.orderNo ?? '') !== String(orderNo)) continue;
    matchCount += 1;
    matchedId = key;
    if (matchCount > 1) return false;
  }
  return matchCount === 1 && matchedId === orderId;
}

function orderIsSettled(order: PointOrder) {
  if (isOrderTerminal(order)) return false;
  const refund = String(order.refundStatus || '').toLowerCase();
  if (['refunded', 'refund', 'success', 'succeeded', 'completed'].includes(refund)) return false;
  const status = String(order.status || '').toLowerCase();
  if (['cancelled', 'canceled', 'rejected', 'refunded', 'voided'].includes(status)) return false;
  const payment = String(order.paymentStatus || '').toLowerCase();
  if (order.payment === '現場付款') return ['completed', 'complete', '已完成', 'paid', ''].includes(status) || order.paid === true;
  return order.paid === true || ['paid', 'success', 'succeeded', 'completed'].includes(payment);
}

function orderPurchaseTimestamp(order: PointOrder) {
  for (const value of [order.paidAt, order.time, order.completedAt, order.createdAt]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof order.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(order.date)) {
    const parsed = Date.parse(`${order.date}T12:00:00+08:00`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function orderCreatedTimestamp(order: PointOrder) {
  for (const value of [order.createdAt, order.time]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof order.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(order.date)) {
    const parsed = Date.parse(`${order.date}T12:00:00+08:00`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return orderPurchaseTimestamp(order);
}


export async function earnPosPoints({ accessToken, orderNo, orderId }: { accessToken: string; orderNo: string; orderId: string }) {
  if (!orderId) throw new Error('缺少 POS 雲端訂單識別碼');
  const order = await findOrderByNo(orderNo, orderId);
  if (!order) throw new Error('找不到相符的 POS 雲端訂單');
  if (order.isTest === true) throw new Error('測試訂單不能發送會員點數');
  if (order.channel === 'online' || order.source === 'LIFF') throw new Error('線上訂單不能使用 POS 現場入點');
  if (order.channel !== 'store' && order.source !== 'POS') throw new Error('只允許 POS 現場訂單發送點數');
  if (!order.userId) throw new Error('這筆訂單尚未綁定會員，請重新結帳並掃描會員');
  if (!orderIsSettled(order)) throw new Error('訂單尚未完成付款，暫時不能發送點數');

  const member = accessToken.startsWith('gelato-member-claim:')
    ? await consumeMemberQrClaim(accessToken, 'member', orderNo, orderId)
    : await getLineMember(accessToken);
  if (order.userId !== member.userId) throw new Error('訂單會員與掃描會員不一致');

  const basePoints = calculatePosPoints(order.items);
  if (basePoints <= 0) return { member, points: 0, basePoints: 0, multiplier: 1, ruleSource: 'standard', ruleLabel: '一般倍率 1x', balance: Math.max(0, Number((await getMemberPoints(member.userId)).balance || 0)), alreadyProcessed: false };

  const rulesSnapshot = await adminDatabaseRef('posPointSettings/current').get();
  const rules = rulesSnapshot.val() ? parsePosPointRules(rulesSnapshot.val()) : DEFAULT_POS_POINT_RULES;
  const orderTimestamp = orderCreatedTimestamp(order);
  const appliedRule = isDouble11CampaignAt(orderTimestamp)
    ? { multiplier: 1, source: 'standard' as const, label: '雙11活動限線上訂單，門市固定 1x' }
    : resolvePosPointMultiplier(rules, orderTimestamp);
  const points = basePoints * appliedRule.multiplier;
  const orderKey = String(order.orderNo || orderNo);
  const entryId = `pos_${createHash('sha256').update(`${member.userId}:${orderId}`).digest('hex').slice(0, 24)}`;
  const legacyEntryId = `pos_${createHash('sha256').update(`${member.userId}:${orderKey}`).digest('hex').slice(0, 24)}`;
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const before = (await adminDatabaseRef(path).get()).val() as MemberPointsAccount | null;
  const legacyEntryExists = Boolean(before?.entries?.[legacyEntryId]);
  const legacyEntryMatches = legacyEntryExists && await isUniqueOrderNoForId(orderKey, orderId);
  if (legacyEntryExists && !legacyEntryMatches && !before?.entries?.[entryId]) {
    throw new Error('此取餐編號已有舊點數紀錄且對應訂單不唯一，為避免重複入點請管理員核對');
  }

  let alreadyProcessed = false;
  let processedEntryId = entryId;
  let ambiguousLegacyEntryDetected = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    alreadyProcessed = false;
    processedEntryId = entryId;
    ambiguousLegacyEntryDetected = false;
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    if (entries[entryId]) {
      alreadyProcessed = true;
      processedEntryId = entryId;
      return account;
    }
    if (entries[legacyEntryId]) {
      if (legacyEntryMatches) {
        alreadyProcessed = true;
        processedEntryId = legacyEntryId;
      } else {
        ambiguousLegacyEntryDetected = true;
      }
      return account;
    }
    const entry: MemberPointEntry = {
      delta: points,
      type: 'pos_purchase',
      sourceLabel: `現場購買獨享杯／雙重奏（${appliedRule.multiplier}x）`,
      createdAt: Date.now(),
      orderNo: orderKey,
      orderId,
      channel: 'pos',
      idempotencyKey: entryId,
      basePoints,
      multiplier: appliedRule.multiplier,
      ruleSource: appliedRule.source,
      ruleLabel: appliedRule.label,
    };
    return { ...account, balance: Math.max(0, Number(account.balance || 0)) + points, updatedAt: Date.now(), entries: { ...entries, [entryId]: entry } };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  if (ambiguousLegacyEntryDetected) throw new Error('此取餐編號已有舊點數紀錄且無法唯一對應，請管理員核對後再操作');
  const account = result.snapshot.val() as MemberPointsAccount;
  await reverseIfOrderIsTerminal(orderKey, orderId);
  let orderBecameTerminal = false;
  const statusResult = await adminDatabaseRef(`orders/${orderId}`).transaction((current) => {
    orderBecameTerminal = false;
    if (!current) return;
    if (isOrderTerminal(current)) { orderBecameTerminal = true; return; }
    return {
      ...current,
      pointsAwardStatus: 'awarded',
      pointsAwardedAt: new Date().toISOString(),
      pointsAwardMultiplier: appliedRule.multiplier,
      pointsAwardRuleSource: appliedRule.source,
    };
  });
  const pointsReversed = !statusResult.committed && orderBecameTerminal;
  if (pointsReversed) await reverseOrderPoints(orderKey, orderId);
  const ledgerEntry = account.entries?.[processedEntryId];
  const latestAccount = await getMemberPoints(member.userId);
  return {
    member,
    points: pointsReversed ? 0 : alreadyProcessed ? Number(ledgerEntry?.delta || 0) : points,
    pointsReversed,
    basePoints: alreadyProcessed ? Number(ledgerEntry?.basePoints || ledgerEntry?.delta || 0) : basePoints,
    multiplier: alreadyProcessed ? Number(ledgerEntry?.multiplier || 1) : appliedRule.multiplier,
    ruleSource: alreadyProcessed ? ledgerEntry?.ruleSource || 'standard' : appliedRule.source,
    ruleLabel: alreadyProcessed ? ledgerEntry?.ruleLabel || '一般倍率 1x' : appliedRule.label,
    balance: Math.max(0, Number(latestAccount.balance || 0)),
    alreadyProcessed,
  };
}

async function reverseIfOrderIsTerminal(orderNo: string, orderId: string) {
  const latestOrder = await findOrderByNo(orderNo, orderId);
  if (!latestOrder || !isOrderTerminal(latestOrder)) return;
  await reverseOrderPoints(orderNo, orderId);
}

type PointsReversalStatus = 'pending' | 'failed' | 'reversed' | 'not_required';

function canTransitionPointsReversalStatus(currentValue: unknown, nextStatus: PointsReversalStatus) {
  const currentStatus = String(currentValue || '').trim().toLowerCase();
  // 已完成回收是吸收終態；「不需回收」只可在入點競態後升級，不能被舊失敗結果覆寫。
  if (currentStatus === 'reversed') return nextStatus === 'reversed';
  if (currentStatus === 'not_required' && nextStatus === 'failed') return false;
  return true;
}

async function updatePointsReversalStatus(
  orderKey: string,
  nextStatus: PointsReversalStatus,
  fields: Record<string, unknown>,
) {
  let transitionBlocked = false;
  const result = await adminDatabaseRef(`orders/${orderKey}`).transaction((current) => {
    transitionBlocked = false;
    if (!current || typeof current !== 'object') return;
    const order = current as Record<string, unknown>;
    if (!canTransitionPointsReversalStatus(order.pointsReversalStatus, nextStatus)) {
      transitionBlocked = true;
      return;
    }
    return { ...order, ...fields, pointsReversalStatus: nextStatus };
  });
  if (!result.committed && !transitionBlocked) {
    throw new Error('訂單點數回收狀態更新失敗，請稍後重試');
  }
  return result.snapshot.val();
}

export async function earnOnlineOrderPoints({ accessToken, orderNo, orderId }: { accessToken: string; orderNo: string; orderId: string }) {
  const member = await getLineMember(accessToken);
  const order = await findOrderByNo(String(orderNo), orderId);
  if (!order) throw new Error('找不到相符的線上訂單');
  if (order.isTest === true) throw new Error('測試訂單不能發送會員點數');
  if (order.channel !== 'online' && order.source !== 'LIFF') throw new Error('這不是線上會員訂單');
  if (order.userId == null) throw new Error('訂單未綁定 LINE 會員');
  if (isOrderTerminal(order)) throw new Error('訂單已取消或退款，不能發送點數');
  if (order.userId !== member.userId) throw new Error('訂單會員與登入會員不一致');
  const basePoints = calculatePosPoints(order.items);
  const multiplier = isDouble11CampaignAt(orderCreatedTimestamp(order)) ? 2 : 1;
  const points = basePoints * multiplier;
  if (points <= 0) return { member, points: 0, basePoints: 0, multiplier: 1, balance: Math.max(0, Number((await getMemberPoints(member.userId)).balance || 0)), alreadyProcessed: false };

  const orderKey = String(order.orderNo || orderNo);
  const entryId = `order_${createHash('sha256').update(`${member.userId}:${orderId}`).digest('hex').slice(0, 24)}`;
  const legacyEntryId = `order_${createHash('sha256').update(`${member.userId}:${orderKey}`).digest('hex').slice(0, 24)}`;
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const before = (await adminDatabaseRef(path).get()).val() as MemberPointsAccount | null;
  const legacyEntryExists = Boolean(before?.entries?.[legacyEntryId]);
  const legacyEntryMatches = legacyEntryExists && await isUniqueOrderNoForId(orderKey, orderId);
  if (legacyEntryExists && !legacyEntryMatches && !before?.entries?.[entryId]) {
    throw new Error('此訂單編號已有舊點數紀錄且對應訂單不唯一，為避免重複入點請管理員核對');
  }
  let alreadyProcessed = false;
  let processedEntryId = entryId;
  let ambiguousLegacyEntryDetected = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    alreadyProcessed = false;
    processedEntryId = entryId;
    ambiguousLegacyEntryDetected = false;
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    if (entries[entryId]) {
      alreadyProcessed = true;
      processedEntryId = entryId;
      return account;
    }
    if (entries[legacyEntryId]) {
      if (legacyEntryMatches) {
        alreadyProcessed = true;
        processedEntryId = legacyEntryId;
      } else {
        ambiguousLegacyEntryDetected = true;
      }
      return account;
    }
    const entry: MemberPointEntry = {
      delta: points,
      type: 'order_reward',
      sourceLabel: multiplier === 2 ? '雙11線上訂單獨享杯／雙重奏加碼' : '線上訂單獨享杯／雙重奏集點',
      createdAt: Date.now(),
      orderNo: orderKey,
      orderId,
      channel: 'online',
      idempotencyKey: entryId,
      basePoints,
      multiplier,
      ruleSource: multiplier === 2 ? 'campaign' : 'standard',
      ruleLabel: multiplier === 2 ? '雙11線上限定 2x' : '一般倍率 1x',
    };
    return { ...account, balance: Math.max(0, Number(account.balance || 0)) + points, updatedAt: Date.now(), entries: { ...entries, [entryId]: entry } };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  if (ambiguousLegacyEntryDetected) throw new Error('此訂單編號已有舊點數紀錄且無法唯一對應，請管理員核對後再操作');
  const account = result.snapshot.val() as MemberPointsAccount;
  await reverseIfOrderIsTerminal(orderKey, orderId);
  const ledgerEntry = account.entries?.[processedEntryId];
  return {
    member,
    points: alreadyProcessed ? Number(ledgerEntry?.delta || 0) : points,
    basePoints: alreadyProcessed ? Number(ledgerEntry?.basePoints || ledgerEntry?.delta || 0) : basePoints,
    multiplier: alreadyProcessed ? Number(ledgerEntry?.multiplier || 1) : multiplier,
    ruleSource: alreadyProcessed ? ledgerEntry?.ruleSource || 'standard' : multiplier === 2 ? 'campaign' : 'standard',
    ruleLabel: alreadyProcessed ? ledgerEntry?.ruleLabel || '一般倍率 1x' : multiplier === 2 ? '雙11線上限定 2x' : '一般倍率 1x',
    balance: Math.max(0, Number(account.balance || 0)),
    alreadyProcessed,
  };
}

export async function reverseOrderPoints(orderNo: string, orderId: string) {
  if (!orderId) throw new Error('缺少雲端訂單 key，無法安全回收點數');
  const order = await findOrderByNo(String(orderNo), orderId);
  if (!order) throw new Error('找不到要撤銷點數的訂單');
  if (!isOrderTerminal(order)) throw new Error('訂單尚未取消或退款，不能撤銷點數');
  if (!order.userId) {
    await updatePointsReversalStatus(order.key, 'not_required', {
      pointsReversalPoints: 0,
      pointsReversalCheckedAt: Date.now(),
      pointsReversalError: null,
    });
    return { points: 0, balance: 0, alreadyReversed: false };
  }

  const path = `memberPoints/${encodeURIComponent(memberKey(order.userId))}`;
  let points = 0;
  let alreadyReversed = false;
  try {
    let allowLegacyFallback = false;
    const before = (await adminDatabaseRef(path).get()).val() as MemberPointsAccount | null;
    const beforeEntries = Object.values(before?.entries || {});
    const hasExactLedgerEntry = beforeEntries.some((entry) =>
      Number(entry.delta || 0) > 0 && entry.orderId === orderId
        && (entry.type === 'pos_purchase' || entry.type === 'order_reward'),
    );
    const legacyEntries = beforeEntries.filter((entry) =>
      Number(entry.delta || 0) > 0 && !entry.orderId && String(entry.orderNo || '') === String(orderNo)
        && (entry.type === 'pos_purchase' || entry.type === 'order_reward'),
    );
    if (!hasExactLedgerEntry && legacyEntries.length) {
      allowLegacyFallback = await isUniqueOrderNoForId(String(orderNo), orderId);
      if (!allowLegacyFallback) {
        throw new Error('此取餐編號有舊點數流水但對應多筆訂單，為避免撤錯點數已停止自動回收，請管理員核對');
      }
    }
    const matchesOrder = (entry: MemberPointEntry) => {
      if (entry.orderId) return entry.orderId === orderId;
      return allowLegacyFallback && String(entry.orderNo || '') === String(orderNo);
    };
    let ambiguousLegacyEntryDetected = false;
    const result = await adminDatabaseRef(path).transaction((current) => {
      points = 0;
      alreadyReversed = false;
      ambiguousLegacyEntryDetected = false;
      const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
      const entries = account.entries || {};
      if (!allowLegacyFallback) {
        const values = Object.values(entries);
        const exactExists = values.some((entry) => Number(entry.delta || 0) > 0 && entry.orderId === orderId
          && (entry.type === 'pos_purchase' || entry.type === 'order_reward'));
        const legacyExists = values.some((entry) => Number(entry.delta || 0) > 0 && !entry.orderId
          && String(entry.orderNo || '') === String(orderNo)
          && (entry.type === 'pos_purchase' || entry.type === 'order_reward'));
        if (!exactExists && legacyExists) {
          ambiguousLegacyEntryDetected = true;
          return account;
        }
      }
      const earned = Object.entries(entries).filter(([, entry]) =>
        Number(entry.delta || 0) > 0 && matchesOrder(entry)
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
          orderId: entry.orderId || orderId,
          channel: entry.channel || 'pos',
          idempotencyKey: `reversal_${entryId}`,
        };
      }
      return { ...account, balance: Math.max(0, Number(account.balance || 0) - points), updatedAt: now, entries: nextEntries };
    });
    if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
    if (ambiguousLegacyEntryDetected) throw new Error('此取餐編號有舊點數流水且無法唯一對應，為避免撤錯點數已停止自動回收，請管理員核對');
    const account = result.snapshot.val() as MemberPointsAccount;
    const entries = account.entries || {};
    const earned = Object.entries(entries).filter(([, entry]) =>
      Number(entry.delta || 0) > 0 && matchesOrder(entry)
        && (entry.type === 'pos_purchase' || entry.type === 'order_reward'),
    );
    const reversedPoints = earned.reduce((sum, [entryId]) => sum + Math.abs(Number(entries[`reversal_${entryId}`]?.delta || 0)), 0);
    const allReversed = earned.length > 0 && earned.every(([entryId]) => entries[`reversal_${entryId}`]);
    const nextStatus: PointsReversalStatus = allReversed ? 'reversed' : earned.length ? 'pending' : 'not_required';
    const reversalPatch: Record<string, unknown> = {
      pointsReversalPoints: reversedPoints,
      pointsReversalCheckedAt: Date.now(),
      pointsReversalCompletedAt: allReversed ? Date.now() : null,
      pointsReversalError: null,
    };
    if (allReversed) reversalPatch.pointsAwardStatus = 'reversed';
    await updatePointsReversalStatus(order.key, nextStatus, reversalPatch);
    return { points, balance: Math.max(0, Number(account.balance || 0)), alreadyReversed };
  } catch (error) {
    const message = error instanceof Error ? error.message : '會員點數回收失敗';
    try {
      await updatePointsReversalStatus(order.key, 'failed', {
        pointsReversalError: message.slice(0, 300),
        pointsReversalFailedAt: Date.now(),
      });
    } catch (statusError) {
      console.error('記錄訂單點數回收失敗狀態時發生錯誤:', statusError);
    }
    throw error;
  }
}

export async function migrateLegacyLinePoints({ accessToken, points, operator }: { accessToken: string; points: number; operator?: string }) {
  const member = await getLineMember(accessToken);
  const amount = Number(points);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10) throw new Error('舊點卡轉入點數必須是 0 至 10 的整數');
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const entryId = `legacy_${createHash('sha256').update(member.userId).digest('hex').slice(0, 24)}`;
  let alreadyProcessed = false;
  const result = await adminDatabaseRef(path).transaction((current) => {
    alreadyProcessed = false;
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const entries = account.entries || {};
    if (entries[entryId]) { alreadyProcessed = true; return account; }
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
    return { ...account, balance: Math.max(0, Number(account.balance || 0)) + amount, updatedAt: now, entries: { ...entries, [entryId]: entry } };
  });
  if (!result.committed) throw new Error('會員點數正在被其他交易更新，請重新操作一次');
  const account = result.snapshot.val() as MemberPointsAccount;
  return { member, points: Number(account.entries?.[entryId]?.delta || 0), balance: Math.max(0, Number(account.balance || 0)), alreadyProcessed, ...(alreadyProcessed ? {} : { operator: operator || 'POS' }) };
}

const REWARD_QR_TTL_MS = 5 * 60 * 1000;

export class MemberRewardError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); this.name = 'MemberRewardError'; }
}

export async function issueMemberRewardVoucher(accessToken: string, rewardType: MemberRewardType, idempotencyKey: string) {
  if (!isMemberRewardType(rewardType)) throw new MemberRewardError('兌換獎項無效');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) throw new MemberRewardError('兌換請求識別碼格式錯誤');
  const member = await getLineMember(accessToken);
  const reward = MEMBER_REWARD_OPTIONS.find((option) => option.type === rewardType);
  if (!reward) throw new MemberRewardError('兌換獎項無效');
  const voucherId = `rv_${createHash('sha256').update(`${member.userId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
  const entryId = `reward_${voucherId}`;
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const now = Date.now();
  let alreadyProcessed = false;
  let failure = '';
  const result = await adminDatabaseRef(path).transaction((current) => {
    alreadyProcessed = false; failure = '';
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const vouchers = account.rewardVouchers || {};
    const existing = vouchers[voucherId];
    if (existing) {
      if (existing.rewardType !== rewardType) { failure = '此兌換請求已用於不同獎項，請重新整理後再試'; return; }
      alreadyProcessed = true;
      return account;
    }
    const balance = Math.max(0, Number(account.balance || 0));
    if (!Number.isFinite(balance) || balance < reward.pointsCost) { failure = `點數不足，兌換此券需要 ${reward.pointsCost} 點`; return; }
    const voucher: MemberRewardVoucher = { id: voucherId, rewardType, title: reward.title, pointsCost: reward.pointsCost, status: 'issued', issuedAt: now };
    const entry: MemberPointEntry = { delta: -reward.pointsCost, type: 'reward_redemption', sourceLabel: reward.title.includes('券') ? `兌換${reward.title}` : `兌換${reward.title}兌換券`, createdAt: now, channel: 'member', idempotencyKey: entryId };
    return { ...account, balance: balance - reward.pointsCost, updatedAt: now, entries: { ...(account.entries || {}), [entryId]: entry }, rewardVouchers: { ...vouchers, [voucherId]: voucher } };
  });
  if (!result.committed) throw new MemberRewardError(failure || '點數正在更新，請稍後重試', failure ? 409 : 503);
  const account = result.snapshot.val() as MemberPointsAccount;
  const voucher = account.rewardVouchers?.[voucherId];
  if (!voucher) throw new MemberRewardError('兌換券建立狀態不明，請重新整理會員頁確認', 503);
  return { member, points: account, voucher, alreadyProcessed };
}

type MemberRewardQrClaim = { userId: string; voucherId: string; createdAt: number; expiresAt: number };

function parseMemberRewardToken(token: string) {
  const match = /^gelato-reward-claim:([A-Za-z0-9_-]{43})$/.exec(String(token || '').trim());
  if (!match) throw new MemberRewardError('兌換券條碼格式無效', 400);
  return createHash('sha256').update(match[1]).digest('hex');
}

async function readMemberRewardQrClaim(token: string, allowExpired = false) {
  const tokenHash = parseMemberRewardToken(token);
  const claim = (await adminDatabaseRef(`rewardQrClaims/${tokenHash}`).get()).val() as MemberRewardQrClaim | null;
  if (!claim?.userId || !claim.voucherId || (!allowExpired && Number(claim.expiresAt || 0) <= Date.now())) throw new MemberRewardError('兌換券條碼已失效，請顧客重新開啟券碼', 410);
  return claim;
}

export async function createMemberRewardQrClaim(accessToken: string, voucherId: string) {
  if (!/^rv_[a-f0-9]{32}$/.test(voucherId)) throw new MemberRewardError('兌換券識別碼無效');
  const member = await getLineMember(accessToken);
  const path = `memberPoints/${encodeURIComponent(memberKey(member.userId))}`;
  const account = (await adminDatabaseRef(path).get()).val() as MemberPointsAccount | null;
  const voucher = account?.rewardVouchers?.[voucherId];
  if (!voucher) throw new MemberRewardError('找不到這張兌換券', 404);
  if (voucher.status !== 'issued') throw new MemberRewardError('這張兌換券已核銷，不能再次使用', 409);
  const secret = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + REWARD_QR_TTL_MS;
  await adminDatabaseRef(`rewardQrClaims/${createHash('sha256').update(secret).digest('hex')}`).set({ userId: member.userId, voucherId, createdAt: now, expiresAt } satisfies MemberRewardQrClaim);
  return { token: `gelato-reward-claim:${secret}`, expiresAt };
}

export async function previewMemberRewardQrClaim(token: string) {
  const claim = await readMemberRewardQrClaim(token);
  const path = `memberPoints/${encodeURIComponent(memberKey(claim.userId))}`;
  const account = (await adminDatabaseRef(path).get()).val() as MemberPointsAccount | null;
  const voucher = account?.rewardVouchers?.[claim.voucherId];
  if (!voucher) throw new MemberRewardError('找不到這張兌換券', 404);
  return { voucher: { id: voucher.id, rewardType: voucher.rewardType, title: voucher.title, pointsCost: voucher.pointsCost, status: voucher.status, issuedAt: voucher.issuedAt, ...(voucher.redeemedAt ? { redeemedAt: voucher.redeemedAt } : {}) }, canRedeem: voucher.status === 'issued' };
}

export async function redeemMemberRewardQrClaim(token: string, staffUid: string, idempotencyKey: string) {
  if (!staffUid || staffUid.length > 128) throw new MemberRewardError('無法識別核銷店員', 401);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) throw new MemberRewardError('核銷請求識別碼格式錯誤');
  const claim = await readMemberRewardQrClaim(token, true);
  const path = `memberPoints/${encodeURIComponent(memberKey(claim.userId))}`;
  const now = Date.now();
  let alreadyProcessed = false;
  let failure = '';
  const result = await adminDatabaseRef(path).transaction((current) => {
    alreadyProcessed = false; failure = '';
    const account = (current || { balance: 0, entries: {} }) as MemberPointsAccount;
    const vouchers = account.rewardVouchers || {};
    const voucher = vouchers[claim.voucherId];
    if (!voucher) { failure = '找不到這張兌換券'; return; }
    if (voucher.status === 'redeemed') {
      if (voucher.redeemedBy === staffUid && voucher.redemptionIdempotencyKey === idempotencyKey) { alreadyProcessed = true; return account; }
      failure = '這張兌換券已核銷，不能再次使用'; return;
    }
    if (Number(claim.expiresAt || 0) <= Date.now()) { failure = '兌換券條碼已失效，請顧客重新開啟券碼'; return; }
    const redeemed: MemberRewardVoucher = { ...voucher, status: 'redeemed', redeemedAt: now, redeemedBy: staffUid, redemptionIdempotencyKey: idempotencyKey };
    return { ...account, updatedAt: now, rewardVouchers: { ...vouchers, [claim.voucherId]: redeemed } };
  });
  if (!result.committed) throw new MemberRewardError(failure || '兌換券正在核銷，請重新掃描確認', failure ? 409 : 503);
  const account = result.snapshot.val() as MemberPointsAccount;
  const voucher = account.rewardVouchers?.[claim.voucherId];
  if (!voucher || voucher.status !== 'redeemed') throw new MemberRewardError('兌換券核銷狀態不明，請勿重複交付商品並重新查詢', 503);
  return { voucher: { id: voucher.id, rewardType: voucher.rewardType, title: voucher.title, pointsCost: voucher.pointsCost, status: voucher.status, issuedAt: voucher.issuedAt, redeemedAt: voucher.redeemedAt }, alreadyProcessed };
}
