'use client';

import { startTransition, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import liff from '@line/liff';
import QRCode from 'qrcode';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, onValue, ref } from 'firebase/database';
import { getShopStatus, type BusinessHours } from '@/lib/business-hours';
import { MEMBER_REWARD_OPTIONS, type MemberRewardType } from '@/lib/member-rewards';
import { getPaymentDisplayStatus, isOrderCancelled, isOrderRefunded, isOrderRejected, isOrderTerminal } from '@/lib/order-status';
import styles from './page.module.css';

// ====== 每日動態主題與按鈕設定 ======
const dailyData = [
  { title: "今天想來點特別的嗎？", desc: "寫下你的願望，也許明天就會出現在冰櫃裡！", btnText: "來去許願看看", btnAction: "wish" },
  { title: "新的一週，來點甜蜜的開始吧！", desc: "用一口冰涼的義式風味，為忙碌的星期一注入滿滿活力。", btnText: "查看今日口味", btnAction: "menu" },
  { title: "今天店休中", desc: "但我們 24/7 都在線上，有任何問題都可以透過文字對話詢問我們。", btnText: "開啟線上詢問", btnAction: "inquiry" },
  { title: "小週末，來點濃郁的獎勵！", desc: "熬過了一半的工作週，用濃郁的可可或提拉米蘇犒賞自己吧。", btnText: "查看今日口味", btnAction: "menu" },
  { title: "清爽一下，掃除疲憊！", desc: "來點酸甜的檸檬雪酪，為即將到來的週末做好準備。", btnText: "查看今日口味", btnAction: "menu" },
  { title: "週末狂歡前，先來一球！", desc: "經典的義式甜蜜，為你揭開美好週末的序幕。", btnText: "查看今日口味", btnAction: "menu" },
  { title: "悠閒的假日時光", desc: "就用熱帶水果的香甜，陪你度過美好的週末午後。", btnText: "查看今日口味", btnAction: "menu" }
];
// ===================================

type Profile = { userId: string; displayName: string; pictureUrl?: string; memberNo?: string };
type LineFriendStatus = 'checking' | 'friend' | 'not-friend' | 'unavailable';

type PointCampaign = {
  id?: string;
  name?: string;
  date?: string;
  active?: boolean;
  ruleText?: string;
  description?: string;
  bonusPoints?: number;
};

type MemberPointsAccount = {
  balance?: number;
  updatedAt?: number;
  entries?: Record<string, { delta?: number; type?: string; sourceLabel?: string; createdAt?: number; orderNo?: string }>;
  rewardVouchers?: Record<string, MemberRewardVoucher>;
};

type MemberRewardVoucher = {
  id: string;
  rewardType: MemberRewardType;
  title: string;
  pointsCost: number;
  status: 'issued' | 'redeemed';
  issuedAt: number;
  redeemedAt?: number;
};

type MemberDialog =
  | { kind: 'history' }
  | { kind: 'voucher-qr'; voucherId: string }
  | { kind: 'redeem-confirm'; reward: (typeof MEMBER_REWARD_OPTIONS)[number] }
  | { kind: 'wish-confirm' }
  | { kind: 'notice'; title: string; message: string; tone?: 'success' | 'error' | 'info' };

type Order = {
  id?: string; userId?: string;
  orderNo?: string | number; displayNo?: string | number;
  pickupCode?: string | number; pickupNo?: string | number; pickupNumber?: string | number;
  total?: string | number; remark?: string; time?: string; date?: string; createdAt?: string;
  status?: string; payment?: string; paymentStatus?: string; refundStatus?: string;
  cancelled?: boolean; refunded?: boolean; refundedAt?: string; refundCompletedAt?: string; paymentRefundedAt?: string;
  channel?: string; source?: string; rejected?: boolean; voided?: boolean; cancelledBy?: string;
  pointsReversalStatus?: string;
  items?: OrderItem[];
};

type OrderItem = { name?: string; price?: number; qty?: number; flavorDisplay?: string };

function getOrderKey(order: Order) {
  return String(order.orderNo ?? order.id ?? '');
}

const ORDER_HISTORY_DAYS = 30;
const ORDER_HISTORY_MS = ORDER_HISTORY_DAYS * 24 * 60 * 60 * 1000;
const ORDER_POINTS_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

function isRecentOrder(order: Order) {
  const rawDate = order.time || order.createdAt || order.date;
  if (!rawDate) return true;
  const timestamp = new Date(rawDate).getTime();
  return Number.isNaN(timestamp) || Date.now() - timestamp <= ORDER_HISTORY_MS;
}

function getPaymentStatus(order: Order) {
  return getPaymentDisplayStatus(order);
}

function getOrderStatus(order: Order) {
  return getStatusMeta(order).label;
}

function isWaitingForShop(order: Order) {
  const status = String(order.status || '').trim();
  return !isOrderTerminal(order) && ['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status);
}

function needsOrderRecoveryRetry(order: Order) {
  const pointsNeedRetry = !['reversed', 'not_required'].includes(String(order.pointsReversalStatus || '').toLowerCase());
  const refundNeedsRetry = order.cancelledBy === 'customer' && ['failed', 'pending'].includes(String(order.refundStatus || '').toLowerCase());
  return isOrderTerminal(order) && (pointsNeedRetry || refundNeedsRetry);
}

type OrderStatusKey = 'waiting' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'rejected';
const statusSteps: Array<{ key: Exclude<OrderStatusKey, 'rejected'>; label: string; icon: string }> = [
  { key: 'waiting', label: '等待接單', icon: '01' },
  { key: 'accepted', label: '店家已接單', icon: '02' },
  { key: 'preparing', label: '製作中', icon: '03' },
  { key: 'ready', label: '可以取餐', icon: '04' },
];

function getStatusMeta(order: Order) {
  if (String(order.cancelledBy || '').trim().toLowerCase() === 'customer') {
    return {
      key: 'rejected' as const,
      label: '您已取消訂單',
      hint: isOrderRefunded(order) ? '此訂單由您取消，款項已退款。' : '此訂單由您自行取消。',
    };
  }
  if (isOrderCancelled(order) || (isOrderTerminal(order) && !isOrderRejected(order))) {
    return {
      key: 'rejected' as const,
      label: '訂單已取消',
      hint: isOrderRefunded(order) ? '此訂單已取消，款項已退款。' : '此訂單已取消。',
    };
  }
  if (isOrderRejected(order)) {
    return {
      key: 'rejected' as const,
      label: '店家無法接單',
      hint: isOrderRefunded(order) ? '店家無法接單，款項已退款。' : '若已付款，退款會依付款服務流程處理。',
    };
  }
  const status = order.status || '';
  if (['completed', '已完成'].includes(status)) return { key: 'completed' as const, label: '訂單已完成', hint: '謝謝你的光臨，期待下次見。' };
  if (['ready', '可取餐'].includes(status)) return { key: 'ready' as const, label: '可以取餐', hint: '請依取餐編號到店取餐；如需取消，請洽客服人員。' };
  if (['preparing', '製作中'].includes(status)) return { key: 'preparing' as const, label: '製作中', hint: '店家正在為你準備冰淇淋；如需取消，請洽客服人員。' };
  if (['accepted', '接單'].includes(status)) return { key: 'accepted' as const, label: '店家已接單', hint: '訂單已進入製作流程；如需取消，請洽客服人員。' };
  return { key: 'waiting' as const, label: '等待店家接單', hint: '訂單已送出，店家確認後會立即更新。' };
}

function OrderStatusTimeline({ order }: { order: Order }) {
  const meta = getStatusMeta(order);
  if (meta.key === 'rejected') {
    return <div className={styles.statusNoticeRejected}><span className={styles.statusNoticeIcon}>!</span><div><strong>{meta.label}</strong><p>{meta.hint}</p></div></div>;
  }
  const currentIndex = meta.key === 'completed' ? statusSteps.length : statusSteps.findIndex((step) => step.key === meta.key);
  return (
    <div className={`${styles.statusPanel} ${meta.key === 'ready' ? styles.statusPanelReady : ''}`}>
      <div className={styles.statusPanelHeader}><div><span className={styles.statusEyebrow}>ORDER STATUS · 即時更新</span><strong>{meta.label}</strong></div><span className={styles.liveStatusDot} aria-label="即時同步中" /></div>
      <p className={styles.statusHint}>{meta.hint}</p>
      <div className={styles.statusTimeline} aria-label="訂單進度">
        {statusSteps.map((step, index) => {
          const isDone = index <= currentIndex;
          const isCurrent = index === currentIndex && meta.key !== 'completed';
          return <div key={step.key} className={`${styles.statusStep} ${isDone ? styles.statusStepDone : ''} ${isCurrent ? styles.statusStepCurrent : ''}`}><span className={styles.statusStepIcon}>{isDone ? '✓' : step.icon}</span><span>{step.label}</span>{index < statusSteps.length - 1 && <i className={isDone && index < currentIndex ? styles.statusConnectorDone : ''} />}</div>;
        })}
      </div>
      {meta.key === 'ready' && <div className={styles.pickupAlert}><span>✦</span><div><b>取餐提醒</b><small>請向店員出示取餐編號</small></div></div>}
    </div>
  );
}

function formatOrderDate(order: Order) {
  const rawDate = order.time || order.date;
  if (!rawDate) return '日期未提供';
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return order.date || rawDate;
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatOrderItems(items?: OrderItem[]) {
  if (!items?.length) return ['品項明細請洽店家確認'];
  return items.map((item) => {
    const quantity = item.qty && item.qty > 1 ? ` × ${item.qty}` : '';
    const flavor = item.flavorDisplay ? ` · ${item.flavorDisplay}` : '';
    return `${item.name || '冰淇淋品項'}${quantity}${flavor}`;
  });
}

type OrderHistoryFilter = 'all' | 'processing' | 'completed' | 'cancelled';

function matchesOrderHistoryFilter(order: Order, filter: OrderHistoryFilter): boolean {
  if (filter === 'all') return true;
  const status = `${String(order.status || '')} ${getOrderStatus(order)}`.toLowerCase();
  if (filter === 'cancelled') return /(取消|拒絕|作廢|退款|cancel|reject|void)/.test(status);
  if (filter === 'completed') return /(完成|已取餐|completed|picked|done)/.test(status);
  return !matchesOrderHistoryFilter(order, 'cancelled') && !matchesOrderHistoryFilter(order, 'completed');
}

// ====== 列表用：精簡的可點擊卡片 ======
function OrderListItem({ order, onSelect }: { order: Order; onSelect: () => void }) {
  const items = formatOrderItems(order.items);
  const previewText = items.length > 1 ? `${items[0]} 等 ${items.length} 項` : items[0];
  const cancelled = isOrderTerminal(order);
  return (
    <button type="button" className={styles.orderListItem} onClick={onSelect} aria-label={`查看訂單 ${getOrderKey(order)}`}>
      <div className={styles.orderTopline}>
        <span className={styles.orderLabel}>{formatOrderDate(order)}</span>
        <span className={`${styles.orderStatus} ${cancelled ? styles.orderStatusCancelled : ''}`}>{getOrderStatus(order)}</span>
      </div>
      <div className={styles.orderListMain}>
        <div className={styles.orderListInfo}>
          <h3>取餐編號：{order.pickupCode ?? order.pickupNumber ?? order.pickupNo ?? order.displayNo ?? '待分配'}</h3>
          <p className={styles.orderListPreview}>{previewText}</p>
        </div>
        <strong className={styles.orderListTotal}>${order.total ?? 0}</strong>
      </div>
      <div className={styles.orderListFooter}>
        <span className={styles.paymentBadge}>{getPaymentStatus(order)}</span>
        <span className={styles.orderListArrow}>查看詳情 ›</span>
      </div>
    </button>
  );
}

// ====== 單張訂單詳情頁 ======
function OrderDetailCard({
  order,
  payingOrderNo,
  onPay,
  cancellingOrderNo,
  onCancel,
}: {
  order: Order;
  payingOrderNo: string | number | null;
  onPay: (order: Order) => void;
  cancellingOrderNo: string | number | null;
  onCancel: (order: Order) => void;
}) {
  const paymentStatus = getPaymentStatus(order);
  const isOnsitePayment = order.payment === '現場付款';
  const canPay = LINE_PAY_ENABLED && !isOrderTerminal(order) && !isOnsitePayment && ['尚未付款', '付款失敗', '付款處理中'].includes(paymentStatus);
  const cancelled = isOrderTerminal(order);
  const waitingForShop = isWaitingForShop(order);
  const paymentNeedsSupport = ['已付款', '付款處理中'].includes(paymentStatus);
  const pointsReversalNeedsRetry = needsOrderRecoveryRetry(order);

  return (
    <article className={styles.orderDetailCard}>
      <div className={styles.orderTopline}>
        <span className={styles.orderLabel}>ORDER · {formatOrderDate(order)}</span>
        <span className={`${styles.orderStatus} ${cancelled ? styles.orderStatusCancelled : ''}`}>{getOrderStatus(order)}</span>
      </div>

      <OrderStatusTimeline order={order} />

      <div className={styles.orderMain}>
        <div>
          <h3>取餐編號：{order.pickupCode ?? order.pickupNumber ?? order.pickupNo ?? order.displayNo ?? '待分配'}</h3>
          <p className={styles.onlineOrderNo}>線上訂單編號：{order.orderNo ?? '—'}</p>
          <p className={styles.pickupText}>{order.remark || '取餐時間未指定'}</p>
        </div>
        <strong>${order.total ?? 0}</strong>
      </div>

      <div className={styles.orderDetails}>
        <span className={styles.detailLabel}>品項明細</span>
        <ul>
          {formatOrderItems(order.items).map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{item}</li>
          ))}
        </ul>
      </div>

      <div className={styles.paymentRow}>
        <span>{isOnsitePayment ? '現場付款' : 'LINE Pay'} <b>{isOnsitePayment && paymentStatus === '尚未付款' ? '到店付款' : paymentStatus}</b></span>
        {canPay && (
          <button
            className={styles.linePayButton}
            onClick={() => onPay(order)}
            disabled={payingOrderNo === order.orderNo}
          >
            {payingOrderNo === order.orderNo ? '前往付款中…' : ['付款失敗', '付款處理中'].includes(paymentStatus) ? '重新付款' : '使用 LINE Pay'}
          </button>
        )}
      </div>
      {payingOrderNo === order.orderNo && (
        <p className={styles.paymentProcessingNotice} role="status" aria-live="polite">
          正在準備 LINE Pay 付款，請稍候；請勿重複點擊或關閉頁面。
        </p>
      )}
      {waitingForShop && !paymentNeedsSupport && order.orderNo && (
        <button
          type="button"
          className={styles.cancelOrderButton}
          onClick={() => onCancel(order)}
          disabled={cancellingOrderNo === order.orderNo}
        >
          {cancellingOrderNo === order.orderNo ? '取消處理中…' : '取消此訂單'}
        </button>
      )}
      {waitingForShop && paymentNeedsSupport && (
        <p className={styles.cancelOrderNotice}>此訂單{paymentStatus}，如需取消請洽客服人員協助。</p>
      )}
      {pointsReversalNeedsRetry && order.orderNo && (
        <>
          <p className={styles.cancelOrderNotice}>{order.refundStatus === 'failed' ? '訂單已取消，但退款或點數回收尚未完成。系統會自動補回點數；退款若仍失敗，可手動重試或聯絡客服。' : order.refundStatus === 'pending' ? 'LINE Pay 退款仍在處理中；系統會自動核對並回收點數。' : '系統會自動核對並回收此筆已取消訂單的點數；若尚未完成，也可手動重試。'}</p>
          <button
            type="button"
            className={styles.cancelOrderButton}
            onClick={() => onCancel(order)}
            disabled={cancellingOrderNo === order.orderNo}
          >
            {cancellingOrderNo === order.orderNo ? '處理中…' : ['failed', 'pending'].includes(String(order.refundStatus || '').toLowerCase()) ? '重試退款與點數回收' : '重試點數回收'}
          </button>
        </>
      )}
      {String(order.refundStatus || '').toLowerCase() === 'pending' && !pointsReversalNeedsRetry && (
        <p className={styles.cancelOrderNotice}>LINE Pay 款項退款仍在處理中，請稍後確認；若長時間未更新，請洽客服。</p>
      )}
    </article>
  );
}

const LINE_PAY_ENABLED = true;

const firebaseConfig = {
  apiKey: 'AIzaSyDvzZKr2x3TGeOFZGisKKXjbYH00DLVhKg',
  authDomain: 'omg-menu-5761a.firebaseapp.com',
  databaseURL: 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'omg-menu-5761a',
  storageBucket: 'omg-menu-5761a.firebasestorage.app',
  messagingSenderId: '193209930119',
  appId: '1:193209930119:web:d9216165be9ef6c0bcc322',
};

function getGelatoDatabase() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getDatabase(app);
}

export default function Home() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState('正在初始化...');
  const [activeTab, setActiveTab] = useState<'home' | 'menu' | 'orders' | 'member'>(() => {
    if (typeof window === 'undefined') return 'home';
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    return requestedTab === 'menu' || requestedTab === 'orders' || requestedTab === 'member' ? requestedTab : 'home';
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderHistoryFilter, setOrderHistoryFilter] = useState<OrderHistoryFilter>('all');
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [wishText, setWishText] = useState('');
  const [isSubmittingWish, setIsSubmittingWish] = useState(false);
  const [payingOrderNo, setPayingOrderNo] = useState<string | number | null>(null);
  const [cancellingOrderNo, setCancellingOrderNo] = useState<string | number | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null); // 目前檢視的單張訂單
  const autoPayStarted = useRef(false);
  const [memberDialog, setMemberDialog] = useState<MemberDialog | null>(null);
  const dialogOpen = memberDialog !== null;
  const memberDialogRef = useRef<HTMLDivElement>(null);
  const memberDialogCloseRef = useRef<HTMLButtonElement>(null);
  const voucherQrRequestIdRef = useRef(0);
  const [businessHours, setBusinessHours] = useState<BusinessHours | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [qrClock, setQrClock] = useState(() => Date.now());
  const [memberPoints, setMemberPoints] = useState<MemberPointsAccount>({ balance: 0, entries: {} });
  const [rewardActionType, setRewardActionType] = useState<MemberRewardType | null>(null);
  const [rewardQrByVoucher, setRewardQrByVoucher] = useState<Record<string, { dataUrl: string; expiresAt: number }>>({});
  const [rewardQrLoadingVoucherId, setRewardQrLoadingVoucherId] = useState<string | null>(null);
  const rewardIdempotencyKeysRef = useRef(new Map<MemberRewardType, string>());
  const [pointCampaign, setPointCampaign] = useState<PointCampaign | null>(null);
  const [lineFriendStatus, setLineFriendStatus] = useState<LineFriendStatus>('checking');
  const ordersRef = useRef<Order[]>([]);
  const pointsRecoveryAttemptAtRef = useRef(new Map<string, number>());
  const pointsRecoveryInFlightRef = useRef(new Set<string>());

  const [todayContent] = useState(() => dailyData[new Date().getDay()]);
  const isQrDialogOpen = memberDialog?.kind === 'voucher-qr';
  const closeMemberDialog = useCallback(() => {
    if (isSubmittingWish || rewardActionType) return;
    voucherQrRequestIdRef.current += 1;
    setRewardQrLoadingVoucherId(null);
    setMemberDialog(null);
  }, [isSubmittingWish, rewardActionType]);

  useEffect(() => {
    let cancelled = false;
    const initLiff = async () => {
      setStatus('正在初始化...');
      try {
        await Promise.race([
          liff.init({ liffId: '2011536222-v4OvTSup' }),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('連線逾時，請確認網路後重試')), 10000)),
        ]);
        if (!liff.isLoggedIn()) {
          if (!cancelled) setStatus('請從 LINE 開啟此頁面以完成登入');
          liff.login({ redirectUri: `${window.location.origin}/` });
          return;
        }
        if (cancelled) return;
        setStatus('載入中...');
        const p = await liff.getProfile();
        if (cancelled) return;
        let memberNo = '';
        try {
          const accessToken = liff.getAccessToken();
          if (accessToken) {
            const response = await fetch('/api/member/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }), cache: 'no-store' });
            const result = await response.json().catch(() => ({}));
            if (response.ok && result.success && result.profile?.memberNo) memberNo = String(result.profile.memberNo);
          }
        } catch (profileError) {
          console.warn('會員編號同步失敗，稍後會自動重試：', profileError);
        }
        if (cancelled) return;
        setProfile({ ...p, memberNo });
        setStatus('');
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : '未知錯誤';
        setStatus(message);
      }
    };
    initLiff();
    return () => { cancelled = true; };
  }, [initAttempt]);

  useEffect(() => {
    if (!profile?.userId) return;
    let cancelled = false;
    let refreshInProgress = false;
    const refreshFriendship = async () => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      try {
        const friendship = await liff.getFriendship();
        if (!cancelled) setLineFriendStatus(friendship.friendFlag ? 'friend' : 'not-friend');
      } catch (error) {
        console.warn('LINE 官方帳號好友狀態無法確認：', error);
        if (!cancelled) setLineFriendStatus('unavailable');
      } finally {
        refreshInProgress = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshFriendship();
    };
    void refreshFriendship();
    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [profile?.userId, initAttempt]);

  useEffect(() => {
    if (!profile?.userId) return;
    let cancelled = false;
    let refreshInProgress = false;
    const readOrders = async (accessToken: string) => {
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }), cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || '訂單同步失敗');
      return (result.orders || []) as Order[];
    };
    const refreshOrders = async () => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      try {
        const accessToken = liff.getAccessToken();
        if (!accessToken) return;
        const nextOrders = await readOrders(accessToken);
        if (cancelled) return;
        setOrders(nextOrders.filter(isRecentOrder));

        const now = Date.now();
        const recoveryCandidates = nextOrders.filter((order) => {
          const orderNo = String(order.orderNo || '').trim();
          const orderId = String(order.id || '').trim();
          const recoveryKey = orderId || orderNo;
          const reversalStatus = String(order.pointsReversalStatus || '').toLowerCase();
          if (!orderNo || !orderId || !isOrderTerminal(order) || ['reversed', 'not_required'].includes(reversalStatus)
            || pointsRecoveryInFlightRef.current.has(recoveryKey)) return false;
          return now - (pointsRecoveryAttemptAtRef.current.get(recoveryKey) || 0) >= ORDER_POINTS_RECOVERY_COOLDOWN_MS;
        }).slice(0, 5);

        if (recoveryCandidates.length) {
          for (const order of recoveryCandidates) {
            const orderNo = String(order.orderNo);
            const orderId = String(order.id || '');
            const recoveryKey = orderId || orderNo;
            pointsRecoveryAttemptAtRef.current.set(recoveryKey, Date.now());
            pointsRecoveryInFlightRef.current.add(recoveryKey);
            try {
              const recoveryResponse = await fetch('/api/member/points/reverse-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderNo, orderId, accessToken }),
                cache: 'no-store',
              });
              const recoveryResult = await recoveryResponse.json().catch(() => ({}));
              if (!recoveryResponse.ok || !recoveryResult.success) {
                throw new Error(recoveryResult.error || '點數回收尚未完成');
              }
            } catch (error) {
              console.error('訂單點數自動回收未完成:', error);
            } finally {
              pointsRecoveryInFlightRef.current.delete(recoveryKey);
            }
          }

          if (cancelled) return;
          setOrders((await readOrders(accessToken)).filter(isRecentOrder));
          try {
            const pointsResponse = await fetch('/api/member/points', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accessToken }),
              cache: 'no-store',
            });
            const pointsResult = await pointsResponse.json().catch(() => ({}));
            if (!cancelled && pointsResponse.ok && pointsResult.success) {
              setMemberPoints(pointsResult.points || { balance: 0, entries: {} });
            }
          } catch (error) {
            console.error('自動回收後會員點數同步失敗:', error);
          }
        }
      } catch (error) {
        console.error('訂單同步失敗:', error);
      } finally {
        refreshInProgress = false;
      }
    };
    void refreshOrders();
    const timer = window.setInterval(refreshOrders, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [profile?.userId]);

  useEffect(() => {
    if (!profile?.userId) return;
    let cancelled = false;
    const refreshPoints = async () => {
      try {
        const accessToken = liff.getAccessToken();
        if (!accessToken) return;
        const response = await fetch('/api/member/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }), cache: 'no-store' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.error || '會員點數同步失敗');
        if (!cancelled) setMemberPoints(result.points || { balance: 0, entries: {} });
      } catch (error) {
        console.error('會員點數同步失敗:', error);
      }
    };
    void refreshPoints();
    const timer = window.setInterval(refreshPoints, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [profile?.userId]);

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    if (!dialogOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => {
      if (memberDialogCloseRef.current?.disabled) memberDialogRef.current?.focus();
      else memberDialogCloseRef.current?.focus();
    });
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMemberDialog();
        return;
      }
      if (event.key !== 'Tab' || !memberDialogRef.current) return;
      const focusable = Array.from(memberDialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleDialogKeyDown);
      previouslyFocused?.focus();
    };
  }, [dialogOpen, closeMemberDialog]);

  useEffect(() => {
    if (!isQrDialogOpen) return;
    const updateQrClock = () => setQrClock(Date.now());
    updateQrClock();
    const timer = window.setInterval(updateQrClock, 1000);
    return () => window.clearInterval(timer);
  }, [isQrDialogOpen]);

  useEffect(() => {
    return onValue(ref(getGelatoDatabase(), 'businessHours'), (snapshot) => {
      setBusinessHours((snapshot.val() as BusinessHours | null) ?? null);
    }, (error) => {
      console.error('營業時間同步失敗:', error);
    });
  }, []);

  useEffect(() => {
    return onValue(ref(getGelatoDatabase(), 'pointCampaigns'), (snapshot) => {
      const today = new Date().toISOString().slice(0, 10);
      const campaigns = snapshot.val() as Record<string, PointCampaign> | null;
      const active = Object.entries(campaigns || {})
        .map(([id, campaign]) => ({ id, ...(campaign || {}) }))
        .find((campaign) => campaign.active !== false && (!campaign.date || campaign.date === today));
      setPointCampaign(active || null);
    }, (error) => {
      console.error('點數公告同步失敗:', error);
      setPointCampaign(null);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const shopStatus = getShopStatus(businessHours, new Date(clock));

  const loadOrders = async () => {
    if (!profile?.userId) return;
    setIsLoadingOrders(true);
    try {
      const accessToken = liff.getAccessToken();
      if (!accessToken) throw new Error('LINE 登入已失效');
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }), cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || '訂單查詢失敗');
      setOrders((result.orders || []).filter((order: Order) => isRecentOrder(order)));
    } catch (err) {
      console.error(err);
      alert('查詢失敗，請稍後再試');
    } finally {
      setIsLoadingOrders(false);
    }
  };

  const submitWish = async () => {
    if (!wishText.trim() || !profile) return;
    const submittedWish = wishText.trim();
    setIsSubmittingWish(true);
    try {
      const accessToken = liff.getAccessToken();
      const response = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, wishText: submittedWish }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || '許願失敗');
      setWishText((current) => current.trim() === submittedWish ? '' : current);
      setMemberDialog({ kind: 'notice', title: '願望收到', message: '謝謝你的口味提案，我們已記錄下來！', tone: 'success' });
    } catch (err) {
      console.error('許願失敗:', err);
      setMemberDialog({ kind: 'notice', title: '送出失敗', message: err instanceof Error ? err.message : '許願失敗，請稍後再試。', tone: 'error' });
    } finally {
      setIsSubmittingWish(false);
    }
  };

  const issueRewardVoucher = async (reward: (typeof MEMBER_REWARD_OPTIONS)[number]) => {
    const { type: rewardType, title, pointsCost } = reward;
    if (!profile?.userId || rewardActionType) return;
    if (pointsBalance < pointsCost) {
      setMemberDialog({ kind: 'notice', title: '點數不足', message: `兌換「${title}」需要 ${pointsCost} 點，請累積足夠點數後再試。`, tone: 'info' });
      return;
    }
    const idempotencyKey = rewardIdempotencyKeysRef.current.get(rewardType) || window.crypto.randomUUID();
    rewardIdempotencyKeysRef.current.set(rewardType, idempotencyKey);
    setRewardActionType(rewardType);
    try {
      const accessToken = liff.getAccessToken();
      if (!accessToken) throw new Error('LINE 登入已失效，請重新開啟會員頁');
      const response = await fetch('/api/member/rewards/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, rewardType, idempotencyKey }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || '兌換券建立失敗，請稍後重試');
      rewardIdempotencyKeysRef.current.delete(rewardType);
      setMemberPoints(result.points || { balance: 0, entries: {}, rewardVouchers: {} });
      const message = result.alreadyProcessed ? '兌換券已建立；點數不會重複扣除。' : `已扣除 ${pointsCost} 點，「${title}」已放入「我的兌換券」，永久有效。`;
      setMemberDialog({ kind: 'notice', title: '兌換成功', message, tone: 'success' });
    } catch (error) {
      console.error('建立兌換券失敗:', error);
      const message = error instanceof Error ? error.message : '兌換券建立失敗，請稍後重試。';
      setMemberDialog({ kind: 'notice', title: '兌換未完成', message, tone: 'error' });
    } finally {
      setRewardActionType(null);
    }
  };

  const showRewardVoucherQr = async (voucherId: string) => {
    setMemberDialog({ kind: 'voucher-qr', voucherId });
    if (rewardQrLoadingVoucherId) return;
    const requestId = ++voucherQrRequestIdRef.current;
    setRewardQrByVoucher((current) => {
      const next = { ...current };
      delete next[voucherId];
      return next;
    });
    setRewardQrLoadingVoucherId(voucherId);
    try {
      const accessToken = liff.getAccessToken();
      if (!accessToken) throw new Error('LINE 登入已失效，請重新開啟會員頁');
      const response = await fetch('/api/member/rewards/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, voucherId }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success || typeof result.token !== 'string') throw new Error(result.error || '兌換券條碼產生失敗');
      const dataUrl = await QRCode.toDataURL(result.token, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#2d1f14', light: '#fffdf9' } });
      if (requestId !== voucherQrRequestIdRef.current) return;
      setRewardQrByVoucher((current) => ({ ...current, [voucherId]: { dataUrl, expiresAt: Number(result.expiresAt) } }));
    } catch (error) {
      if (requestId !== voucherQrRequestIdRef.current) return;
      console.error('兌換券條碼產生失敗:', error);
      setMemberDialog({ kind: 'notice', title: '條碼暫時無法載入', message: error instanceof Error ? error.message : '兌換券條碼產生失敗，請稍後再試。', tone: 'error' });
    } finally {
      if (requestId === voucherQrRequestIdRef.current) setRewardQrLoadingVoucherId(null);
    }
  };


  const switchTab = (tab: 'home' | 'menu' | 'orders' | 'member') => {
    if (tab === 'menu') {
      window.location.replace('/menu/index.html');
      return;
    }
    setActiveTab(tab);
    setSelectedOrderNo(null); // 切換分頁時回到訂單列表
    if (tab === 'orders') loadOrders();
    router.replace(tab === 'home' ? '/' : `/?tab=${tab}`, { scroll: false });
  };

  const openMenu = () => {
    window.location.replace('/menu/index.html');
  };

  const retryLiff = () => {
    setProfile(null);
    setInitAttempt((attempt) => attempt + 1);
  };

  const startLinePay = async (order: Order) => {
    if (!LINE_PAY_ENABLED || !order.orderNo || !profile?.userId || payingOrderNo) return;
    setPayingOrderNo(order.orderNo);
    try {
      const response = await fetch('/api/linepay/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: profile.userId,
          displayName: profile.displayName,
          orderNo: order.orderNo,
          amount: Number(order.total || 0),
          items: order.items || [],
          remark: order.remark || '',
        }),
      });
      const result = await response.json().catch(() => ({}));
      const paymentUrls = result.info?.paymentUrl || result.paymentUrl || {};
      const appPaymentUrl = result.appPaymentUrl || paymentUrls.app;
      const webPaymentUrl = result.webPaymentUrl || paymentUrls.web;
      const fallbackPaymentUrl = result.paymentUrl || appPaymentUrl || webPaymentUrl;
      if (!response.ok || (!appPaymentUrl && !webPaymentUrl && !fallbackPaymentUrl)) {
        throw new Error(result.error || 'LINE Pay 付款服務尚未完成設定');
      }
      const paymentUrl = liff.isInClient()
        ? appPaymentUrl || webPaymentUrl || fallbackPaymentUrl
        : webPaymentUrl || appPaymentUrl || fallbackPaymentUrl;
      if (liff.isInClient() && typeof liff.openWindow === 'function') {
        liff.openWindow({ url: paymentUrl, external: true });
      } else {
        window.location.assign(paymentUrl);
      }
    } catch (err) {
      console.error('LINE Pay 付款請求失敗:', err);
      alert(err instanceof Error ? err.message : 'LINE Pay 付款失敗，請稍後再試');
      setPayingOrderNo(null);
    }
  };

  const cancelOrder = async (order: Order) => {
    const recoveryRetry = needsOrderRecoveryRetry(order);
    if (!order.orderNo || (!isWaitingForShop(order) && !recoveryRetry) || cancellingOrderNo) return;
    const confirmation = recoveryRetry
      ? '要重新處理這筆訂單的退款與點數回收嗎？'
      : '確定要取消這筆尚未接單的訂單嗎？取消後無法復原。';
    if (!window.confirm(confirmation)) return;
    setCancellingOrderNo(order.orderNo);
    try {
      const accessToken = liff.getAccessToken();
      if (!accessToken) throw new Error('無法取得 LINE 登入驗證，請重新開啟此頁面');
      const response = await fetch('/api/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo: order.orderNo, orderId: order.id, accessToken }),
      });
      const result = await response.json().catch((): { success?: boolean; error?: string; refunded?: boolean; refundPending?: boolean; pointsReversalPending?: boolean } => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || '取消訂單失敗，請稍後再試');
      }
      if (result.pointsReversalPending) {
        alert(result.refundPending ? '訂單已取消，但點數回收與 LINE Pay 退款仍待處理；請稍後重試。' : '訂單已取消，但點數回收仍待處理；請稍後到訂單詳情重試。');
      } else if (result.refundPending) {
        alert('點數回收已完成，但 LINE Pay 款項退款仍在處理中；稍後可安全重試。');
      } else if (recoveryRetry) {
        alert(result.refunded ? 'LINE Pay 退款與點數回收已完成。' : '點數回收已完成，會員點數已更新。');
      } else {
        alert(result.refunded ? '訂單已取消，LINE Pay 款項已自動退款。' : '訂單已取消。');
      }
      await loadOrders();
      const pointsResponse = await fetch('/api/member/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
        cache: 'no-store',
      });
      const pointsResult = await pointsResponse.json().catch(() => ({}));
      if (pointsResponse.ok && pointsResult.success) setMemberPoints(pointsResult.points || { balance: 0, entries: {} });
    } catch (error) {
      console.error('取消訂單失敗:', error);
      alert(error instanceof Error ? error.message : '取消訂單失敗，請稍後再試');
    } finally {
      setCancellingOrderNo(null);
    }
  };

  const handleOrderReturn = useEffectEvent((targetOrder: Order, action: string | null) => {
    startTransition(() => {
      setActiveTab('orders');
      setSelectedOrderNo(getOrderKey(targetOrder)); // 直接跳到該張訂單
    });
    if (LINE_PAY_ENABLED && action === 'pay' && !autoPayStarted.current && ['尚未付款', '付款失敗', '付款處理中'].includes(getPaymentStatus(targetOrder))) {
      autoPayStarted.current = true;
      void startLinePay(targetOrder);
    }
  });

  useEffect(() => {
    if (!profile?.userId || !orders.length) return;
    const params = new URLSearchParams(window.location.search);
    const orderNo = params.get('orderNo');
    const action = params.get('action');
    if (!orderNo) return;
    const targetOrder = orders.find((order) => String(order.orderNo) === orderNo);
    if (!targetOrder) return;
    handleOrderReturn(targetOrder, action);
  }, [profile?.userId, orders]);

  useEffect(() => {
    const handleEmbeddedPaymentStart = (event: MessageEvent<{ type?: string; orderNo?: string }>) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'OMG_LINEPAY_START' || !event.data.orderNo) return;
      const orderNo = event.data.orderNo;
      setActiveTab('orders');
      setSelectedOrderNo(orderNo);
      let attempts = 0;
      const startWhenOrderIsReady = () => {
        const targetOrder = ordersRef.current.find((order) => String(order.orderNo) === orderNo);
        if (targetOrder) {
          void startLinePay(targetOrder);
          return;
        }
        if (attempts++ < 12) window.setTimeout(startWhenOrderIsReady, 250);
      };
      startWhenOrderIsReady();
    };
    window.addEventListener('message', handleEmbeddedPaymentStart);
    return () => window.removeEventListener('message', handleEmbeddedPaymentStart);
  }, [orders, startLinePay]);

  if (!profile && (status.includes('正在初始化') || status === '載入中...')) {
    return (
      <main className={styles.loadingScreen}>
        <div className={styles.loadingLogo}><Image src="/logo-new.png" alt="On My Gelato" width={57} height={57} /></div>
        <span className={styles.loadingDot} />
        <p>正在準備今天的冰淇淋</p>
      </main>
    );
  }

  if (!profile && status) {
    return (
      <main className={styles.loadingScreen}>
        <div className={styles.loadingLogo}><Image src="/logo-new.png" alt="On My Gelato" width={57} height={57} /></div>
        <div className={styles.initErrorCard}>
          <p className={styles.initErrorKicker}>PLEASE TRY AGAIN</p>
          <h1>頁面暫時無法載入</h1>
          <p>{status}</p>
          <button type="button" className={styles.retryButton} onClick={retryLiff}>重新載入</button>
          <button type="button" className={styles.reloadButton} onClick={() => window.location.reload()}>重新整理頁面</button>
        </div>
      </main>
    );
  }

  const selectedOrder = selectedOrderNo
    ? orders.find((order) => getOrderKey(order) === selectedOrderNo) ?? null
    : null;
  const filteredOrders = orders.filter((order) => matchesOrderHistoryFilter(order, orderHistoryFilter));
  const orderFilterCounts = {
    all: orders.length,
    processing: orders.filter((order) => matchesOrderHistoryFilter(order, 'processing')).length,
    completed: orders.filter((order) => matchesOrderHistoryFilter(order, 'completed')).length,
    cancelled: orders.filter((order) => matchesOrderHistoryFilter(order, 'cancelled')).length,
  };
  const pointsBalance = Math.max(0, Number(memberPoints.balance || 0));
  const recentPointEntries = Object.entries(memberPoints.entries || {})
    .sort(([, a], [, b]) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const memberRewardVouchers = Object.entries(memberPoints.rewardVouchers || {})
    .sort(([, a], [, b]) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
  const visiblePointEntries = recentPointEntries.slice(0, 3);
  const dialogVoucherId = memberDialog?.kind === 'voucher-qr' ? memberDialog.voucherId : null;
  const dialogVoucher = dialogVoucherId ? memberRewardVouchers.find(([id]) => id === dialogVoucherId)?.[1] : null;
  const dialogVoucherQr = dialogVoucherId ? rewardQrByVoucher[dialogVoucherId] : null;
  const dialogVoucherQrExpired = !dialogVoucherQr || dialogVoucherQr.expiresAt <= qrClock;
  const pageTitle = activeTab === 'menu' ? '線上點餐' : activeTab === 'orders' ? (selectedOrder ? '訂單詳情' : '訂單足跡') : activeTab === 'member' ? '會員與點數' : '今日首頁';

  return (
    <main className={styles.appShell}>
      <header className={styles.topbar}>
        <div className={styles.brandLockup}>
          <p className={styles.pageEyebrow}>ON MY GELATO · CLUB</p>
          <p className={styles.pageTitle}>{pageTitle}</p>
        </div>
        <div className={`${styles.livePill} ${shopStatus.isOpen ? '' : styles.livePillClosed}`}><i /> {shopStatus.label}</div>
      </header>

      <section className={styles.content}>
        {status && !profile && <div className={styles.errorBanner}>{status}</div>}

        {activeTab === 'home' && (
          <div className={styles.homeView}>
            <section className={styles.appHero}>
              <div className={styles.appHeroGlow} />
              <div className={styles.appHeroTop}><span className={styles.heroTag}>TODAY&apos;S SCOOP</span><span className={styles.heroDate}>{new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(clock))}</span></div>
              <p className={styles.appHeroKicker}>{shopStatus.isOpen ? '今天，值得一球好冰淇淋' : shopStatus.label}</p>
              <h1>{todayContent.title}</h1>
              <p className={styles.appHeroDescription}>{todayContent.desc}</p>
              <button type="button" className={styles.heroOrderButton} onClick={openMenu}><span>探索今日口味</span><b>↗</b></button>
              <div className={styles.heroScoopArt} aria-hidden="true"><span className={styles.heroScoopOne} /><span className={styles.heroScoopTwo} /><span className={styles.heroScoopThree} /><i /></div>
            </section>

            {!shopStatus.isOpen && <div className={styles.closedNotice}><b>{shopStatus.label}</b><span>{shopStatus.detail}</span></div>}

            <section className={styles.homeWelcomeCard}>
              <div className={styles.homeWelcomeAvatar}>{profile?.pictureUrl ? <Image src={profile.pictureUrl} alt="會員頭像" width={46} height={46} /> : <span>OG</span>}</div>
              <div><p className={styles.kicker}>WELCOME BACK</p><h2>{profile?.displayName || 'Gelato Lover'}</h2><span>今天也為自己留一點甜。</span></div>
              <button type="button" onClick={() => switchTab('member')} aria-label="開啟會員中心">↗</button>
            </section>

            <div className={styles.homeSectionLabel}><div><p className={styles.kicker}>YOUR SHORTCUTS</p><h2>現在想做什麼？</h2></div><span>Swipe less · enjoy more</span></div>
            <section className={styles.homeActionGrid}>
                <button type="button" className={`${styles.homeActionCard} ${styles.homeActionPrimary}`} onClick={openMenu}><span className={styles.actionCardIcon}>✦</span><div><b>開始選購</b><small>購物車應該都裝得下</small></div><strong>›</strong></button>
              <button type="button" className={styles.homeActionCard} onClick={() => switchTab('orders')}><span className={styles.actionCardIcon}>◷</span><div><b>追蹤訂單</b><small>{orders.length ? `共 ${orders.length} 筆紀錄` : '查看取餐進度'}</small></div><strong>›</strong></button>
            </section>

            <section className={styles.homeFeatureCard}>
              <div><p className={styles.kicker}>GELATO NOTE</p><h2>堅持使用低脂乳<br /><em>清爽無負擔，呈現食材最純粹絲滑口感</em></h2><p>我們追求的不是甜度，而是食材本身的真實滋味</p></div><span className={styles.featureMark}>✦</span>
            </section>
          </div>
        )}

        {activeTab === 'orders' && (
          selectedOrder ? (
            <section className={styles.pageView}>
              <button type="button" className={styles.backButton} onClick={() => setSelectedOrderNo(null)}><span>‹</span> 返回訂單足跡</button>
              <OrderDetailCard order={selectedOrder} payingOrderNo={payingOrderNo} onPay={startLinePay} cancellingOrderNo={cancellingOrderNo} onCancel={cancelOrder} />
            </section>
          ) : (
            <section className={styles.ordersPageView}>
              <header className={styles.ordersHero}><div><p className={styles.kicker}>ORDER JOURNEY</p><h1>線上訂單</h1><p>查看您在線上購物的訂單</p></div><button type="button" className={styles.refreshButton} onClick={loadOrders} disabled={isLoadingOrders} aria-label="重新整理訂單">{isLoadingOrders ? '…' : '↻'}</button></header>
              <div className={styles.orderHistoryTabs} role="tablist" aria-label="訂單狀態篩選">
                {([['all', '全部'], ['processing', '進行中'], ['completed', '已完成'], ['cancelled', '已取消']] as Array<[OrderHistoryFilter, string]>).map(([filter, label]) => (
                  <button key={filter} type="button" role="tab" aria-selected={orderHistoryFilter === filter} className={`${styles.orderHistoryTab} ${orderHistoryFilter === filter ? styles.orderHistoryTabActive : ''}`} onClick={() => setOrderHistoryFilter(filter)}>
                    <span>{label}</span><em>{orderFilterCounts[filter]}</em>
                  </button>
                ))}
              </div>
              <div className={styles.orderSummaryBar}><span><b>{filteredOrders.length}</b> 筆{orderHistoryFilter === 'all' ? '歷史訂單' : '符合條件的訂單'}</span><button type="button" onClick={openMenu}>再次預訂 ↗</button></div>
              {isLoadingOrders ? <div className={styles.emptyState}><span className={styles.loadingDot} /><p>正在找回您的回憶紀錄…</p></div> : orders.length === 0 ? <div className={styles.ordersEmpty}><span>◌</span><h3>目前沒有訂單紀錄</h3><p>今天可以犒賞自己，<br />選個口味好好的享受。</p><button type="button" onClick={openMenu} className={styles.secondaryButton}>慢慢參考喜歡再下單</button></div> : filteredOrders.length === 0 ? <div className={styles.ordersEmpty}><span>⌁</span><h3>這個分類目前沒有訂單</h3><p>切換其他狀態，看看你的訂單足跡。</p><button type="button" className={styles.secondaryButton} onClick={() => setOrderHistoryFilter('all')}>查看全部訂單</button></div> : <div className={styles.orderList}>{filteredOrders.map((order, index) => <OrderListItem key={`${getOrderKey(order)}-${index}`} order={order} onSelect={() => setSelectedOrderNo(getOrderKey(order))} />)}</div>}
            </section>
          )
        )}

        {activeTab === 'member' && (
          <section className={styles.memberPageView}>
            <section className={`${styles.pointsNotice} ${pointCampaign ? styles.pointsNoticeCampaign : ''}`} aria-label="點數規則公告">
              <div className={styles.pointsNoticeHeader}>
                <div className={styles.pointsNoticeIcon}>{pointCampaign ? '!' : '✦'}</div>
                <div className={styles.pointsNoticeTitle}><div className={styles.pointsNoticeMeta}><p className={styles.kicker}>{pointCampaign ? 'POINTS UPDATE' : 'POINTS RULE'}</p><span>{pointCampaign ? '活動中' : '會員專屬'}</span></div><h2>{pointCampaign?.name || '點數公告'}</h2></div>
                <span className={styles.pointsNoticeArrow}>›</span>
              </div>
              <ul className={styles.pointsNoticeList}>
                <li><b>01</b><span>指定品項一般每件 1 點；11/11 雙11加碼僅限線上訂單，每件共 2 點，門市仍為 1 點。</span></li>
                <li><b>02</b><span>線上消費贈點由系統自動累入會員帳戶。</span></li>
                <li><b>03</b><span>當次消費累積點數，限下次消費兌換使用。</span></li>
                <li><b>04</b><span>店家保有活動、獎項修改之權利。</span></li>
              </ul>
              <small className={styles.pointsNoticeDate}>{pointCampaign?.date ? `適用日期 · ${pointCampaign.date}` : '\u00a0'}</small>
            </section>

            <section className={styles.pointsOverview} aria-label="目前OMG點數">
              <div className={styles.pointsOverviewTop}><span>目前OMG點數</span><span className={styles.pointsLive}><i />即時同步</span></div>
              <div className={styles.pointsNumber}>{pointsBalance}<small> 點</small></div>
              <div className={styles.pointsMeta}><span>會員編號：{profile?.memberNo || '建立中…'}</span><span>無使用期限</span></div>
            </section>

            <section className={styles.memberActionCard} aria-label="限門市消費集點">
              <div className={styles.actionCardHeading}><span className={styles.actionIcon}>⌁</span><div><p className={styles.kicker}>限門市消費集點</p><h2>門市會員 QR 尚未開放</h2></div></div>
              <p className={styles.actionCardDescription}>線上訂單可自動累積點數；門市會員 QR 條碼功能尚未開放，開放後會在此提供使用方式。</p>

            </section>

            <section className={styles.howToCollect} aria-label="線上集點使用步驟">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>HOW ONLINE POINTS WORK</p><h2>線上消費自動集點</h2></div><span>會員登入後由系統累入</span></div>
              <div className={styles.stepList}>
                <div className={styles.stepItem}><span>01</span><div><b>使用 LINE 開啟會員中心</b><small>登入後即可查看會員點數</small></div></div>
                <div className={styles.stepItem}><span>02</span><div><b>線上選購指定品項</b><small>獨享杯／雙重奏每件 1 點</small></div></div>
                <div className={styles.stepItem}><span>03</span><div><b>點數自動入帳</b><small>符合條件的線上訂單由系統累點</small></div></div>
              </div>
            </section>

            <section className={styles.memberHistoryCard} aria-label="最近點數紀錄">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>POINT ACTIVITY</p><h2>最近點數紀錄</h2></div><span>{recentPointEntries.length ? `最新 ${Math.min(3, recentPointEntries.length)} 筆` : '尚無紀錄'}</span></div>
              {recentPointEntries.length ? <>
                <div className={styles.pointActivityList} id="member-point-activity-list">{visiblePointEntries.map(([entryId, entry]) => <div className={styles.pointActivityItem} key={entryId}><span className={styles.activityMark}>✦</span><div><b>{entry.sourceLabel || (entry.type === 'reward_redemption' ? '獎勵兌換' : '點數異動')}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{entry.createdAt ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(new Date(entry.createdAt)) : '最近更新'}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.activityPlus : styles.activityMinus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div>
                {recentPointEntries.length > 3 && <button type="button" className={styles.pointActivityToggle} onClick={() => setMemberDialog({ kind: 'history' })}>查看全部（{recentPointEntries.length} 筆）</button>}
              </> : <div className={styles.noActivity}><span>○</span><p>完成第一次指定品項消費後<br />點數紀錄會顯示在這裡。</p></div>}
            </section>

            <section className={styles.memberRedeemCard} aria-label="點數兌換獎勵">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>REWARD MENU</p><h2>點數兌換</h2></div><span>5 點起兌</span></div>
              <p className={styles.memberRedeemIntro}>點數與兌換券皆永久有效，可自行選擇兌換完整商品券（10 點）或 5 折券（5 點）。到店出示條碼由店員核銷；折價券須由店員依券面手動折抵，核銷不會自動調整或綁定 POS 訂單。</p>
              <div className={styles.rewardChoices}>
                {MEMBER_REWARD_OPTIONS.map((reward) => <div className={styles.rewardChoice} key={reward.type}><div><b>{reward.title}</b><small>{reward.description} · <span className={styles.rewardCost}>{reward.pointsCost}</span> 點</small></div><button type="button" disabled={rewardActionType !== null || pointsBalance < reward.pointsCost} onClick={() => setMemberDialog({ kind: 'redeem-confirm', reward })}>{pointsBalance < reward.pointsCost ? '點數不足' : `${reward.pointsCost} 點兌換`}</button></div>)}
              </div>
            </section>

            <section className={styles.memberVouchersCard} aria-label="我的兌換券">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>MY VOUCHERS</p><h2>我的兌換券</h2></div><span>{memberRewardVouchers.filter(([, voucher]) => voucher.status === 'issued').length} 張可使用</span></div>
              {memberRewardVouchers.length ? <div className={styles.voucherList}>{memberRewardVouchers.map(([voucherId, voucher]) => {
                const qr = rewardQrByVoucher[voucherId];
                const qrExpired = !qr || qr.expiresAt <= qrClock;
                return <article className={styles.voucherItem} key={voucherId}>
                  <div className={styles.voucherInfo}><div><b>{voucher.title.includes('券') ? voucher.title : `${voucher.title}兌換券`}</b><span className={`${styles.voucherStatus} ${voucher.status === 'redeemed' ? styles.voucherStatusRedeemed : ''}`}>{voucher.status === 'redeemed' ? '已核銷' : '未使用'}</span></div><small>永久有效 · 兌換時已扣 {voucher.pointsCost} 點</small>{voucher.redeemedAt ? <small>核銷時間 {new Date(voucher.redeemedAt).toLocaleString('zh-TW')}</small> : null}</div>
                  {voucher.status === 'issued' && <button type="button" className={styles.voucherQrButton} disabled={rewardQrLoadingVoucherId === voucherId} onClick={() => void showRewardVoucherQr(voucherId)}>{qrExpired ? '顯示核銷條碼' : '開啟核銷條碼'}</button>}
                </article>;
              })}</div> : <div className={styles.voucherEmpty}><span>✦</span><p>還沒有兌換券<br />5 點可兌換指定品項 5 折券，10 點可兌換商品券。</p></div>}
            </section>

            <section className={`${styles.memberActionCard} ${styles.memberFriendCard}`} aria-label="LINE 官方帳號好友狀態">
              <div className={styles.actionCardHeading}><span className={styles.actionIcon}>L</span><div><p className={styles.kicker}>{lineFriendStatus === 'checking' ? 'LINE 好友狀態' : lineFriendStatus === 'friend' ? '好友狀態' : lineFriendStatus === 'not-friend' ? '好友狀態' : 'LINE 官方帳號'}</p><h2>{lineFriendStatus === 'checking' ? '正在確認好友狀態' : lineFriendStatus === 'friend' ? '已加入 OMG 官方帳號' : lineFriendStatus === 'not-friend' ? '加入 OMG 官方帳號好友' : '追蹤 OMG 最新口味'}</h2></div></div>
              <p className={styles.actionCardDescription}>{lineFriendStatus === 'checking' ? '正在同步好友狀態；也可以直接開啟官方帳號頁面。' : lineFriendStatus === 'friend' ? '你已加入好友，可在 LINE 官方帳號查看最新口味與活動。' : lineFriendStatus === 'not-friend' ? '目前尚未加入（或已封鎖）；加入或解除封鎖後即可接收最新消息。' : '目前無法自動確認好友狀態，你仍可開啟官方帳號頁面查看或加入好友。'}</p>
              <a href="https://lin.ee/sB558niE" target="_blank" rel="noopener noreferrer" className={styles.lineButton}><span>LINE</span>{lineFriendStatus === 'not-friend' ? '加入好友' : '查看 LINE 官方帳號'}<b>↗</b></a>
            </section>
            <div className={styles.wishCard}>
              <div className={styles.wishHeading}><span>✦</span><div><p className={styles.kicker}>TASTE LAB</p><h2>口味許願池</h2></div></div>
              <p>下一球，也許就是你最想吃的那一球。</p>
              <textarea value={wishText} onChange={(e) => setWishText(e.target.value)} placeholder="例如：海鹽焦糖、開心果…" />
              <button type="button" onClick={() => setMemberDialog({ kind: 'wish-confirm' })} disabled={isSubmittingWish || !wishText.trim()} className={styles.wishButton}>送出我的願望 ✦</button>
            </div>
          </section>
        )}
      </section>

      <nav className={styles.appDock} aria-label="主要導覽">
        <button type="button" onClick={() => switchTab('home')} className={activeTab === 'home' ? styles.dockActive : ''}><span>⌂</span><small>今日</small></button>
        <button type="button" onClick={openMenu} className={`${styles.dockOrderButton} ${activeTab === 'menu' ? styles.dockOrderActive : ''}`}><span>✦</span><small>點餐</small></button>
        <button type="button" onClick={() => switchTab('orders')} className={activeTab === 'orders' ? styles.dockActive : ''}><span>◷</span><small>訂單查看</small></button>
        <button type="button" onClick={() => switchTab('member')} className={activeTab === 'member' ? styles.dockActive : ''}><span>◒</span><small>OMG會員</small></button>
      </nav>

      {memberDialog && <div className={styles.memberDialogOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) closeMemberDialog(); }}>
        <section className={styles.memberDialog} ref={memberDialogRef} role="dialog" aria-modal="true" aria-labelledby="member-dialog-title" tabIndex={-1}>
          <header className={styles.memberDialogHeader}>
            <div><p className={styles.kicker}>ON MY GELATO · CLUB</p><h2 id="member-dialog-title">{memberDialog.kind === 'history' ? '點數紀錄' : memberDialog.kind === 'voucher-qr' ? (dialogVoucher?.title || '兌換券條碼') : memberDialog.kind === 'redeem-confirm' ? '確認兌換' : memberDialog.kind === 'wish-confirm' ? '送出味道許願' : memberDialog.title}</h2></div>
            <button type="button" ref={memberDialogCloseRef} className={styles.memberDialogClose} onClick={closeMemberDialog} disabled={isSubmittingWish || rewardActionType !== null} aria-label="關閉視窗">×</button>
          </header>

          <div className={styles.memberDialogBody}>
            {memberDialog.kind === 'history' && (recentPointEntries.length ? <div className={styles.dialogHistoryList}>{recentPointEntries.map(([entryId, entry]) => <div className={styles.pointActivityItem} key={entryId}><span className={styles.activityMark}>✦</span><div><b>{entry.sourceLabel || (entry.type === 'reward_redemption' ? '獎勵兌換' : '點數異動')}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{entry.createdAt ? new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(entry.createdAt)) : '最近更新'}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.activityPlus : styles.activityMinus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div> : <div className={styles.dialogEmpty}>目前還沒有點數紀錄。</div>)}

            {memberDialog.kind === 'voucher-qr' && <div className={styles.dialogQrContent}>
              {dialogVoucher && <p className={styles.dialogVoucherName}>{dialogVoucher.title.includes('券') ? dialogVoucher.title : `${dialogVoucher.title}兌換券`}</p>}
              {dialogVoucherQr?.dataUrl && !dialogVoucherQrExpired ? <Image className={styles.dialogQrImage} src={dialogVoucherQr.dataUrl} alt={`${dialogVoucher?.title || '兌換券'}核銷條碼`} width={250} height={250} unoptimized /> : <div className={styles.dialogQrPlaceholder}>{rewardQrLoadingVoucherId === dialogVoucherId ? '正在準備專屬條碼…' : '請產生一組新的核銷條碼'}</div>}
              <small>請讓店員在 POS 掃描此條碼；核銷碼 5 分鐘有效，兌換券本身永久有效。</small>
              <button type="button" className={styles.dialogPrimaryButton} onClick={() => dialogVoucherId && void showRewardVoucherQr(dialogVoucherId)} disabled={!dialogVoucherId || rewardQrLoadingVoucherId === dialogVoucherId}>{rewardQrLoadingVoucherId === dialogVoucherId ? '產生中…' : '重新產生核銷條碼'}</button>
            </div>}

            {memberDialog.kind === 'redeem-confirm' && <div className={styles.dialogConfirmContent}>
              <p>你即將兌換</p><h3>{memberDialog.reward.title}</h3>
              <div className={styles.dialogBalanceRow}><span>本次扣點</span><b>−{memberDialog.reward.pointsCost} 點</b></div>
              <div className={styles.dialogBalanceRow}><span>目前點數</span><b>{pointsBalance} 點</b></div>
              <div className={styles.dialogBalanceRow}><span>兌換後餘額</span><b>{Math.max(0, pointsBalance - memberDialog.reward.pointsCost)} 點</b></div>
              <small>送出後會立即扣點；此兌換券永久有效。</small>
              <div className={styles.dialogButtonRow}><button type="button" className={styles.dialogSecondaryButton} onClick={closeMemberDialog} disabled={rewardActionType !== null}>再想一下</button><button type="button" className={styles.dialogPrimaryButton} onClick={() => void issueRewardVoucher(memberDialog.reward)} disabled={rewardActionType !== null}>{rewardActionType ? '建立中…' : '確認兌換'}</button></div>
            </div>}

            {memberDialog.kind === 'wish-confirm' && <div className={styles.dialogConfirmContent}>
              <p>送出這個口味提案？</p><blockquote className={styles.dialogWishQuote}>{wishText.trim()}</blockquote>
              <small>送出後店家會收到你的許願內容。</small>
              <div className={styles.dialogButtonRow}><button type="button" className={styles.dialogSecondaryButton} onClick={closeMemberDialog} disabled={isSubmittingWish}>返回修改</button><button type="button" className={styles.dialogPrimaryButton} onClick={() => void submitWish()} disabled={isSubmittingWish}>{isSubmittingWish ? '送出中…' : '確認送出'}</button></div>
            </div>}

            {memberDialog.kind === 'notice' && <div className={`${styles.dialogNotice} ${memberDialog.tone === 'error' ? styles.dialogNoticeError : memberDialog.tone === 'success' ? styles.dialogNoticeSuccess : ''}`}>
              <span aria-hidden="true">{memberDialog.tone === 'error' ? '!' : memberDialog.tone === 'success' ? '✓' : '✦'}</span><p>{memberDialog.message}</p><button type="button" className={styles.dialogPrimaryButton} onClick={closeMemberDialog} disabled={isSubmittingWish || rewardActionType !== null}>知道了</button>
            </div>}
          </div>
        </section>
      </div>}
    </main>
  );
}
