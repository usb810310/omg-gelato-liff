export type PointChannelRules = {
  standardMultiplier: number;
  campaign: {
    enabled: boolean;
    name: string;
    multiplier: number;
    startAt: number;
    endAt: number;
  };
  manualOverride: {
    enabled: boolean;
    multiplier: number;
    startAt: number;
    endAt: number;
    reason: string;
  };
};

export type PosPointRules = {
  online: PointChannelRules;
  pos: PointChannelRules;
};

export type ResolvedPosPointMultiplier = {
  multiplier: number;
  source: 'manual' | 'campaign' | 'standard';
  label: string;
};

export const DOUBLE_11_CAMPAIGN_START_AT = Date.parse('2026-11-10T16:00:00.000Z');
export const DOUBLE_11_CAMPAIGN_END_AT = Date.parse('2026-11-11T16:00:00.000Z');

function channelDefaults(channel: 'online' | 'pos'): PointChannelRules {
  return {
    standardMultiplier: 1,
    campaign: {
      enabled: channel === 'online',
      name: channel === 'online' ? '雙11線上限定' : '門市活動',
      multiplier: channel === 'online' ? 2 : 1,
      startAt: DOUBLE_11_CAMPAIGN_START_AT,
      endAt: DOUBLE_11_CAMPAIGN_END_AT,
    },
    manualOverride: {
      enabled: false,
      multiplier: 1,
      startAt: DOUBLE_11_CAMPAIGN_START_AT,
      endAt: DOUBLE_11_CAMPAIGN_END_AT,
      reason: '',
    },
  };
}

export const DEFAULT_POS_POINT_RULES: PosPointRules = {
  online: channelDefaults('online'),
  pos: channelDefaults('pos'),
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}設定格式錯誤`);
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}必須是開啟或關閉`);
  return value;
}

function asMultiplier(value: unknown, label: string) {
  const multiplier = Number(value);
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new Error(`${label}必須是 1 至 10 的整數倍率`);
  }
  return multiplier;
}

function asTimestamp(value: unknown, label: string) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`${label}時間無效`);
  return timestamp;
}

function validateWindow(startAt: number, endAt: number, label: string) {
  const maximumDuration = 366 * 24 * 60 * 60 * 1000;
  if (startAt >= endAt || endAt - startAt > maximumDuration) {
    throw new Error(`${label}起訖時間無效，期間不得超過 366 天`);
  }
}

function parseChannel(value: unknown, label: string): PointChannelRules {
  const root = asRecord(value, label);
  const campaign = asRecord(root.campaign, `${label}活動`);
  const manual = asRecord(root.manualOverride, `${label}手動倍率`);
  const standardMultiplier = asMultiplier(root.standardMultiplier, `${label}一般倍率`);
  const normalizedCampaign = {
    enabled: asBoolean(campaign.enabled, `${label}活動狀態`),
    name: String(campaign.name || '').trim(),
    multiplier: asMultiplier(campaign.multiplier, `${label}活動倍率`),
    startAt: asTimestamp(campaign.startAt, `${label}活動開始`),
    endAt: asTimestamp(campaign.endAt, `${label}活動結束`),
  };
  const normalizedManual = {
    enabled: asBoolean(manual.enabled, `${label}手動倍率狀態`),
    multiplier: asMultiplier(manual.multiplier, `${label}手動倍率`),
    startAt: asTimestamp(manual.startAt, `${label}手動倍率開始`),
    endAt: asTimestamp(manual.endAt, `${label}手動倍率結束`),
    reason: String(manual.reason || '').trim(),
  };
  if (!normalizedCampaign.name || normalizedCampaign.name.length > 80) throw new Error(`${label}活動名稱必須為 1 至 80 個字元`);
  validateWindow(normalizedCampaign.startAt, normalizedCampaign.endAt, `${label}活動`);
  validateWindow(normalizedManual.startAt, normalizedManual.endAt, `${label}手動倍率`);
  if (normalizedManual.enabled && !normalizedManual.reason) throw new Error(`${label}啟用手動倍率時，必須填寫調整原因`);
  if (normalizedManual.reason.length > 200) throw new Error(`${label}手動倍率原因不得超過 200 個字元`);
  return { standardMultiplier, campaign: normalizedCampaign, manualOverride: normalizedManual };
}

export function parsePosPointRules(value: unknown): PosPointRules {
  const root = asRecord(value, '點數倍率');
  // Backward compatibility: old records were POS-only. Preserve them for POS,
  // while giving online orders their own configurable default channel.
  if (!root.online || !root.pos) {
    return { online: DEFAULT_POS_POINT_RULES.online, pos: parseChannel(value, '現場 POS') };
  }
  return {
    online: parseChannel(root.online, '網頁訂購'),
    pos: parseChannel(root.pos, '現場 POS'),
  };
}

export function resolvePosPointMultiplier(rules: PointChannelRules, orderTimestamp: number | null, channelLabel: string): ResolvedPosPointMultiplier {
  if (orderTimestamp !== null && Number.isFinite(orderTimestamp)) {
    const { manualOverride, campaign } = rules;
    if (manualOverride.enabled && orderTimestamp >= manualOverride.startAt && orderTimestamp < manualOverride.endAt) {
      return { multiplier: manualOverride.multiplier, source: 'manual', label: `${channelLabel}手動調整 ${manualOverride.multiplier}x：${manualOverride.reason}` };
    }
    if (campaign.enabled && orderTimestamp >= campaign.startAt && orderTimestamp < campaign.endAt) {
      return { multiplier: campaign.multiplier, source: 'campaign', label: `${channelLabel}${campaign.name} ${campaign.multiplier}x` };
    }
  }
  return { multiplier: rules.standardMultiplier, source: 'standard', label: `${channelLabel}一般倍率 ${rules.standardMultiplier}x` };
}
