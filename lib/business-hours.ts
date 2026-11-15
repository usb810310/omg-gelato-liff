export type DayHours = { open?: boolean; start?: string; end?: string };
export type SpecialDayHours = {
  open: boolean;
  start?: string;
  end?: string;
  reason?: string;
  sourceAnnouncementId?: string;
  updatedAt?: number;
};
export type BusinessHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', DayHours>> & {
  shopMode?: 'auto' | 'open' | 'closed' | 'off';
  shopClosed?: boolean;
  specialDates?: Record<string, SpecialDayHours>;
};

export type ShopStatus = {
  isOpen: boolean;
  canOrder: boolean;
  label: string;
  detail: string;
};

const DEFAULT_HOURS = { open: true, start: '13:00', end: '20:00' };
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = (typeof DAY_KEYS)[number];

function toMinutes(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function taipeiParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    dayKey: get('weekday').toLowerCase().slice(0, 3) as DayKey,
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function addCalendarDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dayKeyForDate(dateKey: string): DayKey {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(date).toLowerCase().slice(0, 3);
  return DAY_KEYS.includes(weekday as DayKey) ? (weekday as DayKey) : 'mon';
}

function dayHours(hours: BusinessHours, dateKey: string) {
  const key = dayKeyForDate(dateKey);
  const weekly = { ...DEFAULT_HOURS, ...(hours[key] || {}) };
  const special = hours.specialDates?.[dateKey];
  return special ? { ...weekly, ...special, isSpecial: true } : { ...weekly, isSpecial: false };
}

export type PickupSlotValidation = { ok: true } | { ok: false; error: string };

export function validatePickupSlot(hours: BusinessHours | null, dateKey: string, pickupTime: string, now = new Date()): PickupSlotValidation {
  if (!hours || typeof hours !== 'object' || !DAY_KEYS.some((key) => hours[key] && typeof hours[key] === 'object')) {
    return { ok: false, error: '目前無法確認店家營業設定，暫停線上點餐。' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { ok: false, error: '取餐日期格式無效，請重新選擇時段。' };
  const requestedDate = new Date(`${dateKey}T12:00:00+08:00`);
  if (Number.isNaN(requestedDate.getTime()) || taipeiParts(requestedDate).dateKey !== dateKey) {
    return { ok: false, error: '取餐日期無效，請重新選擇時段。' };
  }

  const nowParts = taipeiParts(now);
  const tomorrowKey = addCalendarDays(nowParts.dateKey, 1);
  if (dateKey !== nowParts.dateKey && dateKey !== tomorrowKey) {
    return { ok: false, error: '取餐時段已過期，請重新選擇今天或明天的時段。' };
  }

  const isToday = dateKey === nowParts.dateKey;
  const mode = hours.shopMode || (hours.shopClosed ? 'off' : 'auto');
  if (mode === 'off') return { ok: false, error: '店家目前暫停線上點餐。' };
  if (isToday && mode === 'closed') return { ok: false, error: '今日已停止線上接單，請改選明日。' };

  const schedule = dayHours(hours, dateKey);
  if (schedule.isSpecial && schedule.open === false) return { ok: false, error: '所選日期為臨時店休，請改選其他時段。' };
  const forcedOpenToday = isToday && mode === 'open' && !schedule.isSpecial;
  if (!schedule.open && !forcedOpenToday) return { ok: false, error: '所選日期店休，請改選其他時段。' };

  const start = toMinutes(schedule.start || DEFAULT_HOURS.start);
  const end = toMinutes(schedule.end || DEFAULT_HOURS.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, error: '店家營業時段設定無效，暫時無法受理。' };
  }

  if (pickupTime === 'immediate') {
    if (!isToday) return { ok: false, error: '立即取餐只適用今天，請重新選擇時段。' };
    if (nowParts.minutes < start || nowParts.minutes >= end) return { ok: false, error: '目前不在可立即取餐時段，請選擇其他時段。' };
    return { ok: true };
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(pickupTime);
  if (!match) return { ok: false, error: '取餐時間格式無效，請重新選擇時段。' };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { ok: false, error: '取餐時間格式無效，請重新選擇時段。' };
  const slotMinutes = hour * 60 + minute;
  if (slotMinutes < start || slotMinutes > end || (slotMinutes - start) % 30 !== 0) {
    return { ok: false, error: '所選取餐時段不在店家營業時間內，請重新選擇。' };
  }
  if (isToday && slotMinutes <= nowParts.minutes) return { ok: false, error: '所選取餐時段已過，請重新選擇。' };
  return { ok: true };
}

function isOpenNow(schedule: ReturnType<typeof dayHours>, minutes: number) {
  return Boolean(schedule.open && minutes >= toMinutes(schedule.start || DEFAULT_HOURS.start) && minutes < toMinutes(schedule.end || DEFAULT_HOURS.end));
}

// 週排程描述店面通常營業時間；specialDates 對指定台灣日期覆蓋週排程。
// shopMode 僅控制線上接單，不代表實體店面開／關。
export function getShopStatus(hours: BusinessHours | null, now = new Date()): ShopStatus {
  if (!hours) return { isOpen: false, canOrder: false, label: '營業資訊待同步', detail: '目前無法確認店家最新營業設定。' };

  const mode = hours.shopMode || (hours.shopClosed ? 'off' : 'auto');
  const todayParts = taipeiParts(now);
  const today = dayHours(hours, todayParts.dateKey);
  const tomorrowKey = addCalendarDays(todayParts.dateKey, 1);
  const tomorrow = dayHours(hours, tomorrowKey);
  const todaySpecialClosed = today.isSpecial && today.open === false;
  const isOpen = !todaySpecialClosed && isOpenNow(today, todayParts.minutes);

  const todayCanOrder = todaySpecialClosed || mode === 'off' || mode === 'closed'
    ? false
    : today.isSpecial
      ? Boolean(today.open && todayParts.minutes < toMinutes(today.end || DEFAULT_HOURS.end))
      : mode === 'open' || Boolean(today.open && todayParts.minutes < toMinutes(today.end || DEFAULT_HOURS.end));
  const canOrder = mode === 'off' ? false : todayCanOrder || Boolean(tomorrow.open);

  let label: string;
  if (isOpen) label = today.isSpecial ? '特別營業中' : '今日營業中';
  else if (!today.open) label = today.isSpecial ? '臨時店休' : '今日店休';
  else if (todayParts.minutes < toMinutes(today.start || DEFAULT_HOURS.start)) label = '尚未營業';
  else label = '今日已打烊';

  const hoursDetail = today.open
    ? `營業時間 ${today.start || DEFAULT_HOURS.start} – ${today.end || DEFAULT_HOURS.end}`
    : today.reason || '今天沒有安排營業。';
  const orderDetail = mode === 'off'
    ? '目前線上點餐暫停；店面營業狀態仍依營業時間與特殊日期顯示。'
    : mode === 'closed'
      ? '今日線上接單已截止；店面營業狀態仍依營業時間顯示。'
      : '';
  const detail = [today.isSpecial && today.reason ? today.reason : hoursDetail, orderDetail].filter(Boolean).join(' ');

  return { isOpen, canOrder, label, detail };
}
