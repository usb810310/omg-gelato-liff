'use client';

import { useEffect, useMemo, useState } from 'react';
import liff from '@line/liff';
import QRCode from 'qrcode';
import { MEMBER_REWARD_OPTIONS, type MemberRewardType } from '@/lib/member-rewards';
import styles from './page.module.css';

type Profile = { userId: string; displayName: string; pictureUrl?: string; memberNo?: string };
type PointEntry = { delta?: number; type?: string; sourceLabel?: string; createdAt?: number; orderNo?: string };
type Voucher = { id: string; title: string; pointsCost: number; status: 'issued' | 'redeemed'; issuedAt: number; redeemedAt?: number };
type Points = { balance?: number; entries?: Record<string, PointEntry>; rewardVouchers?: Record<string, Voucher> };
type Order = { orderNo?: string | number; total?: string | number; time?: string; date?: string; status?: string };
type QrState = { dataUrl: string; expiresAt: number; title: string };

type Dialog = { kind: 'memberQr' | 'voucherQr'; voucher?: Voucher } | null;
const LIFF_ID = '2011536222-27exC5Co';

function formatDate(value?: string | number, long = false) {
  if (!value) return '日期未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-TW', long ? { year: 'numeric', month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric' }).format(date);
}

function entryLabel(entry: PointEntry) {
  if (entry.sourceLabel) return entry.sourceLabel;
  if (entry.type === 'reward_redemption') return '兌換會員獎勵';
  if (entry.type === 'order_reward') return '線上消費集點';
  if (entry.type === 'pos_purchase') return '門市消費集點';
  return '點數異動';
}

export default function MemberV2Page() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [points, setPoints] = useState<Points>({ balance: 0, entries: {}, rewardVouchers: {} });
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [insideLine, setInsideLine] = useState(false);
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [redeeming, setRedeeming] = useState<MemberRewardType | null>(null);
  const [showAllEntries, setShowAllEntries] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const demoMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';

  const accessToken = () => liff.getAccessToken() || '';
  const balance = Math.max(0, Number(points.balance || 0));
  const entries = useMemo(() => Object.entries(points.entries || {}).sort(([, a], [, b]) => Number(b.createdAt || 0) - Number(a.createdAt || 0)), [points.entries]);
  const vouchers = useMemo(() => Object.values(points.rewardVouchers || {}).sort((a, b) => b.issuedAt - a.issuedAt), [points.rewardVouchers]);
  const activeVouchers = vouchers.filter((voucher) => voucher.status === 'issued');
  const nextReward = [...MEMBER_REWARD_OPTIONS].sort((a, b) => a.pointsCost - b.pointsCost).find((reward) => balance < reward.pointsCost);

  const loadMemberData = async () => {
    const token = accessToken();
    if (!token) throw new Error('LINE 登入已失效，請重新登入。');
    const [profileResponse, pointsResponse, ordersResponse] = await Promise.all([
      fetch('/api/member/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
      fetch('/api/member/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
      fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), cache: 'no-store' }),
    ]);
    const profileResult = await profileResponse.json();
    const pointsResult = await pointsResponse.json();
    const ordersResult = await ordersResponse.json();
    if (profileResponse.status === 401 || /Token|登入已失效/i.test(String(profileResult.error || ''))) {
      const authError = new Error('LINE 登入已失效，請重新登入。');
      authError.name = 'LiffAuthError';
      throw authError;
    }
    if (!profileResponse.ok || !profileResult.success) throw new Error(profileResult.error || '會員資料載入失敗');
    setProfile(profileResult.profile);
    if (pointsResponse.ok && pointsResult.success) setPoints(pointsResult.points || {});
    if (ordersResponse.ok && ordersResult.success) setOrders(ordersResult.orders || []);
  };

  const refresh = async () => {
    if (syncing) return;
    setSyncing(true); setMessage('正在同步會員資料…');
    try { await loadMemberData(); setMessage('會員資料已更新'); } catch (error) { setMessage(error instanceof Error ? error.message : '同步失敗，請稍後再試'); } finally { setSyncing(false); }
  };

  const reauthenticate = (inClient: boolean) => {
    if (!inClient) {
      setMessage('請從 LINE 官方帳號重新開啟會員中心。');
      return;
    }
    try { if (liff.isLoggedIn()) liff.logout(); } catch (error) { console.warn('清除過期 LINE 登入狀態失敗', error); }
    liff.login({ redirectUri: window.location.href });
  };

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        if (demoMode) {
          setProfile({ userId: 'preview-member', displayName: '示範會員', memberNo: 'M-DEMO3466' });
          setPoints({ balance: 7, entries: { preview: { delta: 2, sourceLabel: '線上消費集點', createdAt: Date.now() - 86400000, orderNo: '908' } }, rewardVouchers: {} });
          setOrders([{ orderNo: '908', total: 220, time: new Date().toISOString(), status: '已完成' }]);
          return;
        }
        await liff.init({ liffId: LIFF_ID });
        const inClient = liff.isInClient(); setInsideLine(inClient);
        if (!liff.isLoggedIn()) { if (inClient) liff.login({ redirectUri: window.location.href }); return; }
        try { await liff.getProfile(); } catch (error) {
          console.warn('LINE profile token 已失效，重新登入', error);
          reauthenticate(inClient);
          return;
        }
        await loadMemberData();
      } catch (error) {
        if (!cancelled) {
          if (error instanceof Error && error.name === 'LiffAuthError') reauthenticate(liff.isInClient());
          else setMessage(error instanceof Error ? error.message : '會員中心暫時無法載入');
        }
      }
      finally { if (!cancelled) setLoading(false); }
    };
    void boot();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const login = () => liff.login({ redirectUri: window.location.href });
  const go = (path: string) => {
    const target = new URL(path, window.location.origin).toString();
    try {
      if (liff.isInClient() && liff.isApiAvailable('openWindow')) {
        liff.openWindow({ url: target, external: false });
        return;
      }
    } catch (error) {
      console.warn('LINE 導覽 API 無法使用，改用一般頁面導向', error);
    }
    window.location.assign(target);
  };

  const openMemberQr = async () => {
    setDialog({ kind: 'memberQr' }); setQr(null); setQrLoading(true);
    try {
      const response = await fetch('/api/member/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: accessToken(), mode: 'member' }), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '會員 QR 產生失敗');
      setQr({ dataUrl: await QRCode.toDataURL(result.token, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#2d211b', light: '#fffdf9' } }), expiresAt: Number(result.expiresAt), title: '門市會員 QR' });
    } catch (error) { setMessage(error instanceof Error ? error.message : '會員 QR 產生失敗'); }
    finally { setQrLoading(false); }
  };

  const openVoucherQr = async (voucher: Voucher) => {
    setDialog({ kind: 'voucherQr', voucher }); setQr(null); setQrLoading(true);
    try {
      const response = await fetch('/api/member/rewards/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: accessToken(), voucherId: voucher.id }), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '核銷 QR 產生失敗');
      setQr({ dataUrl: await QRCode.toDataURL(result.token, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#2d211b', light: '#fffdf9' } }), expiresAt: Number(result.expiresAt), title: voucher.title });
    } catch (error) { setMessage(error instanceof Error ? error.message : '核銷 QR 產生失敗'); }
    finally { setQrLoading(false); }
  };

  const redeem = async (rewardType: MemberRewardType) => {
    if (redeeming) return;
    const reward = MEMBER_REWARD_OPTIONS.find((item) => item.type === rewardType);
    if (!reward || balance < reward.pointsCost) return;
    setRedeeming(rewardType); setMessage('正在建立兌換券…');
    try {
      const response = await fetch('/api/member/rewards/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: accessToken(), rewardType, idempotencyKey: window.crypto.randomUUID() }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '兌換失敗');
      setPoints(result.points || {}); setMessage(`已兌換 ${reward.title}，兌換券已加入錢包。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '兌換失敗，請稍後再試'); }
    finally { setRedeeming(null); }
  };

  if (loading) return <main className={styles.loading}><div className={styles.loadingMark}>OMG</div><strong>正在同步會員資料</strong><span>請稍候，正在確認你的點數與兌換券…</span></main>;

  return <main className={styles.shell}>
    <header className={styles.topbar}><button type="button" className={styles.iconButton} onClick={() => go('/')} aria-label="回到今日首頁">‹</button><div><span>OMG! GELATO</span><strong>會員錢包</strong></div><button type="button" className={styles.iconButton} onClick={() => void refresh()} disabled={syncing} aria-label="重新整理">{syncing ? '…' : '↻'}</button></header>

    {!profile ? <section className={styles.loginState}><div className={styles.loginMark}>L</div><p className={styles.eyebrow}>ON MY GELATO · CLUB</p><h1>登入，打開你的會員錢包</h1><p>登入 LINE 後即可查看點數、兌換券與歷史消費紀錄。</p><button type="button" className={styles.primaryButton} onClick={login}>LINE 登入 <b>↗</b></button>{!insideLine && !demoMode && <small>請從 LINE 官方帳號開啟，可使用完整會員功能。</small>}</section> : <>
      <section className={styles.accountHeader}><div className={styles.avatar}>{profile.pictureUrl ? <img src={profile.pictureUrl} alt="會員頭像" /> : <span>{profile.displayName.slice(0, 1)}</span>}</div><div><p className={styles.eyebrow}>GOOD TO SEE YOU</p><h1>{profile.displayName}</h1><span>會員編號 {profile.memberNo || '建立中…'}</span></div><span className={styles.liveBadge}><i />即時同步</span></section>

      <section className={styles.balanceCard}><div className={styles.balanceTop}><span>目前 OMG 點數</span><span>無使用期限</span></div><strong>{balance}<small> 點</small></strong><div className={styles.balanceBottom}><span>{nextReward ? `再 ${nextReward.pointsCost - balance} 點可兌換${nextReward.title}` : '目前已達最低兌換門檻'}</span><button type="button" onClick={() => document.getElementById('rewards')?.scrollIntoView({ behavior: 'smooth' })}>查看兌換 ↗</button></div></section>

      <section className={styles.quickGrid}><button type="button" className={styles.quickCard} onClick={() => void openMemberQr()}><span className={styles.quickIcon}>⌁</span><div><b>出示會員 QR</b><small>結帳前給店員掃描</small></div><em>›</em></button><button type="button" className={styles.quickCard} onClick={() => document.getElementById('vouchers')?.scrollIntoView({ behavior: 'smooth' })}><span className={styles.quickIcon}>✦</span><div><b>我的兌換券</b><small>{activeVouchers.length ? `${activeVouchers.length} 張可使用` : '目前沒有可用兌換券'}</small></div><em>›</em></button></section>

      <section className={styles.section}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>REWARD MENU</p><h2>用點數換一份喜歡</h2></div><span>5 點起兌</span></div><p className={styles.sectionIntro}>點數在兌換時扣除；兌換券永久有效，到店出示核銷 QR 由店員確認使用。</p><div className={styles.rewardGrid}>{MEMBER_REWARD_OPTIONS.map((reward) => <article className={styles.rewardCard} key={reward.type}><div><b>{reward.title}</b><small>{reward.description}</small></div><strong>{reward.pointsCost}<small> 點</small></strong><button type="button" disabled={balance < reward.pointsCost || redeeming !== null} onClick={() => void redeem(reward.type)}>{redeeming === reward.type ? '建立中…' : balance < reward.pointsCost ? `還差 ${reward.pointsCost - balance} 點` : '立即兌換'}</button></article>)}</div></section>

      <section id="vouchers" className={styles.section}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>MY VOUCHERS</p><h2>兌換券錢包</h2></div><span>{activeVouchers.length} 張可使用</span></div>{vouchers.length ? <div className={styles.voucherList}>{vouchers.map((voucher) => <article className={styles.voucherCard} key={voucher.id}><span className={styles.voucherSeal}>✦</span><div><b>{voucher.title.includes('券') ? voucher.title : `${voucher.title}兌換券`}</b><small>{voucher.status === 'issued' ? `永久有效 · 已扣 ${voucher.pointsCost} 點` : `已於 ${formatDate(voucher.redeemedAt, true)} 核銷`}</small></div>{voucher.status === 'issued' ? <button type="button" onClick={() => void openVoucherQr(voucher)}>顯示核銷 QR</button> : <em>已使用</em>}</article>)}</div> : <div className={styles.emptyState}><span>✦</span><p>還沒有兌換券</p><small>集滿 5 點即可兌換指定品項折價券。</small></div>}</section>

      <section className={styles.section}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>POINT ACTIVITY</p><h2>點數流水</h2></div><button type="button" className={styles.textButton} onClick={() => setShowAllEntries((value) => !value)}>{entries.length ? (showAllEntries ? '收合' : `查看全部 ${entries.length} 筆`) : '尚無紀錄'}</button></div>{entries.length ? <div className={styles.activityList}>{entries.slice(0, showAllEntries ? entries.length : 5).map(([id, entry]) => <div className={styles.activityRow} key={id}><span>✦</span><div><b>{entryLabel(entry)}</b><small>{entry.orderNo ? `訂單 #${entry.orderNo} · ` : ''}{formatDate(entry.createdAt, true)}</small></div><strong className={Number(entry.delta || 0) >= 0 ? styles.plus : styles.minus}>{Number(entry.delta || 0) >= 0 ? '+' : ''}{entry.delta || 0}</strong></div>)}</div> : <div className={styles.emptyState}><span>○</span><p>還沒有點數紀錄</p><small>完成指定品項消費後，點數會自動顯示在這裡。</small></div>}</section>

      <section className={styles.section}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>ORDER HISTORY</p><h2>最近訂單</h2></div><button type="button" className={styles.textButton} onClick={() => go('/?tab=orders')}>查看全部 ↗</button></div>{orders.length ? <div className={styles.orderList}>{orders.slice(0, 3).map((order, index) => <button type="button" className={styles.orderRow} key={`${order.orderNo || index}`} onClick={() => go('/?tab=orders')}><div><b>訂單 #{order.orderNo || '—'}</b><small>{formatDate(order.time || order.date, true)} · {order.status || '處理中'}</small></div><strong>NT$ {order.total || 0} ›</strong></button>)}</div> : <div className={styles.emptyState}><span>◌</span><p>目前沒有歷史訂單</p><small>選一個喜歡的口味，開始第一次點餐。</small></div>}</section>

      <section className={styles.rules}><p className={styles.eyebrow}>HOW IT WORKS</p><h2>會員點數使用說明</h2><p>線上與門市 POS 的指定品項消費會依目前活動規則累點；退款或取消訂單時，系統會依原交易回收點數。門市會員 QR 約 90 秒有效，兌換券核銷 QR 約 5 分鐘有效。</p><button type="button" className={styles.primaryButton} onClick={() => go('/menu/')}>開始點餐 ↗</button></section>
    </>}

    {message && <div className={styles.toast} role="status">{message}</div>}
    <nav className={styles.bottomNav} aria-label="主要導覽"><button type="button" onClick={() => go('/')}><span>⌂</span><small>今日</small></button><button type="button" onClick={() => go('/menu/')}><span>✦</span><small>點餐</small></button><button type="button" onClick={() => go('/?tab=orders')}><span>◷</span><small>訂單</small></button><button type="button" className={styles.activeNav}><span>◒</span><small>會員錢包</small></button></nav>

    {dialog && <div className={styles.dialogOverlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="qr-title"><header><div><p className={styles.eyebrow}>SECURE SHORT-LIVED QR</p><h2 id="qr-title">{dialog.kind === 'memberQr' ? '門市會員 QR' : dialog.voucher?.title}</h2></div><button type="button" onClick={() => setDialog(null)} aria-label="關閉">×</button></header><div className={styles.qrBody}>{qr && qr.expiresAt > now ? <img src={qr.dataUrl} alt={qr.title} /> : <div className={styles.qrPlaceholder}>{qrLoading ? '正在準備短效 QR…' : '這組 QR 已失效，請重新產生。'}</div>}<p>{dialog.kind === 'memberQr' ? '請在結帳前出示，POS 掃描後會綁定本次訂單。' : '請讓店員在 POS 掃描；兌換券本身永久有效。'}</p><span>{qr && qr.expiresAt > now ? `有效時間剩餘 ${Math.max(1, Math.ceil((qr.expiresAt - now) / 1000))} 秒` : '請重新產生一組新的 QR'}</span><button type="button" className={styles.primaryButton} onClick={() => void (dialog.kind === 'memberQr' ? openMemberQr() : dialog.voucher && openVoucherQr(dialog.voucher))} disabled={qrLoading}>{qrLoading ? '產生中…' : qr ? '重新產生 QR' : '產生 QR'}</button></div></section></div>}
  </main>;
}
