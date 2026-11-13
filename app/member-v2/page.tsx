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
  const [rewardView, setRewardView] = useState<'available' | 'earned'>('available');

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

  const stamps = Array.from({ length: 10 }, (_, index) => index < Math.min(balance, 10));

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => go('/')} aria-label="回到今日首頁">‹</button>
        <div><p>OMG! GELATO</p><strong>集點卡</strong></div>
        <button type="button" className={styles.refresh} onClick={() => { setLoading(true); void loadMemberData().finally(() => setLoading(false)); }} aria-label="重新整理">⋮</button>
      </header>

      {!profile ? (
        <section className={styles.loginCard}><span className={styles.loginIcon}>L</span><h1>加入會員，開始集點</h1><p>登入 LINE 後即可查看集點卡、優惠券與消費紀錄。</p><button type="button" onClick={login} className={styles.primary}>LINE 登入 <b>↗</b></button></section>
      ) : <>
        <section className={styles.coverHero}>
          <div className={styles.neonGlow} /><div className={styles.coneArt} aria-hidden="true"><i /><b /><span /></div>
          <div className={styles.coverTitle}><p>MEMBER BENEFITS</p><h1>On My Gelato<br /><em>義式冰淇淋</em></h1></div>
        </section>
        <section className={styles.stampCard}>
          <div className={styles.stampCardHead}><div className={styles.memberIdentity}><div className={styles.avatar}>{profile.pictureUrl ? <img src={profile.pictureUrl} alt="會員頭像" /> : <span>{profile.displayName.slice(0, 1)}</span>}</div><div><b>{profile.displayName}</b><small>會員編號 {profile.memberNo || '建立中…'}</small></div></div><span className={styles.cardMenu}>•••</span></div>
          <h2>OMG！集點拿好禮！</h2><p className={styles.expiry}>點數即時累積 · 下次消費使用</p>
          <div className={styles.stampReward}><span>★獎勵</span><b>{balance >= 10 ? '已達成兌換資格' : `再 ${10 - balance} 點可得獎勵`}</b><strong>⌃</strong></div>
          <div className={styles.stampGrid}>{stamps.map((filled, index) => <span key={index} className={`${styles.stamp} ${filled ? styles.stampFilled : ''}`}>{filled ? 'STAMP' : index === 9 ? '★' : 'STAMP'}</span>)}</div>
          <div className={styles.stampFooter}><span>目前 {balance} 點</span><span>集滿 10 點兌換獎勵</span></div>
        </section>

        <nav className={styles.rewardTabs} aria-label="獎勵分類"><button type="button" className={rewardView === 'available' ? styles.rewardTabActive : ''} onClick={() => setRewardView('available')}>尚未獲得的獎勵</button><button type="button" className={rewardView === 'earned' ? styles.rewardTabActive : ''} onClick={() => setRewardView('earned')}>已獲得的獎勵</button></nav>

        {rewardView === 'available' ? <section id="member-redeem" className={styles.rewardPanel}><div className={styles.rewardPanelTitle}><span>✦</span><div><p>REWARD MENU</p><h2>點數兌換</h2></div></div><p className={styles.rewardDescription}>每件指定線上品項累積 1 點；當次累積的點數限下次消費兌換使用。</p><div className={styles.rewardList}>{MEMBER_REWARD_OPTIONS.map((reward) => <div className={styles.reward} key={reward.type}><div><b>{reward.title}</b><small>{reward.description} · {reward.pointsCost} 點</small></div><button type="button" disabled={balance < reward.pointsCost || redeeming !== null} onClick={() => void redeem(reward.type)}>{redeeming === reward.type ? '處理中…' : balance < reward.pointsCost ? `還差 ${reward.pointsCost - balance} 點` : '兌換'}</button></div>)}</div></section> : <section id="member-vouchers" className={styles.rewardPanel}><div className={styles.rewardPanelTitle}><span>✓</span><div><p>MY REWARDS</p><h2>已獲得的獎勵</h2></div></div>{vouchers.length ? <div className={styles.voucherList}>{vouchers.map((voucher) => <div className={styles.voucher} key={voucher.id}><span className={styles.voucherMark}>✦</span><div><b>{voucher.title}</b><small>{voucher.status === 'issued' ? '未使用 · 永久有效' : '已核銷'}</small></div><strong>{voucher.status === 'issued' ? '可使用' : '已使用'}</strong></div>)}</div> : <div className={styles.empty}>尚未獲得獎勵<br /><small>集滿點數後即可在這裡查看。</small></div>}</section>}

        <section id="member-activity" className={styles.infoPanel}><div className={styles.sectionHead}><div><p>POINT ACTIVITY</p><h2>點數紀錄</h2></div><button type="button" onClick={() => scrollTo('member-activity')}>{entries.length} 筆</button></div>{entries.length ? <div className={styles.activityList}>{entries.slice(0, 8).map(([id, entry]) => <div className={styles.activity} key={id}><span>✦</span><div><b>{entry.sourceLabel || (entry.type === 'reward_redemption' ? '優惠兌換' : '消費集點')}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{formatDate(entry.createdAt)}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.plus : styles.minus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div> : <div className={styles.empty}>完成指定品項消費後，點數紀錄會顯示在這裡。</div>}</section>
        <section className={styles.infoPanel}><div className={styles.sectionHead}><div><p>ORDER HISTORY</p><h2>歷史訂單</h2></div><button type="button" onClick={() => go('/?tab=orders')}>查看全部 ↗</button></div>{orders.length ? <div className={styles.orderList}>{orders.slice(0, 3).map((order, index) => <button type="button" className={styles.order} key={`${order.orderNo || index}`} onClick={() => go('/?tab=orders')}><div><b>訂單 #{order.orderNo || '—'}</b><small>{formatDate(order.time || order.date)} · {order.status || '處理中'}</small></div><strong>NT$ {order.total || 0} ›</strong></button>)}</div> : <div className={styles.empty}>目前沒有歷史訂單。</div>}</section>
        <section className={styles.howTo}><div><p>使用說明</p><small>＊線上消費「獨享杯」「雙重奏」，每件累積 1 點<br />＊點數由系統自動累入會員帳戶<br />＊店家保有活動、獎項修改之權利</small></div><button type="button" onClick={() => go('/menu/')}>開始點餐</button></section>
      </>}

      {message && <div className={styles.toast} role="status">{message}</div>}
      <nav className={styles.bottomNav} aria-label="主要導覽"><button type="button" onClick={() => go('/')}><span>⌂</span><small>今日</small></button><button type="button" onClick={() => go('/menu/')}><span>✦</span><small>點餐</small></button><button type="button" onClick={() => go('/?tab=orders')}><span>◷</span><small>訂單查看</small></button><button type="button" className={styles.activeNav} onClick={() => scrollTo('member-redeem')}><span>◒</span><small>OMG會員</small></button></nav>
    </main>
  );
}
