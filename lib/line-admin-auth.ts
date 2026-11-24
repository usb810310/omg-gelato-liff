const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const MAX_TOKEN_LENGTH = 8192;

type LineIdTokenClaims = {
  sub?: unknown;
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
};

export class LineAdminAuthError extends Error {
  constructor(message: string, readonly statusCode: 401 | 403 | 503) {
    super(message);
    this.name = 'LineAdminAuthError';
  }
}

function getAdminLineUserIds() {
  return new Set(
    (process.env.LINE_ADMIN_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Verifies the caller's LIFF ID token with LINE and returns the allowlisted LINE user ID.
 * Keep LINE_CHANNEL_ID and LINE_ADMIN_USER_IDS server-only; never use NEXT_PUBLIC_ names.
 */
export async function requireLineAdmin(request: Request): Promise<string> {
  const channelId = process.env.LINE_CHANNEL_ID?.trim();
  const allowedUserIds = getAdminLineUserIds();
  if (!channelId || allowedUserIds.size === 0) {
    throw new LineAdminAuthError('管理員驗證尚未設定。請設定 LINE_CHANNEL_ID 與 LINE_ADMIN_USER_IDS。', 503);
  }

  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new LineAdminAuthError('缺少有效的 LINE ID Token。', 401);
  }

  const body = new URLSearchParams({ id_token: token, client_id: channelId });
  let response: Response;
  try {
    response = await fetch(LINE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new LineAdminAuthError('目前無法連線至 LINE 驗證服務，請稍後再試。', 503);
  }

  if (!response.ok) {
    throw new LineAdminAuthError('LINE 登入憑證無效或已過期，請重新登入。', 401);
  }

  const claims = await response.json().catch(() => null) as LineIdTokenClaims | null;
  const userId = typeof claims?.sub === 'string' ? claims.sub : '';
  const expiration = Number(claims?.exp);
  if (
    !userId ||
    claims?.aud !== channelId ||
    claims?.iss !== 'https://access.line.me' ||
    !Number.isFinite(expiration) ||
    expiration <= Math.floor(Date.now() / 1000)
  ) {
    throw new LineAdminAuthError('LINE 身分憑證資料不完整或驗證失敗。', 401);
  }

  if (!allowedUserIds.has(userId)) {
    throw new LineAdminAuthError('此 LINE 帳號沒有執行管理操作的權限。', 403);
  }

  return userId;
}
