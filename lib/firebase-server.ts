import { randomUUID } from 'node:crypto';

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';

function databaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL).replace(/\/$/, '');
}

async function firebaseRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${databaseUrl()}/${path.replace(/^\//, '')}.json`, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!response.ok) throw new Error(`Firebase 讀寫失敗（${response.status}）`);
  return await response.json() as T;
}

export async function firebaseGet<T>(path: string) {
  return firebaseRequest<T>(path, { method: 'GET' });
}

export async function firebasePost<T>(path: string, value: unknown) {
  return firebaseRequest<T>(path, { method: 'POST', body: JSON.stringify(value) });
}

export async function firebasePut<T>(path: string, value: unknown) {
  return firebaseRequest<T>(path, { method: 'PUT', body: JSON.stringify(value) });
}

export async function firebasePatch<T>(path: string, value: unknown) {
  return firebaseRequest<T>(path, { method: 'PATCH', body: JSON.stringify(value) });
}

export async function reservePickupCode(dateKey: string) {
  const path = `dailyPickupCodes/${encodeURIComponent(dateKey)}`;
  const existing = await firebaseGet<Record<string, unknown> | null>(path) || {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = String(Math.floor(100 + Math.random() * 900));
    if (existing[code]) continue;
    await firebasePut(`${path}/${code}`, { createdAt: new Date().toISOString(), reservationId: randomUUID() });
    return code;
  }
  throw new Error('今日可用取餐號碼不足');
}
