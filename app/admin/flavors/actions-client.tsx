'use client';

import { useCallback, useState } from 'react';
import { useLIFF } from '@/providers/liff-providers';
import styles from './page.module.css';

type Operation = 'sell-out' | 'restore';
type ApiResponse = { success?: boolean; error?: string; updatedCount?: number; action?: string };

const OPERATIONS: Record<Operation, {
  endpoint: string;
  confirmation: string;
  confirmMessage: string;
  label: string;
}> = {
  'sell-out': {
    endpoint: '/api/admin/flavors/sold-out',
    confirmation: 'SELL_OUT_ALL',
    confirmMessage: '確定要將今日所有口味全部下架嗎？顧客將無法選購這些口味。',
    label: '全部下架',
  },
  restore: {
    endpoint: '/api/admin/flavors/restore',
    confirmation: 'RESTORE_ALL',
    confirmMessage: '確定要將今日所有口味恢復供應嗎？',
    label: '全部上架（恢復供應）',
  },
};

export default function FlavorActionsClient() {
  const { liff, isLoading, liffError } = useLIFF();
  const isLoggedIn = Boolean(liff && !isLoading && liff.isLoggedIn());
  const [busy, setBusy] = useState<Operation | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const login = useCallback(() => {
    if (!liff) return;
    liff.login({ redirectUri: window.location.href });
  }, [liff]);

  const runOperation = useCallback(async (operation: Operation) => {
    const config = OPERATIONS[operation];
    if (!liff || !isLoggedIn || busy) return;
    if (!window.confirm(config.confirmMessage)) return;

    setBusy(operation);
    setMessage('');
    setError('');
    try {
      const idToken = liff.getIDToken();
      if (!idToken) {
        throw new Error('LIFF 尚未提供 ID Token。請確認此 LIFF App 已啟用並取得 openid scope，然後重新登入。');
      }

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirmation: config.confirmation }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({})) as ApiResponse;
      if (!response.ok || result.success !== true) {
        throw new Error(result.error || `操作失敗（HTTP ${response.status}）。`);
      }

      const actionLabel = operation === 'sell-out' ? '下架' : '恢復供應';
      setMessage(`完成：${result.updatedCount ?? 0} 種口味已${actionLabel}。`);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : '操作失敗，請稍後再試。');
    } finally {
      setBusy(null);
    }
  }, [busy, isLoggedIn, liff]);

  return (
    <main className={styles.page}>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>OMG! GELATO · 管理工具</p>
        <h1>今日口味供應管理</h1>
        <p className={styles.intro}>批次操作會立即更新顧客端今日口味。每次操作前都會再次確認。</p>

        {isLoading ? (
          <div className={styles.notice}>正在初始化 LINE 登入…</div>
        ) : liffError ? (
          <div className={styles.error} role="alert">LIFF 初始化失敗：{liffError}</div>
        ) : !liff ? (
          <div className={styles.notice}>LIFF 尚未就緒，請重新開啟此頁。</div>
        ) : !isLoggedIn ? (
          <div className={styles.authBox}>
            <p>請先使用已加入管理員白名單的 LINE 帳號登入。</p>
            <button type="button" className={styles.loginButton} onClick={login}>使用 LINE 登入</button>
          </div>
        ) : (
          <>
            <div className={styles.authBadge}><span />LINE 已登入；管理權限將由伺服器確認</div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.restoreButton}
                onClick={() => void runOperation('restore')}
                disabled={busy !== null}
              >
                {busy === 'restore' ? '處理中…' : '全部上架（恢復供應）'}
              </button>
              <button
                type="button"
                className={styles.sellOutButton}
                onClick={() => void runOperation('sell-out')}
                disabled={busy !== null}
              >
                {busy === 'sell-out' ? '處理中…' : '全部下架'}
              </button>
            </div>
            <p className={styles.securityNote}>按鈕需要有效的 LINE ID Token。若帳號不在管理員白名單，伺服器會拒絕操作。</p>
          </>
        )}

        {message && <p className={styles.success} role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
      <p className={styles.footer}>此頁僅提供批次供應狀態操作；其他口味資料請至管理中心編輯。</p>
    </main>
  );
}
