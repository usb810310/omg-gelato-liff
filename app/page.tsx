'use client';

import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import Image from 'next/image';
import liff from '@line/liff';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, get, limitToLast, onValue, push, query, ref, set } from 'firebase/database';
import { getShopStatus, type BusinessHours } from '@/lib/business-hours';
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

type Order = {
  id?: string; userId?: string;
  orderNo?: string | number; displayNo?: string | number;
  pickupCode?: string | number; pickupNo?: string | number; pickupNumber?: string | number;
  total?: string | number; remark?: string; time?: string; date?: string;
  status?: string; payment?: string; paymentStatus?: string;
  channel?: string; source?: string; rejected?: boolean; voided?: boolean; cancelledBy?: string;
  items?: OrderItem[];
};

type OrderItem = { name?: string; price?: number; qty?: number; flavorDisplay?: string };

function getOrderKey(order: Order) {
  return String(order.orderNo ?? order.id ?? '');
}

function getPaymentStatus(order: Order) {
  if (order.voided || order.payment === '已取消') return '已取消';
  if (order.paymentStatus === 'paid' || order.payment === '已付款' || order.payment === 'paid' || order.payment === '已確認') return '已付款';
  if (order.paymentStatus === 'processing' || order.payment === '付款處理中' || order.payment === 'processing') return '付款處理中';
  if (order.paymentStatus === 'failed' || order.payment === '付款失敗' || order.payment === 'failed') return '付款失敗';
  return '尚未付款';
}

function getOrderStatus(order: Order) {
  return getStatusMeta(order).label;
}

function isWaitingForShop(order: Order) {
  const status = String(order.status || '').trim();
  return !order.voided && !order.rejected && ['', 'waiting', 'pending', 'waiting_accept', '等待接單', '等待店家接單'].includes(status);
}

type OrderStatusKey = 'waiting' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'rejected';
const statusSteps: Array<{ key: Exclude<OrderStatusKey, 'rejected'>; label: string; icon: string }> = [
  { key: 'waiting', label: '等待接單', icon: '01' },
  { key: 'accepted', label: '店家已接單', icon: '02' },
  { key: 'preparing', label: '製作中', icon: '03' },
  { key: 'ready', label: '可以取餐', icon: '04' },
];

function getStatusMeta(order: Order) {
  if (order.cancelledBy === 'customer') {
    return { key: 'rejected' as const, label: '訂單已取消', hint: '此訂單已由您取消。' };
  }
  if (order.voided || order.rejected || ['cancelled', 'rejected', '已取消', '拒單'].includes(order.status || '')) {
    return { key: 'rejected' as const, label: '店家無法接單', hint: '若已付款，退款會依付款服務流程處理。' };
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
  const cancelled = order.voided || order.rejected;
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
  const canPay = LINE_PAY_ENABLED && !order.voided && !isOnsitePayment && ['尚未付款', '付款失敗', '付款處理中'].includes(paymentStatus);
  const cancelled = order.voided || order.rejected;
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

// 線上 LINE Pay 待單一窗口申請完成後再開啟
const LINE_PAY_ENABLED = false;

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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState('正在初始化...');
  const [activeTab, setActiveTab] = useState<'home' | 'orders' | 'member'>('home');
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

  const [todayContent, setTodayContent] = useState(dailyData[0]);

  useEffect(() => {
    const todayIndex = new Date().getDay();
    setTodayContent(dailyData[todayIndex]);
  }, []);

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
    const ordersQuery = query(ref(getGelatoDatabase(), 'orders'), limitToLast(20));
    return onValue(ordersQuery, (snapshot) => {
      const userOrders: Order[] = [];
      snapshot.forEach((child) => {
        const order = { id: child.key ?? undefined, ...(child.val() as Order) };
        if (order.userId === profile.userId) userOrders.push(order);
      });
      userOrders.sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime());
      setOrders(userOrders);
    }, (error) => {
      console.error('訂單即時同步失敗:', error);
    });
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
      const snapshot = await get(query(ref(getGelatoDatabase(), 'orders'), limitToLast(20)));
      const userOrders: Order[] = [];
      snapshot.forEach((child) => {
        const order = child.val() as Order & { userId?: string };
        if (order.userId === profile.userId) userOrders.push(order);
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

  const switchTab = (tab: 'home' | 'orders' | 'member') => {
    setActiveTab(tab);
    setSelectedOrderNo(null); // 切換分頁時回到訂單列表
    if (tab === 'orders') loadOrders();
  };

  const handleMainButtonClick = () => {
    if (todayContent.btnAction === 'wish') {
      switchTab('member');
    } else if (todayContent.btnAction === 'menu') {
      window.location.href = '/menu/';
    } else if (todayContent.btnAction === 'inquiry') {
      window.alert('☕ 店休中！客服小幫手正在趕來的路上。\n\n未來這裡會開啟 24/7 線上文字對話功能，敬請期待！');
    }
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
      if (!response.ok || (!result.appPaymentUrl && !result.webPaymentUrl && !result.paymentUrl)) {
        throw new Error(result.error || 'LINE Pay 付款服務尚未完成設定');
      }
      const paymentUrl = liff.isInClient()
        ? result.appPaymentUrl || result.webPaymentUrl || result.paymentUrl
        : result.webPaymentUrl || result.appPaymentUrl || result.paymentUrl;
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

  return (
    <main className={styles.appShell}>
      <header className={styles.topbar}>
        <div className={styles.brandLockup}>
          <Image src="/logo-new.png" alt="On My Gelato" width={42} height={42} className={styles.brandLogo} />
          <div>
            <p className={styles.eyebrow}>ARTISAN GELATO</p>
            <p className={styles.brandName}><span>On</span> My <b>Gelato</b></p>
          </div>
        </div>
        <span className={`${styles.livePill} ${shopStatus.isOpen ? '' : styles.livePillClosed}`}><i /> {shopStatus.label}</span>
      </header>

      <section className={styles.content} key={activeTab}>
        {status && !profile && <div className={styles.errorBanner}>{status}</div>}

        {activeTab === 'home' && (
          <div className={styles.homeView}>
            <section className={styles.heroCard}>
              <div className={styles.heroCopy}>
                <h1>{todayContent.title}</h1>
                <p className={styles.heroDescription}>{todayContent.desc}</p>
                <button type="button" className={styles.primaryButton} onClick={handleMainButtonClick}>
                  {todayContent.btnText}<span>↗</span>
                </button>
              </div>
              <div className={styles.heroArt} aria-hidden="true">
                <div className={styles.sunShape} />
                <div className={`${styles.scoop} ${styles.scoopPistachio}`} />
                <div className={`${styles.scoop} ${styles.scoopStrawberry}`} />
                <div className={styles.cone}><span /></div>
                <span className={styles.artLabel}>FRESH<br />EVERY DAY</span>
              </div>
            </section>

            <section className={styles.welcomeRow}>
              <div className={styles.avatarWrap}>
                {profile?.pictureUrl ? <Image src={profile.pictureUrl} alt="會員頭像" width={42} height={42} /> : <span>OG</span>}
              </div>
              <div>
                <p className={styles.miniLabel}>WELCOME BACK</p>
                <h2>{profile ? `${profile.displayName}，歡迎回來` : '歡迎來到 On My Gelato'}</h2>
              </div>
              <span className={styles.sparkle}>✦</span>
            </section>

            {!shopStatus.isOpen && <div className={styles.closedNotice}><b>{shopStatus.label}</b><span>{shopStatus.detail}</span></div>}

            <div className={styles.quickGrid}>
              <a href="/menu/" className={`${styles.quickCard} ${styles.greenCard}`}><span className={styles.quickIcon}>✦</span><span><b>今日口味</b><small>{shopStatus.isOpen ? '立即點餐' : shopStatus.canOrder ? '預約點餐' : '瀏覽口味・暫停點餐'}</small></span><strong>↗</strong></a>
              <button onClick={() => switchTab('orders')} className={`${styles.quickCard} ${styles.creamCard}`}><span className={styles.quickIcon}>▤</span><span><b>我的訂單</b><small>查看取餐進度</small></span><strong>›</strong></button>
            </div>

            <section className={styles.noteCard}>
              <span className={styles.noteMark}>“</span>
              <p>真正的義式冰淇淋，<br /><b>不只是一種甜。</b></p>
              <span className={styles.noteCaption}>— MADE WITH PASSION</span>
            </section>
          </div>
        )}

        {activeTab === 'orders' && (
          selectedOrder ? (
            /* ====== 單張訂單詳情頁 ====== */
            <section className={styles.pageView}>
              <button
                type="button"
                className={styles.backButton}
                onClick={() => setSelectedOrderNo(null)}
              >
                <span>‹</span> 返回訂單列表
              </button>
              <OrderDetailCard
                order={selectedOrder}
                payingOrderNo={payingOrderNo}
                onPay={startLinePay}
                cancellingOrderNo={cancellingOrderNo}
                onCancel={cancelOrder}
              />
            </section>
          ) : (
            /* ====== 訂單列表 ====== */
            <section className={styles.pageView}>
              <div className={styles.sectionHeading}>
                <div>
                  <p className={styles.kicker}>YOUR SWEET MOMENTS</p>
                  <h1>我的訂單</h1>
                </div>
                <button type="button" className={styles.refreshButton} onClick={loadOrders} disabled={isLoadingOrders} aria-label="重新整理訂單">
                  {isLoadingOrders ? '…' : '↻'}
                </button>
              </div>

              {isLoadingOrders ? (
                <div className={styles.emptyState}>
                  <span className={styles.loadingDot} />
                  <p>正在找回你的甜蜜紀錄…</p>
                </div>
              ) : orders.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyEmoji}>○</span>
                  <h3>還沒有訂單</h3>
                  <p>今天就選一個喜歡的口味吧！</p>
                  <a href="/menu/" className={styles.secondaryButton}>{shopStatus.isOpen ? '前往今日口味' : '瀏覽今日口味'}</a>
                </div>
              ) : (
                <div className={styles.orderList}>
                  {orders.map((order, index) => (
                    <OrderListItem
                      key={`${getOrderKey(order)}-${index}`}
                      order={order}
                      onSelect={() => setSelectedOrderNo(getOrderKey(order))}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        )}

        {activeTab === 'member' && (
          <section className={styles.pageView}>
            <div className={styles.memberHero}>
              <div className={styles.memberAvatar}>{profile?.pictureUrl ? <Image src={profile.pictureUrl} alt="會員頭像" width={96} height={96} /> : <span>OG</span>}</div>
              <p className={styles.kicker}>GELATO CLUB MEMBER</p>
              <h1>{profile?.displayName || 'Gelato Lover'}</h1>
              <p className={styles.memberId}>ID · {profile?.userId?.slice(-8) || 'WELCOME'}</p>
            </div>
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

      <nav className={styles.bottomNav} aria-label="主要導覽">
        {([['home', '⌂', '首頁'], ['orders', '▤', '訂單'], ['member', '○', '會員']] as const).map(([tab, icon, label]) => (
          <button key={tab} onClick={() => switchTab(tab)} className={activeTab === tab ? styles.activeNav : ''}>
            <span>{icon}</span><small>{label}</small>
          </button>
        ))}
      </nav>
    </main>
  );
}