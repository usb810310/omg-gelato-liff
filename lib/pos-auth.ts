import { getFirebaseAdminAuth } from '@/lib/firebase-admin';

export async function requirePosStaff(request: Request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 8192) throw new Error('POS 登入已失效，請重新登入');
  const decoded = await getFirebaseAdminAuth().verifyIdToken(token);
  if (decoded.posStaff !== true && decoded.posAdmin !== true) throw new Error('目前帳號沒有 POS 操作權限');
  return decoded;
}
