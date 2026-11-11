import { adminDatabaseRef } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// This route is temporary and will be removed immediately after the one-time cleanup.
const ONE_TIME_TOKEN = 'omg-reset-20261111-7c1f6c0a4f8b4e4e9d2a1f6b8c3d5e7a';

type Account = {
  balance?: unknown;
  entries?: Record<string, unknown>;
  rewardVouchers?: Record<string, { status?: unknown } & Record<string, unknown>>;
  [key: string]: unknown;
};

function authorized(request: Request) {
  return request.headers.get('x-omg-one-time-reset-token') === ONE_TIME_TOKEN;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { execute?: boolean };
  const snapshot = await adminDatabaseRef('memberPoints').get();
  const accounts = (snapshot.val() || {}) as Record<string, Account>;

  let memberCount = 0;
  let totalBalance = 0;
  let issuedVoucherCount = 0;
  let redeemedVoucherCount = 0;
  const updates: Record<string, unknown> = {};

  for (const [memberKey, rawAccount] of Object.entries(accounts)) {
    const account = rawAccount || {};
    memberCount += 1;
    const balance = Number(account.balance || 0);
    if (Number.isFinite(balance)) totalBalance += balance;

    const vouchers = account.rewardVouchers || {};
    const keptVouchers: Record<string, unknown> = {};
    for (const [voucherId, voucher] of Object.entries(vouchers)) {
      if (String(voucher?.status || '').toLowerCase() === 'issued') issuedVoucherCount += 1;
      else {
        redeemedVoucherCount += 1;
        keptVouchers[voucherId] = voucher;
      }
    }

    if (body.execute === true) {
      updates[`memberPoints/${memberKey}/balance`] = 0;
      updates[`memberPoints/${memberKey}/updatedAt`] = Date.now();
      updates[`memberPoints/${memberKey}/rewardVouchers`] = Object.keys(keptVouchers).length ? keptVouchers : null;
    }
  }

  if (body.execute === true && Object.keys(updates).length) {
    await adminDatabaseRef('').update(updates);
  }

  return Response.json({
    ok: true,
    executed: body.execute === true,
    memberCount,
    totalBalanceBefore: totalBalance,
    issuedVoucherCountBefore: issuedVoucherCount,
    redeemedVoucherCountPreserved: redeemedVoucherCount,
    updatedPaths: body.execute === true ? Object.keys(updates).length : 0,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
