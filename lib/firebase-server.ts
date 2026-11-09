import { randomUUID } from 'node:crypto';
import { adminDatabaseRef } from '@/lib/firebase-admin';

export async function firebaseGet<T>(path: string) {
  return await adminDatabaseRef(path).get().then(snapshot => snapshot.val() as T);
}

export async function firebasePost<T>(path: string, value: unknown) {
  const result = await adminDatabaseRef(path).push(value);
  return { name: result.key } as T;
}

export async function firebasePut<T>(path: string, value: unknown) {
  await adminDatabaseRef(path).set(value);
  return value as T;
}

export async function firebasePatch<T>(path: string, value: unknown) {
  await adminDatabaseRef(path).update(value as Record<string, unknown>);
  return value as T;
}

export async function reservePickupCode(dateKey: string) {
  const parent = adminDatabaseRef(`dailyPickupCodes/${dateKey}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = String(Math.floor(100 + Math.random() * 900));
    const candidate = parent.child(code);
    const result = await candidate.transaction(current => current || {
      createdAt: new Date().toISOString(),
      reservationId: randomUUID(),
    });
    if (result.committed) return code;
  }
  throw new Error('今日可用取餐號碼不足');
}
