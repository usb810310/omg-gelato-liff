import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';

const DEFAULT_DATABASE_URL = 'https://omg-menu-5761a-default-rtdb.asia-southeast1.firebasedatabase.app';
let cachedApp: App | null = null;
let cachedDatabase: Database | null = null;

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key.replace(/\\n/g, '\n') };
      }
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON 格式無效');
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) return { projectId, clientEmail, privateKey };
  throw new Error('Firebase Admin SDK 尚未設定服務帳號，請設定 FIREBASE_SERVICE_ACCOUNT_JSON，或 FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY');
}

export function getFirebaseAdminApp() {
  if (cachedApp) return cachedApp;
  const existing = getApps()[0];
  if (existing) {
    cachedApp = existing;
    return cachedApp;
  }
  const account = serviceAccount();
  cachedApp = initializeApp({
    credential: cert(account),
    databaseURL: process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL,
  });
  return cachedApp;
}

export function getFirebaseAdminDatabase() {
  if (!cachedDatabase) cachedDatabase = getDatabase(getFirebaseAdminApp());
  return cachedDatabase;
}

export function adminDatabaseRef(path: string) {
  return getFirebaseAdminDatabase().ref(path.replace(/^\/+/, ''));
}
