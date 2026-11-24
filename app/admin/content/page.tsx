'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
type ApiResult = { success?: boolean; error?: string; itemCount?: number; todayFlavors?: Record<string, unknown>; announcements?: Record<string, unknown> };

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
  const [tab, setTab] = useState<'flavors' | 'announcements'>('flavors');
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
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
          <h1>公告與今日口味</h1>
          <p>在此更新後，顧客端會從既有 Firebase 節點即時讀取。儲存僅更新管理欄位，保留其他資料，不會直接刪除現有項目。</p>
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
            <nav className={styles.tabs} aria-label="內容類型">
              <button type="button" className={tab === 'flavors' ? styles.activeTab : ''} onClick={() => setTab('flavors')}>今日口味 <span>{flavors.length}</span></button>
              <button type="button" className={tab === 'announcements' ? styles.activeTab : ''} onClick={() => setTab('announcements')}>營業公告 <span>{announcements.length}</span></button>
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
            ) : (
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
            )}
          </>
        )}

        {(error || message) && <div role={error ? 'alert' : 'status'} className={error ? styles.error : styles.success}>{error || message}</div>}
        <footer className={styles.footer}><span>資料儲存於 OMG Gelato Firebase Realtime Database</span><span>每次修改均限制為已授權管理員</span></footer>
      </div>
    </main>
  );
}
