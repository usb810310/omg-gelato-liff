'use client';

import { useEffect, useMemo, useState } from 'react';
import liff from '@line/liff';
import { MEMBER_REWARD_OPTIONS, type MemberRewardType } from '@/lib/member-rewards';
import styles from './page.module.css';

type Profile = { userId: string; displayName: string; pictureUrl?: string; memberNo?: string };
type PointEntry = { delta?: number; type?: string; sourceLabel?: string; createdAt?: number; orderNo?: string };
type Voucher = { id: string; title: string; pointsCost: number; status: 'issued' | 'redeemed'; issuedAt: number; redeemedAt?: number };
type Points = { balance?: number; entries?: Record<string, PointEntry>; rewardVouchers?: Record<string, Voucher> };
type Order = { orderNo?: string | number; total?: string | number; time?: string; date?: string; status?: string; items?: Array<{ name?: string; qty?: number }> };

const LIFF_ID = '2011536222-v4OvTSup';

function formatDate(value?: string | number) {
  if (!value) return '日期未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(date);
}

export default function MemberV2Page() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [points, setPoints] = useState<Points>({ balance: 0, entries: {}, rewardVouchers: {} });
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [redeeming, setRedeeming] = useState<MemberRewardType | null>(null);

  const accessToken = () => liff.getAccessToken() || '';

  const loadMemberData = async () => {
    const token = accessToken();
    if (!token) throw new Error('LINE 登入已失效，請重新開啟會員中心。');
    const [profileResponse, pointsResponse, ordersResponse] = await Promise.all([
      fetch('/api/member/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
      fetch('/api/member/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
      fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
    ]);
    const profileResult = await profileResponse.json();
    const pointsResult = await pointsResponse.json();
    const ordersResult = await ordersResponse.json();
    if (!profileResponse.ok || !profileResult.success) throw new Error(profileResult.error || '會員資料載入失敗');
    setProfile(profileResult.profile);
    if (pointsResponse.ok && pointsResult.success) setPoints(pointsResult.points || {});
    if (ordersResponse.ok && ordersResult.success) setOrders(ordersResult.orders || []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          setLoading(false);
          return;
        }
        await loadMemberData();
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '會員中心暫時無法載入');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const entries = useMemo(() => Object.entries(points.entries || {}).sort(([, a], [, b]) => Number(b.createdAt || 0) - Number(a.createdAt || 0)), [points.entries]);
  const vouchers = useMemo(() => Object.values(points.rewardVouchers || {}).sort((a, b) => b.issuedAt - a.issuedAt), [points.rewardVouchers]);
  const balance = Math.max(0, Number(points.balance || 0));

  const login = () => liff.login({ redirectUri: window.location.href });
  const go = (path: string) => { window.location.href = path; };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const redeem = async (rewardType: MemberRewardType) => {
    if (redeeming) return;
    const reward = MEMBER_REWARD_OPTIONS.find((item) => item.type === rewardType);
    if (!reward || balance < reward.pointsCost) return;
    setRedeeming(rewardType);
    setMessage('正在建立兌換券…');
    try {
      const response = await fetch('/api/member/rewards/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: accessToken(), rewardType, idempotencyKey: window.crypto.randomUUID() }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '兌換失敗');
      setPoints(result.points || {});
      setMessage(`已完成兌換：${reward.title}，請至「我的優惠券」查看。`);
      scrollTo('member-vouchers');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '兌換失敗，請稍後再試');
    } finally {
      setRedeeming(null);
    }
  };

  if (loading) return <main className={styles.loading}><div className={styles.loadingMark}>OMG</div><span>正在準備會員中心…</span></main>;

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => go('/')} aria-label="回到今日首頁">‹</button>
        <div><p>ON MY GELATO</p><strong>會員中心</strong></div>
        <button type="button" className={styles.refresh} onClick={() => { setLoading(true); void loadMemberData().finally(() => setLoading(false)); }} aria-label="重新整理">↻</button>
      </header>

      {!profile ? (
        <section className={styles.loginCard}><span className={styles.loginIcon}>L</span><h1>加入會員，甜一點</h1><p>登入 LINE 後即可查看點數、優惠券與歷史訂單。</p><button type="button" onClick={login} className={styles.primary}>LINE 登入 <b>↗</b></button></section>
      ) : <>
        <section className={styles.memberHero}>
          <div className={styles.avatar}>{profile.pictureUrl ? <img src={profile.pictureUrl} alt="會員頭像" /> : <span>{profile.displayName.slice(0, 1)}</span>}</div>
          <div><p className={styles.eyebrow}>WELCOME BACK</p><h1>{profile.displayName}</h1><small>會員編號 {profile.memberNo || '建立中…'}</small></div>
          <div className={styles.balance}><span>目前點數</span><strong>{balance}<small> 點</small></strong><em>即時同步</em></div>
        </section>

        <section className={styles.quickGrid} aria-label="會員功能">
          <button type="button" onClick={() => scrollTo('member-vouchers')}><span className={styles.quickIcon}>◇</span><b>優惠券</b><small>查看可用優惠</small></button>
          <button type="button" onClick={() => scrollTo('member-redeem')}><span className={styles.quickIcon}>✦</span><b>點數兌換</b><small>以點數換好禮</small></button>
          <button type="button" onClick={() => scrollTo('member-activity')}><span className={styles.quickIcon}>≋</span><b>點數紀錄</b><small>累積與使用明細</small></button>
          <button type="button" onClick={() => go('/?tab=orders')}><span className={styles.quickIcon}>◷</span><b>歷史訂單</b><small>查看消費足跡</small></button>
        </section>

        <button type="button" className={styles.orderBanner} onClick={() => go('/menu/')}><span>今天想吃哪一球？</span><strong>開始點餐 ↗</strong></button>

        <section id="member-vouchers" className={styles.card}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>MY BENEFITS</p><h2>我的優惠券</h2></div><span>{vouchers.filter((voucher) => voucher.status === 'issued').length} 張可用</span></div>
          {vouchers.length ? <div className={styles.voucherList}>{vouchers.map((voucher) => <div className={styles.voucher} key={voucher.id}><span className={styles.voucherMark}>✦</span><div><b>{voucher.title}</b><small>{voucher.status === 'issued' ? '未使用 · 永久有效' : '已核銷'}</small></div><strong>{voucher.status === 'issued' ? '可使用' : '已使用'}</strong></div>)}</div> : <div className={styles.empty}>還沒有優惠券<br /><small>累積點數後即可兌換專屬優惠。</small></div>}
        </section>

        <section id="member-redeem" className={styles.card}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>REWARD MENU</p><h2>點數兌換</h2></div><span>5 點起</span></div>
          <p className={styles.note}>每件指定線上品項累積 1 點，當次累積的點數限下次消費兌換使用。</p>
          <div className={styles.rewardList}>{MEMBER_REWARD_OPTIONS.map((reward) => <div className={styles.reward} key={reward.type}><div><b>{reward.title}</b><small>{reward.description} · {reward.pointsCost} 點</small></div><button type="button" disabled={balance < reward.pointsCost || redeeming !== null} onClick={() => void redeem(reward.type)}>{redeeming === reward.type ? '處理中…' : balance < reward.pointsCost ? '點數不足' : '兌換'}</button></div>)}</div>
        </section>

        <section id="member-activity" className={styles.card}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>POINT ACTIVITY</p><h2>點數紀錄</h2></div><span>{entries.length} 筆</span></div>
          {entries.length ? <div className={styles.activityList}>{entries.slice(0, 8).map(([id, entry]) => <div className={styles.activity} key={id}><span>✦</span><div><b>{entry.sourceLabel || (entry.type === 'reward_redemption' ? '優惠兌換' : '消費集點')}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{formatDate(entry.createdAt)}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.plus : styles.minus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div> : <div className={styles.empty}>完成指定品項消費後<br /><small>點數紀錄會顯示在這裡。</small></div>}
        </section>

        <section className={styles.card}>
          <div className={styles.sectionHead}><div><p className={styles.eyebrow}>ORDER HISTORY</p><h2>歷史訂單</h2></div><button type="button" className={styles.linkButton} onClick={() => go('/?tab=orders')}>查看全部 ↗</button></div>
          {orders.length ? <div className={styles.orderList}>{orders.slice(0, 3).map((order, index) => <button type="button" className={styles.order} key={`${order.orderNo || index}`} onClick={() => go('/?tab=orders')}><div><b>訂單 #{order.orderNo || '—'}</b><small>{formatDate(order.time || order.date)} · {order.status || '處理中'}</small></div><strong>NT$ {order.total || 0} ›</strong></button>)}</div> : <div className={styles.empty}>目前沒有歷史訂單<br /><small>選一份喜歡的口味，開始今天的甜。</small></div>}
        </section>
      </>}

      {message && <div className={styles.toast} role="status">{message}</div>}
      <nav className={styles.bottomNav} aria-label="主要導覽"><button type="button" onClick={() => go('/')}><span>⌂</span><small>今日</small></button><button type="button" onClick={() => go('/menu/')}><span>✦</span><small>點餐</small></button><button type="button" onClick={() => go('/?tab=orders')}><span>◷</span><small>訂單查看</small></button><button type="button" className={styles.activeNav} onClick={() => scrollTo('member-vouchers')}><span>◒</span><small>OMG會員</small></button></nav>
    </main>
  );
}
