export type PosPointRules = {
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

export type ResolvedPosPointMultiplier = {
  multiplier: number;
  source: 'manual' | 'campaign' | 'standard';
  label: string;
};

export const DOUBLE_11_CAMPAIGN_START_AT = Date.parse('2026-11-10T16:00:00.000Z');
export const DOUBLE_11_CAMPAIGN_END_AT = Date.parse('2026-11-11T16:00:00.000Z');

export function isDouble11CampaignAt(timestamp: number | null) {
  return timestamp !== null && Number.isFinite(timestamp)
    && timestamp >= DOUBLE_11_CAMPAIGN_START_AT && timestamp < DOUBLE_11_CAMPAIGN_END_AT;
}

export const DEFAULT_POS_POINT_RULES: PosPointRules = {
  standardMultiplier: 1,
  campaign: {
    enabled: false,
    name: '雙11線上限定（POS 不適用）',
    multiplier: 1,
    startAt: DOUBLE_11_CAMPAIGN_START_AT,
    endAt: DOUBLE_11_CAMPAIGN_END_AT,
  },
  manualOverride: {
    enabled: false,
    multiplier: 1,
    startAt: Date.parse('2026-11-10T16:00:00.000Z'),
    endAt: Date.parse('2026-11-11T16:00:00.000Z'),
    reason: '',
  },
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

export function parsePosPointRules(value: unknown): PosPointRules {
  const root = asRecord(value, '點數倍率');
  const campaign = asRecord(root.campaign, '活動');
  const manual = asRecord(root.manualOverride, '手動倍率');
  const standardMultiplier = asMultiplier(root.standardMultiplier, '一般倍率');
  const normalizedCampaign = {
    enabled: asBoolean(campaign.enabled, '活動狀態'),
    name: String(campaign.name || '').trim(),
    multiplier: asMultiplier(campaign.multiplier, '活動倍率'),
    startAt: asTimestamp(campaign.startAt, '活動開始'),
    endAt: asTimestamp(campaign.endAt, '活動結束'),
  };
  const normalizedManual = {
    enabled: asBoolean(manual.enabled, '手動倍率狀態'),
    multiplier: asMultiplier(manual.multiplier, '手動倍率'),
    startAt: asTimestamp(manual.startAt, '手動倍率開始'),
    endAt: asTimestamp(manual.endAt, '手動倍率結束'),
    reason: String(manual.reason || '').trim(),
  };
  if (!normalizedCampaign.name || normalizedCampaign.name.length > 80) throw new Error('活動名稱必須為 1 至 80 個字元');
  validateWindow(normalizedCampaign.startAt, normalizedCampaign.endAt, '活動');
  validateWindow(normalizedManual.startAt, normalizedManual.endAt, '手動倍率');
  if (normalizedManual.enabled && !normalizedManual.reason) throw new Error('啟用手動倍率時，必須填寫調整原因');
  if (normalizedManual.reason.length > 200) throw new Error('手動倍率原因不得超過 200 個字元');
  return {
    standardMultiplier,
    campaign: normalizedCampaign,
    manualOverride: normalizedManual,
  };
}

export function resolvePosPointMultiplier(rules: PosPointRules, orderTimestamp: number | null): ResolvedPosPointMultiplier {
  if (orderTimestamp !== null && Number.isFinite(orderTimestamp)) {
    const { manualOverride, campaign } = rules;
    if (manualOverride.enabled && orderTimestamp >= manualOverride.startAt && orderTimestamp < manualOverride.endAt) {
      return { multiplier: manualOverride.multiplier, source: 'manual', label: `手動調整 ${manualOverride.multiplier}x：${manualOverride.reason}` };
    }
    if (campaign.enabled && orderTimestamp >= campaign.startAt && orderTimestamp < campaign.endAt) {
      return { multiplier: campaign.multiplier, source: 'campaign', label: `${campaign.name} ${campaign.multiplier}x` };
    }
  }
  return { multiplier: rules.standardMultiplier, source: 'standard', label: `一般倍率 ${rules.standardMultiplier}x` };
}
