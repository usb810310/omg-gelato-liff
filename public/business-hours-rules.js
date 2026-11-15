(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GelatoBusinessHours = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DEFAULT_HOURS = Object.freeze({ open: true, start: '13:00', end: '20:00' });
  const CLOSURE_WORDS = /店休|公休|休息|休假|不營業|歇業|停止營業|暫停營業/;
  const CLOSURE_CONTEXT = /有事|因事|臨時|店休|公休|休息|休假|不營業|歇業|停止營業|暫停營業/;
  const NEGATION_WORDS = /取消|撤銷|不店休|不是店休|非店休|恢復營業|恢復正常|照常營業|正常營業|如常營業/;

  function pad2(value) { return String(value).padStart(2, '0'); }

  function taipeiParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || '0';
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      dayKey: get('weekday').toLowerCase().slice(0, 3),
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    };
  }

  function dateKeyFromParts(year, month, day) {
    return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  }

  function getTaipeiDateKey(date, offsetDays) {
    const parts = taipeiParts(date || new Date());
    const offset = Number(offsetDays || 0);
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset, 12));
    return dateKeyFromParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  }

  function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
    return { year, month, day, date };
  }

  function getTaipeiDayKey(dateKey) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return null;
    return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' })
      .format(new Date(`${dateKey}T12:00:00+08:00`)).toLowerCase().slice(0, 3);
  }

  function toMinutes(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return NaN;
    const hours = Number(match[1]), minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return NaN;
    return hours * 60 + minutes;
  }

  function getDayHours(hours, dateKey) {
    const dayKey = getTaipeiDayKey(dateKey);
    if (!dayKey) return { ...DEFAULT_HOURS, isSpecial: false, dateKey };
    const weekly = { ...DEFAULT_HOURS, ...((hours && hours[dayKey]) || {}) };
    const special = hours && hours.specialDates && hours.specialDates[dateKey];
    if (!special || typeof special !== 'object') return { ...weekly, isSpecial: false, dateKey, dayKey };
    return { ...weekly, ...special, isSpecial: true, dateKey, dayKey };
  }

  function statusForDate(hours, dateKey, now) {
    const schedule = getDayHours(hours, dateKey);
    if (!schedule.open) {
      return {
        kind: schedule.isSpecial ? 'special-closed' : 'weekly-closed',
        label: schedule.isSpecial ? '臨時店休' : '固定公休',
        detail: schedule.reason || (schedule.isSpecial ? '本日臨時店休' : '依每週營業時間，今天公休。'),
        dateKey, hours: schedule,
      };
    }
    const isToday = dateKey === getTaipeiDateKey(now || new Date());
    if (!isToday) {
      return {
        kind: schedule.isSpecial ? 'special-open' : 'scheduled-open',
        label: schedule.isSpecial ? '特別營業' : '正常營業',
        detail: `${schedule.start} – ${schedule.end}`,
        dateKey, hours: schedule,
      };
    }
    const parts = taipeiParts(now || new Date());
    const start = toMinutes(schedule.start), end = toMinutes(schedule.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { kind: 'unknown', label: '營業時間待確認', detail: '請留意最新公告。', dateKey, hours: schedule };
    }
    if (parts.minutes < start) {
      return { kind: 'not-open-yet', label: '尚未營業', detail: `今天 ${schedule.start} 開始營業`, dateKey, hours: schedule };
    }
    if (parts.minutes >= end) {
      return { kind: 'closed-for-today', label: '今日已打烊', detail: `今天營業至 ${schedule.end}`, dateKey, hours: schedule };
    }
    return { kind: 'open-now', label: '目前營業中', detail: `營業至 ${schedule.end}`, dateKey, hours: schedule };
  }

  function normalizeDateToken(year, month, day, nowParts) {
    let actualYear = year == null ? nowParts.year : Number(year);
    const actualMonth = Number(month), actualDay = Number(day);
    if (actualMonth < 1 || actualMonth > 12 || actualDay < 1 || actualDay > 31) return null;
    let parsed = new Date(Date.UTC(actualYear, actualMonth - 1, actualDay, 12));
    if (parsed.getUTCFullYear() !== actualYear || parsed.getUTCMonth() + 1 !== actualMonth || parsed.getUTCDate() !== actualDay) return null;
    const todayKey = dateKeyFromParts(nowParts.year, nowParts.month, nowParts.day);
    let key = dateKeyFromParts(actualYear, actualMonth, actualDay);
    if (year == null && key < todayKey && nowParts.month - actualMonth >= 6) {
      actualYear += 1;
      parsed = new Date(Date.UTC(actualYear, actualMonth - 1, actualDay, 12));
      key = dateKeyFromParts(actualYear, actualMonth, actualDay);
    }
    if (key < todayKey) return null;
    return key;
  }

  function parseAnnouncementDates(text, now) {
    const nowParts = taipeiParts(now || new Date());
    const dateRegex = /(^|[^\d])(?:(20\d{2})\s*[/.年-]\s*(\d{1,2})\s*[/.月-]\s*(\d{1,2})\s*日?|([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日?|([0-9]{1,2})\s*[/.]\s*([0-9]{1,2})|([0-9]{1,2})\s*-\s*([0-9]{1,2}))/g;
    const tokens = [];
    let match;
    while ((match = dateRegex.exec(text))) {
      let year = null, month, day;
      if (match[2]) { year = Number(match[2]); month = Number(match[3]); day = Number(match[4]); }
      else if (match[5]) { month = Number(match[5]); day = Number(match[6]); }
      else if (match[7]) { month = Number(match[7]); day = Number(match[8]); }
      else { month = Number(match[9]); day = Number(match[10]); }
      const key = normalizeDateToken(year, month, day, nowParts);
      if (key) tokens.push({ key, start: match.index + match[1].length, end: dateRegex.lastIndex });
    }
    const unique = [];
    for (const token of tokens) if (!unique.some((item) => item.key === token.key)) unique.push(token);
    if (unique.length === 2) {
      const between = text.slice(unique[0].end, unique[1].start);
      if (/^\s*(?:至|到|~|～|–|—|-)+\s*$/.test(between)) {
        const from = parseDateKey(unique[0].key), to = parseDateKey(unique[1].key);
        const gap = Math.round((to.date - from.date) / 86400000);
        if (gap >= 0 && gap <= 30) {
          const range = [];
          for (let offset = 0; offset <= gap; offset += 1) {
            const d = new Date(Date.UTC(from.year, from.month - 1, from.day + offset, 12));
            range.push(dateKeyFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
          }
          return range;
        }
      }
    }
    return unique.map((item) => item.key);
  }

  function analyzeClosureAnnouncement(title, content, now) {
    const text = `${title || ''} ${content || ''}`.replace(/\s+/g, ' ').trim();
    if (!text || NEGATION_WORDS.test(text)) return { matched: false, dates: [], text, reason: 'negated-or-cancelled' };
    if (!CLOSURE_WORDS.test(text) || !CLOSURE_CONTEXT.test(text)) return { matched: false, dates: [], text, reason: 'no-closure-language' };
    const dates = parseAnnouncementDates(text, now);
    if (!dates.length) return { matched: false, dates: [], text, reason: 'no-valid-future-date' };
    return { matched: true, dates, text, reason: 'date-and-closure-language' };
  }

  function findClosureAnnouncement(announcements, targetDateKeys, now) {
    const targets = Array.from(new Set(targetDateKeys || []));
    const candidates = [];
    for (const item of announcements || []) {
      if (!item || typeof item !== 'object' || item.active === false) continue;
      const parsed = analyzeClosureAnnouncement(item.title, item.content, now);
      if (!parsed.matched) continue;
      const matchedDate = targets.find((dateKey) => parsed.dates.includes(dateKey));
      if (!matchedDate) continue;
      candidates.push({ ...item, closureDates: parsed.dates, matchedDate, closureText: parsed.text });
    }
    candidates.sort((a, b) => {
      const dateOrder = targets.indexOf(a.matchedDate) - targets.indexOf(b.matchedDate);
      return dateOrder || (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
    });
    return candidates[0] || null;
  }

  return Object.freeze({
    DAY_KEYS,
    DEFAULT_HOURS,
    taipeiParts,
    getTaipeiDateKey,
    getTaipeiDayKey,
    getDayHours,
    statusForDate,
    parseAnnouncementDates,
    analyzeClosureAnnouncement,
    findClosureAnnouncement,
    toMinutes,
  });
});
