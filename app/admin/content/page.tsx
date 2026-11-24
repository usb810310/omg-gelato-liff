'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import styles from './content.module.css';

type Flavor = { id: string; name: string; desc: string; soldOut: boolean; sortOrder: number };
type Announcement = { id: string; title: string; content: string; active: boolean; timestamp: number };
type MemberSummary = { memberNo: string; displayName: string; phone: string; memberType: string; createdAt: number; pointsBalance: number; pointsUpdatedAt: number };
type MemberPointEntry = { delta: number; type: string; sourceLabel: string; createdAt: number; orderNo: string | null; channel: string | null; ruleLabel: string | null };
type MemberOrder = { orderNo: string; timestamp: number; total: number; paymentStatus: string; status: string; items: Array<{ name: string; quantity: number }> };
type MemberLookupResult = { success?: boolean; error?: string; member?: MemberSummary; recentPoints?: MemberPointEntry[]; recentOrders?: MemberOrder[] };
type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type DaySchedule = { open: boolean; start: string; end: string };
type WeeklySchedule = Record<DayKey, DaySchedule>;
type SpecialDate = { dateKey: string; open: boolean; start: string; end: string; reason: string };
type ApiResult = { success?: boolean; error?: string; itemCount?: number; todayFlavors?: Record<string, unknown>; announcements?: Record<string, unknown>; businessHours?: Record<string, unknown> };

const WEEK_DAYS: Array<{ key: DayKey; label: string }> = [
  { key: 'mon', label: '星期一' }, { key: 'tue', label: '星期二' }, { key: 'wed', label: '星期三' },
  { key: 'thu', label: '星期四' }, { key: 'fri', label: '星期五' }, { key: 'sat', label: '星期六' },
  { key: 'sun', label: '星期日' },
];

function defaultWeeklySchedule(): WeeklySchedule {
  return Object.fromEntries(WEEK_DAYS.map(({ key }) => [key, { open: true, start: '13:00', end: '20:00' }])) as WeeklySchedule;
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '0';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatTaipeiTimestamp(value: number) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short',
  }).format(value);
}

function formatAmount(value: number) {
  return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(value);
}

const firebaseConfig = {
  apiKey: 'AIzaSyDvzZKr2x3TGeOFZGisKKXjbYH00DLVhKg',
  authDomain: 'omg-menu-5761a.firebaseapp.com',
  databaseURL: 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'omg-menu-5761a',
  storageBucket: 'omg-menu-5761a.firebasestorage.app',
  messagingSenderId: '193209930119',
  appId: '1:193209930119:web:d9216165be9ef6c0bcc322',
};

function getBrowserAuth() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getAuth(app);
}

function objectEntries<T>(value: Record<string, unknown> | undefined, convert: (id: string, item: Record<string, unknown>) => T) {
  return Object.entries(value || {})
    .filter(([, item]) => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map(([id, item]) => convert(id, item as Record<string, unknown>));
}

export default function ContentAdminPage() {
  const authRef = useRef<Auth | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [adminClaim, setAdminClaim] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'flavors' | 'announcements' | 'hours' | 'members'>('flavors');
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [weeklyHours, setWeeklyHours] = useState<WeeklySchedule>(() => defaultWeeklySchedule());
  const savedWeeklyHoursRef = useRef<WeeklySchedule>(defaultWeeklySchedule());
  const [hoursAnnouncement, setHoursAnnouncement] = useState('');
  const savedHoursAnnouncementRef = useRef('');
  const [specialDates, setSpecialDates] = useState<SpecialDate[]>([]);
  const [removedSpecialDates, setRemovedSpecialDates] = useState<string[]>([]);
  const savedSpecialDatesRef = useRef<Record<string, SpecialDate>>({});
  const [newSpecialDate, setNewSpecialDate] = useState(taipeiToday);
  const [newSpecialOpen, setNewSpecialOpen] = useState(false);
  const [newSpecialStart, setNewSpecialStart] = useState('13:00');
  const [newSpecialEnd, setNewSpecialEnd] = useState('20:00');
  const [newSpecialReason, setNewSpecialReason] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberResult, setMemberResult] = useState<MemberLookupResult | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberError, setMemberError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const request = useCallback(async (currentUser: User, method: 'GET' | 'PUT', body?: unknown) => {
    const token = await currentUser.getIdToken();
    const response = await fetch('/api/admin/content', {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (!response.ok || result.success === false) throw new Error(result.error || `請求失敗（${response.status}）`);
    return result;
  }, []);

  const loadContent = useCallback(async (currentUser: User) => {
    setLoading(true);
    setError('');
    try {
      const result = await request(currentUser, 'GET');
      setFlavors(objectEntries(result.todayFlavors, (id, item) => ({
        id,
        name: typeof item.name === 'string' ? item.name : '',
        desc: typeof item.desc === 'string' ? item.desc : '',
        soldOut: item.soldOut === true,
        sortOrder: Number(item.sortOrder) || 0,
      })).sort((a, b) => a.sortOrder - b.sortOrder));
      setAnnouncements(objectEntries(result.announcements, (id, item) => ({
        id,
        title: typeof item.title === 'string' ? item.title : '',
        content: typeof item.content === 'string' ? item.content : '',
        active: item.active !== false,
        timestamp: Number(item.timestamp) || 0,
      })).sort((a, b) => b.timestamp - a.timestamp));
      const hours = result.businessHours || {};
      const nextHoursAnnouncement = typeof hours.hoursAnnouncement === 'string' ? hours.hoursAnnouncement : '';
      setHoursAnnouncement(nextHoursAnnouncement);
      savedHoursAnnouncementRef.current = nextHoursAnnouncement;
      const nextWeekly = defaultWeeklySchedule();
      WEEK_DAYS.forEach(({ key }) => {
        const rawDay = hours[key];
        if (rawDay && typeof rawDay === 'object' && !Array.isArray(rawDay)) {
          const day = rawDay as Record<string, unknown>;
          nextWeekly[key] = {
            open: day.open !== false,
            start: typeof day.start === 'string' ? day.start : '13:00',
            end: typeof day.end === 'string' ? day.end : '20:00',
          };
        }
      });
      setWeeklyHours(nextWeekly);
      savedWeeklyHoursRef.current = Object.fromEntries(WEEK_DAYS.map(({ key }) => [key, { ...nextWeekly[key] }])) as WeeklySchedule;
      const specialNode = hours.specialDates && typeof hours.specialDates === 'object' && !Array.isArray(hours.specialDates)
        ? hours.specialDates as Record<string, unknown>
        : {};
      const loadedSpecialDates = objectEntries(specialNode, (dateKey, item) => ({
        dateKey,
        open: item.open !== false,
        start: typeof item.start === 'string' ? item.start : '13:00',
        end: typeof item.end === 'string' ? item.end : '20:00',
        reason: typeof item.reason === 'string' ? item.reason : '',
      })).filter((item) => isDateKey(item.dateKey)).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      savedSpecialDatesRef.current = Object.fromEntries(loadedSpecialDates.map((item) => [item.dateKey, { ...item }]));
      setSpecialDates(loadedSpecialDates);
      setRemovedSpecialDates([]);
      setMessage('已同步最新資料。');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '讀取內容失敗。');
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    const auth = getBrowserAuth();
    authRef.current = auth;
    void getRedirectResult(auth).catch((redirectError: unknown) => {
      setError(redirectError instanceof Error ? redirectError.message : 'Google 登入失敗。');
    });
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setMessage('');
      setError('');
      if (!currentUser) {
        setAdminClaim(null);
        setFlavors([]);
        setAnnouncements([]);
        setWeeklyHours(defaultWeeklySchedule());
        savedWeeklyHoursRef.current = defaultWeeklySchedule();
        setHoursAnnouncement('');
        savedHoursAnnouncementRef.current = '';
        setSpecialDates([]);
        setRemovedSpecialDates([]);
        savedSpecialDatesRef.current = {};
        setMemberResult(null);
        setMemberQuery('');
        setMemberError('');
        setMemberLoading(false);
        return;
      }
      try {
        const tokenResult = await currentUser.getIdTokenResult(true);
        const hasAdminClaim = tokenResult.claims.posAdmin === true;
        setAdminClaim(hasAdminClaim);
        if (hasAdminClaim) await loadContent(currentUser);
        else setError('此 Google 帳號沒有 posAdmin 權限；資料不會載入。請由系統管理員確認 Firebase custom claims。');
      } catch (authError) {
        setAdminClaim(false);
        setError(authError instanceof Error ? authError.message : '無法確認管理員權限。');
      }
    });
  }, [loadContent]);

  async function login() {
    if (!authRef.current) return;
    setBusy(true);
    setError('');
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
        await signInWithRedirect(authRef.current, provider);
      } else {
        await signInWithPopup(authRef.current, provider);
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Google 登入失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!authRef.current) return;
    setBusy(true);
    try {
      await signOut(authRef.current);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : '登出失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function lookupMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const requestedUid = user.uid;
    const query = memberQuery.trim();
    setMemberError('');
    setMemberResult(null);
    if (query.length < 3 || query.length > 120) {
      setMemberError('請輸入完整會員編號或電話（3 至 120 個字元）。');
      return;
    }
    setMemberLoading(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/admin/members', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({})) as MemberLookupResult;
      if (!response.ok || !result.member) throw new Error(result.error || `會員查詢失敗（${response.status}）`);
      if (authRef.current?.currentUser?.uid !== requestedUid) return;
      setMemberResult(result);
    } catch (lookupError) {
      if (authRef.current?.currentUser?.uid === requestedUid) {
        setMemberError(lookupError instanceof Error ? lookupError.message : '會員查詢失敗。');
      }
    } finally {
      setMemberLoading(false);
    }
  }

  function changeFlavor(index: number, patch: Partial<Flavor>) {
    setFlavors((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function moveFlavor(index: number, direction: -1 | 1) {
    setFlavors((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function changeDayHours(day: DayKey, patch: Partial<DaySchedule>) {
    setWeeklyHours((current) => ({ ...current, [day]: { ...current[day], ...patch } }));
  }

  function changeSpecialDate(dateKey: string, patch: Partial<SpecialDate>) {
    setSpecialDates((current) => current.map((item) => item.dateKey === dateKey ? { ...item, ...patch } : item));
  }

  function addSpecialDate() {
    setError('');
    setMessage('');
    if (!isDateKey(newSpecialDate)) {
      setError('請選擇有效的特殊日期。');
      return;
    }
    if (specialDates.some((item) => item.dateKey === newSpecialDate)) {
      setError('此日期已有特殊營業設定，請直接編輯清單中的項目。');
      return;
    }
    const newItem: SpecialDate = {
      dateKey: newSpecialDate,
      open: newSpecialOpen,
      start: newSpecialStart,
      end: newSpecialEnd,
      reason: newSpecialReason.trim(),
    };
    setSpecialDates((current) => [...current, newItem].sort((a, b) => a.dateKey.localeCompare(b.dateKey)));
    setRemovedSpecialDates((current) => current.filter((dateKey) => dateKey !== newSpecialDate));
    setNewSpecialReason('');
    setMessage('特殊日期已加入草稿，請儲存後才會套用。');
  }

  function removeSpecialDate(dateKey: string) {
    if (!window.confirm(`確定取消 ${dateKey} 的特殊日期設定？儲存後將改回每週排程。`)) return;
    setSpecialDates((current) => current.filter((item) => item.dateKey !== dateKey));
    if (savedSpecialDatesRef.current[dateKey]) {
      setRemovedSpecialDates((current) => current.includes(dateKey) ? current : [...current, dateKey]);
    }
    setMessage(`${dateKey} 已從草稿移除；請儲存後才會套用。`);
    setError('');
  }

  async function saveBusinessHours() {
    if (!user) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const weeklyPatch: Partial<WeeklySchedule> = {};
      WEEK_DAYS.forEach(({ key }) => {
        const current = weeklyHours[key];
        const saved = savedWeeklyHoursRef.current[key];
        if (current.open !== saved.open || current.start !== saved.start || current.end !== saved.end) {
          weeklyPatch[key] = current;
        }
      });
      const specialDateUpdates = specialDates.filter((item) => {
        const saved = savedSpecialDatesRef.current[item.dateKey];
        return !saved || item.open !== saved.open || item.start !== saved.start || item.end !== saved.end || item.reason !== saved.reason;
      });
      const hoursAnnouncementValue = hoursAnnouncement.trim();
      const hoursAnnouncementChanged = hoursAnnouncementValue !== savedHoursAnnouncementRef.current;
      if (!Object.keys(weeklyPatch).length && !specialDateUpdates.length && !removedSpecialDates.length && !hoursAnnouncementChanged) {
        setMessage('目前沒有尚未儲存的變更。');
        return;
      }
      await request(user, 'PUT', {
        kind: 'businessHours',
        weekly: weeklyPatch,
        specialDates: specialDateUpdates.map(({ dateKey, open, start, end, reason }) => ({ dateKey, open, start, end, reason })),
        removeSpecialDates: removedSpecialDates,
        ...(hoursAnnouncementChanged ? { hoursAnnouncement: hoursAnnouncementValue } : {}),
      });
      await loadContent(user);
      setMessage('營業時間公告、每週時段與特殊日期已更新。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '儲存營業時間失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function saveFlavors() {
    if (!user) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request(user, 'PUT', {
        kind: 'flavors',
        items: flavors.map(({ id, name, desc, soldOut }) => ({ id, name, desc, soldOut })),
      });
      await loadContent(user);
      setMessage(`今日口味已更新（${Number(result.itemCount) || flavors.length} 項）。顧客頁會同步讀取同一個 Firebase 節點。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '儲存今日口味失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function saveAnnouncements() {
    if (!user) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request(user, 'PUT', {
        kind: 'announcements',
        items: announcements.map(({ id, title, content, active }) => ({ id, title, content, active })),
      });
      await loadContent(user);
      setMessage(`營業公告已更新（${Number(result.itemCount) || announcements.length} 項）。顧客公告頁會同步讀取同一個 Firebase 節點。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '儲存營業公告失敗。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href="/" aria-label="OMG Gelato 首頁">
            <span className={styles.brandMark}>OMG</span>
            <span><strong>OMG! Gelato</strong><small>營運管理中心</small></span>
          </Link>
          {user && <div className={styles.account}><span>{user.displayName || user.email}</span><button type="button" className={styles.textButton} onClick={logout} disabled={busy}>登出</button></div>}
        </header>

        <section className={styles.intro}>
          <p className={styles.eyebrow}>STORE CONTENT · ADMIN ONLY</p>
          <h1>店務內容與營業時間</h1>
          <p>公告、今日口味和營業排程會同步至顧客端。營業時間分頁只管理門市時段與特殊日期，不會變更線上接單模式。</p>
        </section>

        {!user ? (
          <section className={styles.loginCard}>
            <div className={styles.lockIcon} aria-hidden="true">A</div>
            <div><h2>管理員登入</h2><p>請使用已設定 <code>posAdmin</code> 權限的 POS Google 帳號。權限由伺服器再次驗證。</p></div>
            <button type="button" className={styles.primaryButton} onClick={login} disabled={busy}>{busy ? '登入中…' : '使用 Google 登入'}</button>
          </section>
        ) : !adminClaim ? (
          <section className={styles.loginCard}>
            <div className={styles.lockIcon} aria-hidden="true">!</div>
            <div><h2>此帳號尚未授權</h2><p>已登入 {user.email || 'Google 帳號'}，但沒有 <code>posAdmin: true</code> 權限。請改用已授權帳號，或請系統管理員設定 Firebase custom claims。</p></div>
            <button type="button" className={styles.secondaryButton} onClick={logout} disabled={busy}>切換帳號</button>
          </section>
        ) : (
          <>
            <nav className={styles.tabs} aria-label="管理分頁">
              <button type="button" className={tab === 'flavors' ? styles.activeTab : ''} onClick={() => setTab('flavors')}>今日口味 <span>{flavors.length}</span></button>
              <button type="button" className={tab === 'announcements' ? styles.activeTab : ''} onClick={() => setTab('announcements')}>營業公告 <span>{announcements.length}</span></button>
              <button type="button" className={tab === 'hours' ? styles.activeTab : ''} onClick={() => setTab('hours')}>營業時間 <span>{specialDates.length}</span></button>
              <button type="button" className={tab === 'members' ? styles.activeTab : ''} onClick={() => setTab('members')}>會員資料</button>
            </nav>

            {tab === 'flavors' ? (
              <section className={styles.panel}>
                <div className={styles.panelHeading}><div><p className={styles.eyebrow}>TODAY’S FLAVORS</p><h2>今日口味</h2><p>名稱、說明、售完狀態與顯示順序會同步到點餐頁。</p></div><button type="button" className={styles.secondaryButton} onClick={() => void loadContent(user)} disabled={loading || busy}>{loading ? '載入中…' : '重新載入'}</button></div>
                <div className={styles.list}>
                  {flavors.map((flavor, index) => (
                    <article className={styles.itemCard} key={flavor.id || `new-flavor-${index}`}>
                      <div className={styles.itemNumber}>{String(index + 1).padStart(2, '0')}</div>
                      <div className={styles.itemFields}>
                        <label>口味名稱<input maxLength={80} value={flavor.name} onChange={(event) => changeFlavor(index, { name: event.target.value })} placeholder="例如：開心果" /></label>
                        <label>口味說明<input maxLength={240} value={flavor.desc} onChange={(event) => changeFlavor(index, { desc: event.target.value })} placeholder="選填，例如：義大利開心果製作" /></label>
                      </div>
                      <div className={styles.itemActions}><label className={styles.checkLabel}><input type="checkbox" checked={flavor.soldOut} onChange={(event) => changeFlavor(index, { soldOut: event.target.checked })} />售完</label><button type="button" aria-label="上移" onClick={() => moveFlavor(index, -1)} disabled={index === 0}>↑</button><button type="button" aria-label="下移" onClick={() => moveFlavor(index, 1)} disabled={index === flavors.length - 1}>↓</button></div>
                    </article>
                  ))}
                  {!flavors.length && <div className={styles.empty}>目前沒有口味項目，新增後即可顯示於顧客頁。</div>}
                </div>
                <div className={styles.panelFooter}><button type="button" className={styles.textButton} onClick={() => setFlavors((current) => [...current, { id: '', name: '', desc: '', soldOut: false, sortOrder: current.length }])} disabled={busy}>＋ 新增口味</button><button type="button" className={styles.primaryButton} onClick={() => void saveFlavors()} disabled={busy || loading}>{busy ? '儲存中…' : '儲存今日口味'}</button></div>
              </section>
            ) : tab === 'announcements' ? (
              <section className={styles.panel}>
                <div className={styles.panelHeading}><div><p className={styles.eyebrow}>STORE ANNOUNCEMENTS</p><h2>營業公告</h2><p>可發布店休、營業異動或一般公告；停用的公告會保留但不顯示。</p></div><button type="button" className={styles.secondaryButton} onClick={() => void loadContent(user)} disabled={loading || busy}>{loading ? '載入中…' : '重新載入'}</button></div>
                <div className={styles.list}>
                  {announcements.map((announcement, index) => (
                    <article className={`${styles.itemCard} ${styles.announcementCard}`} key={announcement.id || `new-announcement-${index}`}>
                      <div className={styles.itemNumber}>{String(index + 1).padStart(2, '0')}</div>
                      <div className={styles.itemFields}>
                        <label>公告標題<input maxLength={120} value={announcement.title} onChange={(event) => setAnnouncements((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} placeholder="例如：本週營業時間調整" /></label>
                        <label>公告內容<textarea maxLength={2000} rows={3} value={announcement.content} onChange={(event) => setAnnouncements((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item))} placeholder="輸入顧客需要知道的公告內容" /></label>
                      </div>
                      <label className={styles.checkLabel}><input type="checkbox" checked={announcement.active} onChange={(event) => setAnnouncements((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, active: event.target.checked } : item))} />顯示</label>
                    </article>
                  ))}
                  {!announcements.length && <div className={styles.empty}>目前沒有公告，新增後可發布店休或營業資訊。</div>}
                </div>
                <div className={styles.panelFooter}><button type="button" className={styles.textButton} onClick={() => setAnnouncements((current) => [{ id: '', title: '', content: '', active: true, timestamp: Date.now() }, ...current])} disabled={busy}>＋ 新增公告</button><button type="button" className={styles.primaryButton} onClick={() => void saveAnnouncements()} disabled={busy || loading}>{busy ? '儲存中…' : '儲存營業公告'}</button></div>
              </section>
            ) : tab === 'hours' ? (
              <section className={styles.panel}>
                <div className={styles.panelHeading}><div><p className={styles.eyebrow}>STORE HOURS & EXCEPTIONS</p><h2>營業時間／特殊日期</h2><p>設定每週常態營業時段，並以指定日期覆蓋為臨時店休或特別營業。</p></div><button type="button" className={styles.secondaryButton} onClick={() => void loadContent(user)} disabled={loading || busy}>{loading ? '載入中…' : '重新載入'}</button></div>
                <div className={styles.hoursNote}>這裡調整的是門市實際營業時間。線上接單暫停／截止模式（shopMode）不會被這個表單修改。</div>

                <section className={styles.hoursAnnouncementEditor} aria-labelledby="hours-announcement-heading">
                  <div className={styles.sectionHeading}><div><h3 id="hours-announcement-heading">營業時間公告（獨立欄位）</h3><p>與「營業公告」清單分開；內容會顯示在顧客端會員中心首頁，不影響每週排程、店休日或接單模式。</p></div></div>
                  <label htmlFor="hours-announcement-content">公告內容
                    <textarea id="hours-announcement-content" maxLength={500} rows={3} value={hoursAnnouncement} onChange={(event) => setHoursAnnouncement(event.target.value)} placeholder="例如：本週五營業時間調整為 15:00–20:00，造成不便敬請見諒。" />
                  </label>
                  <div className={styles.hoursAnnouncementMeta}><span>{hoursAnnouncement.length}/500 字</span><span>清空內容並儲存即可移除公告</span></div>
                </section>

                <section className={styles.scheduleSection} aria-labelledby="weekly-hours-heading">
                  <div className={styles.sectionHeading}><div><h3 id="weekly-hours-heading">每週營業時間</h3><p>未設定的時段依目前系統預設 13:00–20:00。</p></div></div>
                  <div className={styles.weeklyGrid}>
                    {WEEK_DAYS.map(({ key, label }) => {
                      const schedule = weeklyHours[key];
                      return (
                        <div className={styles.weekdayRow} key={key}>
                          <strong className={styles.dayName}>{label}</strong>
                          <label className={styles.openToggle}><input type="checkbox" checked={schedule.open} onChange={(event) => changeDayHours(key, { open: event.target.checked })} />營業</label>
                          <div className={styles.timeInputs}>
                            <input type="time" step={1800} aria-label={`${label}開始時間`} value={schedule.start} disabled={!schedule.open} onChange={(event) => changeDayHours(key, { start: event.target.value })} />
                            <span>至</span>
                            <input type="time" step={1800} aria-label={`${label}結束時間`} value={schedule.end} disabled={!schedule.open} onChange={(event) => changeDayHours(key, { end: event.target.value })} />
                          </div>
                          <span className={schedule.open ? styles.openBadge : styles.closedBadge}>{schedule.open ? '營業中' : '固定公休'}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className={styles.scheduleSection} aria-labelledby="special-dates-heading">
                  <div className={styles.sectionHeading}><div><h3 id="special-dates-heading">特殊店休日／特別營業</h3><p>特殊日期會覆蓋該日的每週排程；移除後即恢復每週設定。</p></div></div>
                  <div className={styles.specialAdd}>
                    <label>日期<input type="date" min={taipeiToday()} value={newSpecialDate} onChange={(event) => setNewSpecialDate(event.target.value)} /></label>
                    <label>當日安排<select value={newSpecialOpen ? 'open' : 'closed'} onChange={(event) => setNewSpecialOpen(event.target.value === 'open')}><option value="closed">臨時店休</option><option value="open">特別營業</option></select></label>
                    {newSpecialOpen && <div className={styles.timeInputs}><label>開始<input type="time" step={1800} value={newSpecialStart} onChange={(event) => setNewSpecialStart(event.target.value)} /></label><label>結束<input type="time" step={1800} value={newSpecialEnd} onChange={(event) => setNewSpecialEnd(event.target.value)} /></label></div>}
                    <label className={styles.reasonField}>原因／備註<input maxLength={240} value={newSpecialReason} onChange={(event) => setNewSpecialReason(event.target.value)} placeholder="例如：設備保養、節日延長營業" /></label>
                    <button type="button" className={styles.secondaryButton} onClick={addSpecialDate} disabled={busy}>＋ 加入日期</button>
                  </div>

                  <div className={styles.specialDateList}>
                    {specialDates.map((item) => (
                      <article className={styles.specialDateCard} key={item.dateKey}>
                        <div className={styles.specialDateTop}><strong>{item.dateKey}</strong><button type="button" className={styles.dangerButton} onClick={() => removeSpecialDate(item.dateKey)} disabled={busy}>取消設定</button></div>
                        <div className={styles.specialDateFields}>
                          <label>安排<select value={item.open ? 'open' : 'closed'} onChange={(event) => changeSpecialDate(item.dateKey, { open: event.target.value === 'open' })}><option value="closed">臨時店休</option><option value="open">特別營業</option></select></label>
                          {item.open && <div className={styles.timeInputs}><label>開始<input type="time" step={1800} value={item.start} onChange={(event) => changeSpecialDate(item.dateKey, { start: event.target.value })} /></label><label>結束<input type="time" step={1800} value={item.end} onChange={(event) => changeSpecialDate(item.dateKey, { end: event.target.value })} /></label></div>}
                          <label className={styles.reasonField}>原因／備註<input maxLength={240} value={item.reason} onChange={(event) => changeSpecialDate(item.dateKey, { reason: event.target.value })} placeholder="選填" /></label>
                        </div>
                      </article>
                    ))}
                    {!specialDates.length && <div className={styles.empty}>目前沒有特殊日期；顧客端會依每週排程計算營業狀態。</div>}
                  </div>
                </section>

                <div className={styles.panelFooter}><span className={styles.pendingNote}>{removedSpecialDates.length ? `待取消 ${removedSpecialDates.length} 個特殊日期` : '修改尚未套用，請儲存後發布'}</span><button type="button" className={styles.primaryButton} onClick={() => void saveBusinessHours()} disabled={busy || loading}>{busy ? '儲存中…' : '儲存營業時間'}</button></div>
              </section>
            ) : (
              <section className={styles.panel}>
                <div className={styles.panelHeading}><div><p className={styles.eyebrow}>MEMBER LOOKUP · ADMIN ONLY</p><h2>會員資料查詢</h2><p>僅能精確查詢單一會員；此頁唯讀，不提供會員名單或資料修改。</p></div></div>
                <form className={styles.memberSearch} onSubmit={(event) => void lookupMember(event)}>
                  <label htmlFor="member-lookup-query">會員編號或完整電話
                    <input id="member-lookup-query" type="search" autoComplete="off" maxLength={120} value={memberQuery} onChange={(event) => { setMemberQuery(event.target.value); setMemberResult(null); setMemberError(''); }} placeholder="輸入完整會員編號或已登記電話" />
                  </label>
                  <button type="submit" className={styles.primaryButton} disabled={memberLoading}>{memberLoading ? '查詢中…' : '查詢會員'}</button>
                  {memberQuery && <button type="button" className={styles.textButton} onClick={() => { setMemberQuery(''); setMemberResult(null); setMemberError(''); }}>清除</button>}
                </form>
                <p className={styles.memberPrivacy}>只接受完整會員編號／電話，不做模糊搜尋；電話會遮罩顯示。LINE 身分識別碼與登入 token 不會回傳。</p>
                {memberError && <div role="alert" className={styles.memberError}>{memberError}</div>}

                {memberResult?.member && (
                  <>
                    <article className={styles.memberProfile}>
                      <div className={styles.memberProfileHead}>
                        <div><p className={styles.eyebrow}>MEMBER PROFILE</p><h3>{memberResult.member.displayName}</h3><span className={styles.memberType}>{memberResult.member.memberType === 'line' ? 'LINE 會員' : memberResult.member.memberType === 'guest' ? '現場會員' : memberResult.member.memberType}</span></div>
                        <strong className={styles.memberNumber}>{memberResult.member.memberNo}</strong>
                      </div>
                      <dl className={styles.memberFacts}>
                        <div><dt>電話</dt><dd>{memberResult.member.phone}</dd></div>
                        <div><dt>目前點數</dt><dd className={styles.memberBalance}>{formatAmount(memberResult.member.pointsBalance)} 點</dd></div>
                        <div><dt>加入時間</dt><dd>{formatTaipeiTimestamp(memberResult.member.createdAt)}</dd></div>
                        <div><dt>點數更新時間</dt><dd>{formatTaipeiTimestamp(memberResult.member.pointsUpdatedAt)}</dd></div>
                      </dl>
                    </article>

                    <div className={styles.memberHistoryGrid}>
                      <section className={styles.memberRecordPanel} aria-labelledby="member-points-heading">
                        <div className={styles.memberRecordHeading}><h3 id="member-points-heading">最近點數紀錄</h3><span>最多 20 筆</span></div>
                        {memberResult.recentPoints?.length ? <ul className={styles.memberRecordList}>{memberResult.recentPoints.map((entry, index) => (
                          <li className={styles.memberRecordRow} key={`${entry.createdAt}-${entry.orderNo || index}`}>
                            <div><strong>{entry.sourceLabel || entry.type}</strong><small>{formatTaipeiTimestamp(entry.createdAt)}{entry.orderNo ? ` · 訂單 ${entry.orderNo}` : ''}</small></div>
                            <b className={entry.delta >= 0 ? styles.pointsPositive : styles.pointsNegative}>{entry.delta > 0 ? '+' : ''}{formatAmount(entry.delta)}</b>
                          </li>
                        ))}</ul> : <div className={styles.memberEmpty}>尚無點數流水紀錄。</div>}
                      </section>

                      <section className={styles.memberRecordPanel} aria-labelledby="member-orders-heading">
                        <div className={styles.memberRecordHeading}><h3 id="member-orders-heading">最近訂單</h3><span>最多 20 筆</span></div>
                        {memberResult.recentOrders?.length ? <ul className={styles.memberRecordList}>{memberResult.recentOrders.map((order, index) => (
                          <li className={styles.memberOrderRow} key={`${order.orderNo}-${order.timestamp}-${index}`}>
                            <div className={styles.memberOrderTop}><strong>{order.orderNo}</strong><b>NT$ {formatAmount(order.total)}</b></div>
                            <small>{formatTaipeiTimestamp(order.timestamp)} · {order.status || '狀態未記錄'} · {order.paymentStatus || '付款狀態未記錄'}</small>
                            <p>{order.items.length ? order.items.map((item) => `${item.name} × ${item.quantity}`).join('、') : '無商品明細'}</p>
                          </li>
                        ))}</ul> : <div className={styles.memberEmpty}>尚無可對應的訂單。</div>}
                      </section>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}

        {(error || message) && <div role={error ? 'alert' : 'status'} className={error ? styles.error : styles.success}>{error || message}</div>}
        <footer className={styles.footer}><span>資料儲存於 OMG Gelato Firebase Realtime Database</span><span>每次修改均限制為已授權管理員</span></footer>
      </div>
    </main>
  );
}
