'use client';

import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import liff from '@line/liff';
import QRCode from 'qrcode';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, get, equalTo, onValue, orderByChild, push, query, ref, set } from 'firebase/database';
import { getShopStatus, type BusinessHours } from '@/lib/business-hours';
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

type Profile = { userId: string; displayName: string; pictureUrl?: string };

type MemberPointsAccount = {
  balance?: number;
  updatedAt?: number;
  entries?: Record<string, { delta?: number; type?: string; sourceLabel?: string; createdAt?: number; orderNo?: string }>;
};

type Order = {
  id?: string; userId?: string;
  orderNo?: string | number; displayNo?: string | number;
  pickupCode?: string | number; pickupNo?: string | number; pickupNumber?: string | number;
  total?: string | number; remark?: string; time?: string; date?: string; createdAt?: string;
  status?: string; payment?: string; paymentStatus?: string; refundStatus?: string;
  refunded?: boolean; refundedAt?: string; refundCompletedAt?: string; paymentRefundedAt?: string;
  channel?: string; source?: string; rejected?: boolean; voided?: boolean; cancelledBy?: string;
  items?: OrderItem[];
};

type OrderItem = { name?: string; price?: number; qty?: number; flavorDisplay?: string };

function getOrderKey(order: Order) {
  return String(order.orderNo ?? order.id ?? '');
}

const ORDER_HISTORY_DAYS = 30;
const ORDER_HISTORY_MS = ORDER_HISTORY_DAYS * 24 * 60 * 60 * 1000;

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
  if (isOrderCancelled(order)) {
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

// ====== 列表用：精簡的可點擊卡片 ======
function OrderListItem({ order, onSelect }: { order: Order; onSelect: () => void }) {
  const items = formatOrderItems(order.items);
  const previewText = items.length > 1 ? `${items[0]} 等 ${items.length} 項` : items[0];
  const cancelled = isOrderCancelled(order) || isOrderRejected(order);
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
  const cancelled = isOrderCancelled(order) || isOrderRejected(order);
  const waitingForShop = isWaitingForShop(order);
  const paymentNeedsSupport = ['已付款', '付款處理中'].includes(paymentStatus);

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
  const [menuLoaded, setMenuLoaded] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tab') === 'menu');
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [wishText, setWishText] = useState('');
  const [isSubmittingWish, setIsSubmittingWish] = useState(false);
  const [wishSuccess, setWishSuccess] = useState(false);
  const [payingOrderNo, setPayingOrderNo] = useState<string | number | null>(null);
  const [cancellingOrderNo, setCancellingOrderNo] = useState<string | number | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null); // 目前檢視的單張訂單
  const autoPayStarted = useRef(false);
  const [businessHours, setBusinessHours] = useState<BusinessHours | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [memberPoints, setMemberPoints] = useState<MemberPointsAccount>({ balance: 0, entries: {} });
  const [memberQrDataUrl, setMemberQrDataUrl] = useState('');
  const [memberQrOpen, setMemberQrOpen] = useState(false);
  const ordersRef = useRef<Order[]>([]);

  const [todayContent] = useState(() => dailyData[new Date().getDay()]);

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
          liff.login();
          return;
        }
        if (cancelled) return;
        setStatus('載入中...');
        const p = await liff.getProfile();
        if (cancelled) return;
        setProfile(p);
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
    const ordersQuery = query(ref(getGelatoDatabase(), 'orders'), orderByChild('userId'), equalTo(profile.userId));
    return onValue(ordersQuery, (snapshot) => {
      const userOrders: Order[] = [];
      snapshot.forEach((child) => {
        const order = { id: child.key ?? undefined, ...(child.val() as Order) };
        if (order.userId === profile.userId && isRecentOrder(order)) userOrders.push(order);
      });
      userOrders.sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime());
      setOrders(userOrders);
    }, (error) => {
      console.error('訂單即時同步失敗:', error);
    });
  }, [profile?.userId]);

  useEffect(() => {
    if (!profile?.userId) return;
    const memberKey = `line_${profile.userId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    return onValue(ref(getGelatoDatabase(), `memberPoints/${memberKey}`), (snapshot) => {
      setMemberPoints((snapshot.val() as MemberPointsAccount | null) ?? { balance: 0, entries: {} });
    }, (error) => {
      console.error('會員點數同步失敗:', error);
    });
  }, [profile?.userId]);

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    let cancelled = false;
    const createMemberQr = async () => {
      if (!profile?.userId) {
        setMemberQrDataUrl('');
        return;
      }
      try {
        const accessToken = liff.getAccessToken();
        if (!accessToken) throw new Error('找不到 LINE 登入 Token');
        const dataUrl = await QRCode.toDataURL(`gelato-member-token:${accessToken}`, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
          color: { dark: '#2d1f14', light: '#fffdf9' },
        });
        if (!cancelled) setMemberQrDataUrl(dataUrl);
      } catch (error) {
        console.error('會員 QR Code 產生失敗:', error);
        if (!cancelled) setMemberQrDataUrl('');
      }
    };
    void createMemberQr();
    return () => { cancelled = true; };
  }, [profile?.userId]);

  useEffect(() => {
    return onValue(ref(getGelatoDatabase(), 'businessHours'), (snapshot) => {
      setBusinessHours((snapshot.val() as BusinessHours | null) ?? null);
    }, (error) => {
      console.error('營業時間同步失敗:', error);
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
      const snapshot = await get(query(ref(getGelatoDatabase(), 'orders'), orderByChild('userId'), equalTo(profile.userId)));
      const userOrders: Order[] = [];
      snapshot.forEach((child) => {
        const order = { id: child.key ?? undefined, ...(child.val() as Order & { userId?: string }) };
        if (order.userId === profile.userId && isRecentOrder(order)) userOrders.push(order);
      });
      userOrders.sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime());
      setOrders(userOrders);
    } catch (err) {
      console.error(err);
      alert('查詢失敗，請稍後再試');
    } finally {
      setIsLoadingOrders(false);
    }
  };

  const submitWish = async () => {
    if (!wishText.trim() || !profile) return;
    setIsSubmittingWish(true);
    try {
      const wishRef = push(ref(getGelatoDatabase(), 'wishlist'));
      await set(wishRef, {
        userId: profile.userId,
        displayName: profile.displayName,
        wishText: wishText.trim(),
        flavor: wishText.trim(),
        timestamp: Date.now(),
        status: 'pending',
      });
      setWishSuccess(true);
      setWishText('');
      window.setTimeout(() => setWishSuccess(false), 3000);
    } catch (err) {
      console.error('許願失敗:', err);
      alert('許願失敗，請稍後再試');
    } finally {
      setIsSubmittingWish(false);
    }
  };

  const switchTab = (tab: 'home' | 'menu' | 'orders' | 'member') => {
    setActiveTab(tab);
    setSelectedOrderNo(null); // 切換分頁時回到訂單列表
    if (tab === 'menu') setMenuLoaded(true);
    if (tab === 'orders') loadOrders();
    router.replace(tab === 'home' ? '/' : `/?tab=${tab}`, { scroll: false });
  };

  const openMenu = () => {
    switchTab('menu');
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
      window.location.href = paymentUrl;
    } catch (err) {
      console.error('LINE Pay 付款請求失敗:', err);
      alert(err instanceof Error ? err.message : 'LINE Pay 付款失敗，請稍後再試');
      setPayingOrderNo(null);
    }
  };

  const cancelOrder = async (order: Order) => {
    if (!order.orderNo || !isWaitingForShop(order) || cancellingOrderNo) return;
    if (!window.confirm('確定要取消這筆尚未接單的訂單嗎？取消後無法復原。')) return;
    setCancellingOrderNo(order.orderNo);
    try {
      const accessToken = liff.getAccessToken();
      if (!accessToken) throw new Error('無法取得 LINE 登入驗證，請重新開啟此頁面');
      const response = await fetch('/api/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo: order.orderNo, accessToken }),
      });
      const result = await response.json().catch((): { success?: boolean; error?: string } => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || '取消訂單失敗，請稍後再試');
      }
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
  const pointsBalance = Math.max(0, Number(memberPoints.balance || 0));
  const stampCount = pointsBalance % 10;
  const pointsToReward = pointsBalance >= 10 ? 0 : (stampCount === 0 ? 10 : 10 - stampCount);
  const availableRewards = Math.floor(pointsBalance / 10);
  const recentPointEntries = Object.entries(memberPoints.entries || {})
    .sort(([, a], [, b]) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 3);

  return (
    <main className={styles.appShell}>
      <header className={styles.topbar}>
        <div className={styles.brandLockup}>
          <Image src="/logo-new.png" alt="On My Gelato" width={42} height={42} className={styles.brandLogo} />
          <div>
            <p className={styles.eyebrow}>ON MY GELATO · CLUB</p>
            <p className={styles.brandName}><span>今日</span>想吃什麼？</p>
          </div>
        </div>
        <div className={`${styles.livePill} ${shopStatus.isOpen ? '' : styles.livePillClosed}`}><i /> {shopStatus.label}</div>
      </header>

      <section className={styles.content}>
        {status && !profile && <div className={styles.errorBanner}>{status}</div>}

        {menuLoaded && <div className={`${styles.menuFrame} ${activeTab === 'menu' ? styles.menuFrameVisible : styles.menuFrameHidden}`} aria-hidden={activeTab !== 'menu'}><iframe title="On My Gelato 線上點餐" src="/menu/?embedded=1" /></div>}

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
              <button type="button" className={`${styles.homeActionCard} ${styles.homeActionPrimary}`} onClick={openMenu}><span className={styles.actionCardIcon}>✦</span><div><b>開始點餐</b><small>挑一個今天的口味</small></div><strong>↗</strong></button>
              <button type="button" className={styles.homeActionCard} onClick={() => switchTab('orders')}><span className={styles.actionCardIcon}>◷</span><div><b>追蹤訂單</b><small>{orders.length ? `最近有 ${orders.length} 筆紀錄` : '查看取餐進度'}</small></div><strong>›</strong></button>
            </section>

            <section className={styles.homeFeatureCard}>
              <div><p className={styles.kicker}>GELATO NOTE</p><h2>真正的義式冰淇淋，<br /><em>不只是一種甜。</em></h2><p>每天少量製作，把季節與心情一起放進冰櫃。</p></div><span className={styles.featureMark}>✦</span>
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
              <header className={styles.ordersHero}><div><p className={styles.kicker}>ORDER JOURNEY</p><h1>訂單足跡</h1><p>從送出訂單，到準備好見面。</p></div><button type="button" className={styles.refreshButton} onClick={loadOrders} disabled={isLoadingOrders} aria-label="重新整理訂單">{isLoadingOrders ? '…' : '↻'}</button></header>
              <div className={styles.orderSummaryBar}><span><b>{orders.length}</b> 筆最近訂單</span><button type="button" onClick={openMenu}>再點一份 ↗</button></div>
              {isLoadingOrders ? <div className={styles.emptyState}><span className={styles.loadingDot} /><p>正在找回你的甜蜜紀錄…</p></div> : orders.length === 0 ? <div className={styles.ordersEmpty}><span>◌</span><h3>還沒有訂單足跡</h3><p>今天就挑一個喜歡的口味，<br />留下第一個甜蜜紀錄。</p><button type="button" onClick={openMenu} className={styles.secondaryButton}>開始第一次點餐</button></div> : <div className={styles.orderList}>{orders.map((order, index) => <OrderListItem key={`${getOrderKey(order)}-${index}`} order={order} onSelect={() => setSelectedOrderNo(getOrderKey(order))} />)}</div>}
            </section>
          )
        )}

        {activeTab === 'member' && (
          <section className={styles.memberPageView}>
            <header className={styles.memberPageHeader}>
              <div>
                <p className={styles.kicker}>GELATO CLUB</p>
                <h1>我的會員中心</h1>
                <p>每一口喜歡的味道，都替下一份獎勵靠近一點。</p>
              </div>
              <div className={styles.memberMiniAvatar}>{profile?.pictureUrl ? <Image src={profile.pictureUrl} alt="會員頭像" width={52} height={52} /> : <span>OG</span>}</div>
            </header>

            <section className={styles.pointsOverview} aria-label="目前集點進度">
              <div className={styles.pointsOverviewTop}><span>目前點數</span><span className={styles.pointsLive}><i />即時同步</span></div>
              <div className={styles.pointsNumber}>{pointsBalance}<small> 點</small></div>
              <div className={styles.pointsGoalRow}><span>{availableRewards > 0 ? `已有 ${availableRewards} 份兌換資格` : `再 ${pointsToReward} 點可兌換`}</span><b>集滿 10 點</b></div>
              <div className={styles.pointsProgress}><span style={{ width: `${Math.min(100, (stampCount / 10) * 100)}%` }} /></div>
              <div className={styles.pointsMeta}><span>{stampCount}/10 本輪進度</span><span>無使用期限</span></div>
            </section>

            <section className={styles.memberActionCard} aria-label="到店集點">
              <div className={styles.actionCardHeading}><span className={styles.actionIcon}>⌁</span><div><p className={styles.kicker}>到店集點</p><h2>結帳前，出示會員條碼</h2></div></div>
              <p className={styles.actionCardDescription}>讓店員掃描一次，購買「獨享杯／雙重奏」就會自動累積 1 點。</p>
              <button type="button" className={styles.qrActionButton} onClick={() => setMemberQrOpen((open) => !open)} aria-expanded={memberQrOpen}>
                <span>{memberQrOpen ? '收起會員 QR Code' : '出示會員 QR Code'}</span><b>{memberQrOpen ? '⌃' : '↗'}</b>
              </button>
              {memberQrOpen && <div className={styles.qrReveal}>
                {memberQrDataUrl ? <Image className={styles.memberQrImage} src={memberQrDataUrl} alt="會員 QR Code" width={210} height={210} unoptimized /> : <div className={styles.memberQrLoading}>正在準備會員條碼…</div>}
                <p>請將此畫面交給店員掃描<br />條碼只供本次會員驗證使用</p>
              </div>}
            </section>

            <section className={styles.howToCollect} aria-label="集點使用步驟">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>HOW IT WORKS</p><h2>三步完成集點</h2></div><span>簡單、即時、不漏點</span></div>
              <div className={styles.stepList}>
                <div className={styles.stepItem}><span>01</span><div><b>打開會員 QR</b><small>到店結帳前進入會員頁</small></div></div>
                <div className={styles.stepItem}><span>02</span><div><b>讓店員掃描</b><small>確認會員名稱與目前點數</small></div></div>
                <div className={styles.stepItem}><span>03</span><div><b>購買指定品項</b><small>獨享杯／雙重奏每杯 1 點</small></div></div>
              </div>
            </section>

            <section className={styles.memberHistoryCard} aria-label="最近點數紀錄">
              <div className={styles.subsectionHeading}><div><p className={styles.kicker}>POINT ACTIVITY</p><h2>最近點數紀錄</h2></div><span>{recentPointEntries.length ? '最新 3 筆' : '尚無紀錄'}</span></div>
              {recentPointEntries.length ? <div className={styles.pointActivityList}>{recentPointEntries.map(([entryId, entry]) => <div className={styles.pointActivityItem} key={entryId}><span className={styles.activityMark}>✦</span><div><b>{entry.sourceLabel || (entry.type === 'reward_redemption' ? '獎勵兌換' : '點數異動')}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{entry.createdAt ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(new Date(entry.createdAt)) : '最近更新'}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.activityPlus : styles.activityMinus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div> : <div className={styles.noActivity}><span>○</span><p>完成第一次指定品項消費後<br />點數紀錄會顯示在這裡。</p></div>}
            </section>

            <section className={styles.rewardGuideCard} aria-label="獎勵兌換說明">
              <div className={styles.rewardGuideBadge}>10</div><div><p className={styles.kicker}>REWARD GUIDE</p><h2>集滿 10 點，兌換一份指定獎勵</h2><p>{availableRewards > 0 ? '你已有可兌換資格，請到店向店員出示會員頁。' : `目前還差 ${pointsToReward} 點，慢慢集就好。`}</p></div>
            </section>

            <a href="https://lin.ee/sB558niE" target="_blank" rel="noopener noreferrer" className={styles.lineButton}><span>LINE</span> 加入好友，接收最新口味 <b>↗</b></a>
            <div className={styles.wishCard}>
              <div className={styles.wishHeading}><span>✦</span><div><p className={styles.kicker}>TASTE LAB</p><h2>口味許願池</h2></div></div>
              <p>下一球，也許就是你最想吃的那一球。</p>
              <textarea value={wishText} onChange={(e) => setWishText(e.target.value)} placeholder="例如：海鹽焦糖、開心果…" />
              <button onClick={submitWish} disabled={isSubmittingWish || !wishText.trim()} className={styles.wishButton}>{isSubmittingWish ? '送出中…' : '送出我的願望 ✦'}</button>
              {wishSuccess && <p className={styles.successMessage}>✓ 收到了！謝謝你的口味提案。</p>}
            </div>
          </section>
        )}
      </section>

      <nav className={styles.appDock} aria-label="主要導覽">
        <button type="button" onClick={() => switchTab('home')} className={activeTab === 'home' ? styles.dockActive : ''}><span>⌂</span><small>今日</small></button>
        <button type="button" onClick={openMenu} className={`${styles.dockOrderButton} ${activeTab === 'menu' ? styles.dockOrderActive : ''}`}><span>✦</span><small>點餐</small></button>
        <button type="button" onClick={() => switchTab('orders')} className={activeTab === 'orders' ? styles.dockActive : ''}><span>◷</span><small>足跡</small></button>
        <button type="button" onClick={() => switchTab('member')} className={activeTab === 'member' ? styles.dockActive : ''}><span>◒</span><small>會員</small></button>
      </nav>
    </main>
  );
}
