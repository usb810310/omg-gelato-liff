import { NextResponse } from 'next/server';
import { adminDatabaseRef } from '@/lib/firebase-admin';
import { requirePosStaff } from '@/lib/pos-auth';
import { DEFAULT_POS_POINT_RULES, parsePosPointRules } from '@/lib/pos-point-rules';

export const runtime = 'nodejs';

const ALLOWED_ORIGINS = new Set([
  'https://omg-pos-systems.pages.dev',
  'https://main.omg-pos-systems.pages.dev',
]);

function corsHeaders(request?: Request) {
  const origin = request?.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://omg-pos-systems.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request: Request, body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' },
  });
}

async function requirePosAdmin(request: Request) {
  const user = await requirePosStaff(request);
  if (user.posAdmin !== true) {
    const error = new Error('只有 POS 管理員可以調整點數倍率');
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
  return user;
}

function errorStatus(error: unknown) {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (statusCode === 403) return 403;
  }
  return /登入|權限/.test(error instanceof Error ? error.message : '') ? 401 : 500;
}

function normalizeAudit(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const entries: Array<Record<string, unknown>> = Object.entries(value as Record<string, unknown>)
    .map(([id, item]): Record<string, unknown> => ({ id, ...(item && typeof item === 'object' ? item as Record<string, unknown> : {}) }));
  return entries
    .sort((a, b) => Number(b.changedAt || 0) - Number(a.changedAt || 0))
    .slice(0, 10);
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  try {
    const user = await requirePosAdmin(request);
    const snapshot = await adminDatabaseRef('posPointSettings').get();
    const root = snapshot.val() as { current?: unknown; audit?: unknown } | null;
    const config = root?.current ? parsePosPointRules(root.current) : DEFAULT_POS_POINT_RULES;
    return json(request, {
      success: true,
      config,
      metadata: root?.current && typeof root.current === 'object'
        ? {
            updatedAt: Number((root.current as Record<string, unknown>).updatedAt || 0),
            updatedBy: String((root.current as Record<string, unknown>).updatedBy || ''),
            changeReason: String((root.current as Record<string, unknown>).changeReason || ''),
          }
        : { updatedAt: 0, updatedBy: 'system', changeReason: '雙11預設活動' },
      history: normalizeAudit(root?.audit),
      operator: { uid: String(user.uid || ''), email: String(user.email || '') },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '讀取點數倍率設定失敗';
    return json(request, { success: false, error: message }, errorStatus(error));
  }
}

export async function POST(request: Request) {
  try {
    const operator = await requirePosAdmin(request);
    const payload: unknown = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(request, { success: false, error: '點數倍率設定內容無效' }, 400);
    }
    const body = payload as Record<string, unknown>;
    let config: ReturnType<typeof parsePosPointRules>;
    try {
      config = parsePosPointRules(body.config);
    } catch (error) {
      return json(request, { success: false, error: error instanceof Error ? error.message : '點數倍率設定格式錯誤' }, 400);
    }
    const reason = String(body.reason || '').trim();
    if (!reason || reason.length > 200) {
      return json(request, { success: false, error: '請填寫 1 至 200 個字元的調整原因' }, 400);
    }

    const changedAt = Date.now();
    const rootRef = adminDatabaseRef('posPointSettings');
    const auditKey = rootRef.child('audit').push().key;
    if (!auditKey) throw new Error('無法建立點數倍率稽核編號');
    const storedConfig = {
      ...config,
      updatedAt: changedAt,
      updatedBy: String(operator.email || operator.uid || 'POS 管理員'),
      changeReason: reason,
    };
    const auditEntry = {
      changedAt,
      changedBy: { uid: String(operator.uid || ''), email: String(operator.email || '') },
      reason,
      config: storedConfig,
    };

    const result = await rootRef.transaction((current) => {
      const root = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : {};
      const audit = root.audit && typeof root.audit === 'object'
        ? root.audit as Record<string, Record<string, unknown>>
        : {};
      const nextAudit: Record<string, Record<string, unknown>> = {
        ...audit,
        [auditKey]: { ...auditEntry, previousConfig: root.current || DEFAULT_POS_POINT_RULES },
      };
      const ordered = Object.entries(nextAudit).sort((a, b) => Number(a[1]?.changedAt || 0) - Number(b[1]?.changedAt || 0));
      while (ordered.length > 100) {
        const [oldestKey] = ordered.shift() || [];
        if (oldestKey) delete nextAudit[oldestKey];
      }
      return { ...root, current: storedConfig, audit: nextAudit };
    });
    if (!result.committed) throw new Error('設定更新未完成，請重新整理後再試');

    return json(request, { success: true, config, metadata: { updatedAt: changedAt, updatedBy: storedConfig.updatedBy, changeReason: reason } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '儲存點數倍率設定失敗';
    return json(request, { success: false, error: message }, errorStatus(error));
  }
}
