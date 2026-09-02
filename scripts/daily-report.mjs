// 매일 22:10(KST) 운영 보드 집계를 텔레그램으로 보냅니다.
// GitHub Actions에서 실행되며, Firebase에는 익명 로그인으로 접속해 읽기만 합니다.
//
// 필요한 환경변수(= GitHub Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Firebase 설정(apiKey, projectId)은 public/firebase-config.js 에서 자동으로 읽습니다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Firebase 설정 읽기 ----------
function loadFirebaseConfig() {
  const txt = readFileSync(join(__dirname, '..', 'public', 'firebase-config.js'), 'utf8');
  const pick = (k) => {
    const m = txt.match(new RegExp(k + '\\s*:\\s*"([^"]*)"'));
    return m ? m[1] : '';
  };
  return { apiKey: pick('apiKey'), projectId: pick('projectId') };
}

// ---------- 날짜 (KST) ----------
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
// today는 이미 ymd(kstNow())로 뽑아낸 "KST 기준 날짜 문자열"입니다.
// 여기서부터는 순수 달력 계산이라, Date를 UTC로만 다뤄서 실행 서버의 시간대(주로 UTC)에
// 좌우되지 않게 합니다. 로컬 타임존 getter(getDay/getDate 등)를 쓰면 GitHub Actions가
// UTC로 도는 특성상 자정 부근에서 요일/주 경계가 하루 밀릴 수 있습니다.
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
function dateFromYMD(s) {
  const { y, m, d } = parseYMD(s);
  return new Date(Date.UTC(y, m - 1, d));
}
function weekdayKo(dateStr) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return days[dateFromYMD(dateStr).getUTCDay()];
}
// 월요일 시작 기준 이번 주 범위. 보드 화면(mondayOf)과 동일한 기준입니다.
function weekRange(today) {
  const d = dateFromYMD(today);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0 ... 일=6
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7);
  return { start: ymd(start), end: ymd(end) };
}
// 주차 기준은 보드 화면과 동일: 그 주 월요일이 속한 달의 몇 번째 주(1~5)
const WEEK_SLOTS = 5;
function weekOfMonthIndex(today) {
  const mondayStr = weekRange(today).start;
  const { d } = parseYMD(mondayStr);
  return Math.min(WEEK_SLOTS, Math.floor((d - 1) / 7) + 1);
}
// 1~5주차 배열이 있으면 이번 주차 값을, 없으면 예전 단일 weekTarget 값을 씁니다.
function currentWeekTarget(item, today) {
  if (Array.isArray(item.weekTargets)) {
    return Number(item.weekTargets[weekOfMonthIndex(today) - 1]) || 0;
  }
  return Number(item.weekTarget) || 0;
}

function monthRange(today) {
  const { y, m } = parseYMD(today);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const nd = new Date(Date.UTC(y, m, 1)); // 다음 달 1일 (UTC)
  const end = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return { start, end };
}
function won(n) {
  return (Math.round(n) || 0).toLocaleString('ko-KR') + '원';
}

// ---------- Firestore 값 디코더 ----------
function decode(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) out[k] = decode(f[k]);
    return out;
  }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function decodeDoc(doc) {
  const out = {};
  const f = doc.fields || {};
  for (const k of Object.keys(f)) out[k] = decode(f[k]);
  return out;
}

// ---------- Firebase 접속 ----------
async function signInAnonymously(apiKey) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!r.ok) throw new Error('익명 로그인 실패: ' + r.status + ' ' + (await r.text()));
  return (await r.json()).idToken;
}

// 컬렉션에서 date 필드가 오늘인 문서만 가져오기 (date 필터가 없으면 전체)
async function queryByDate(projectId, token, collection, today) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: today } },
      },
      limit: 1000,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(collection + ' 조회 실패: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  return rows.filter((x) => x.document).map((x) => decodeDoc(x.document));
}

// date 필드가 [start, end) 범위인 문서만 가져오기. ISO(YYYY-MM-DD) 문자열은
// 사전식 비교가 날짜 순서와 그대로 일치해서 범위 쿼리로 바로 씁니다.
async function queryByDateRange(projectId, token, collection, start, end) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: start } } },
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN', value: { stringValue: end } } },
          ],
        },
      },
      limit: 1000,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(collection + ' 범위 조회 실패: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  return rows.filter((x) => x.document).map((x) => decodeDoc(x.document));
}

async function listAll(projectId, token, collection) {
  let docs = [], pageToken = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?pageSize=300` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(collection + ' 목록 실패: ' + r.status + ' ' + (await r.text()));
    const j = await r.json();
    (j.documents || []).forEach((d) => docs.push(decodeDoc(d)));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function getDoc(projectId, token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(path + ' 조회 실패: ' + r.status);
  return decodeDoc(await r.json());
}

// ---------- 집계 ----------
// 업무일지 목록의 sales 맵을 합산합니다 (오늘/이번 주/이번 달 공통으로 재사용).
function sumSales(worklogs) {
  const byCat = {};
  let total = 0;
  worklogs.forEach((w) => {
    const s = w.sales || {};
    for (const k of Object.keys(s)) {
      const v = Number(s[k]) || 0;
      byCat[k] = (byCat[k] || 0) + v;
      total += v;
    }
  });
  return { total, byCat };
}
// 같은 회원의 2·3회차 방문을 인원 1명으로 묶습니다 (보드 화면과 동일한 기준).
function otCustomerKey(e) {
  return (e.trainer || '') + '|' + ((e.phone && e.phone.trim()) || (e.customer || '').trim());
}
function otAchievement(sessions) {
  const map = new Map();
  for (const e of sessions) {
    const key = otCustomerKey(e);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const groups = [...map.values()].map((entries) => {
    const last = entries.slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)).at(-1);
    return { converted: last.converted };
  });
  const converted = groups.filter((g) => g.converted === '전환완료').length;
  const decided = groups.filter((g) => g.converted && g.converted !== '미정').length;
  return { achieved: groups.length, converted, decided };
}

function achievementLine(label, sales, target) {
  const pct = target > 0 ? Math.round((sales.total / target) * 100) : null;
  const suffix = pct === null ? '(목표 미설정)' : `(목표 ${won(target)} · ${pct}%)`;
  return `${label}  *${won(sales.total)}* ${suffix}`;
}

function buildReport(today, data) {
  const { visitors, calls, todayWorklogs, weekWorklogs, monthWorklogs, lockers, categories, todayOt, weekOt, monthOt, otTarget, otWeekTarget } = data;

  const todaySales = sumSales(todayWorklogs);
  const weekSales = sumSales(weekWorklogs);
  const monthSales = sumSales(monthWorklogs);
  const catTotals = todaySales.byCat;
  const salesTotal = todaySales.total;
  const todayOtStat = otAchievement(todayOt);

  // 방문/상담
  const registered = visitors.filter((v) => v.result === '등록완료').length;

  // 사물함: 오늘 신규 등록 + 종료일이 지난(정리 대상) 건
  const newLockers = lockers.filter((l) => {
    if (!l.createdAt) return false;
    return ymd(new Date(Number(l.createdAt) + 9 * 3600 * 1000)) === today;
  }).length;
  const expiring = lockers.filter((l) => l.lockerEnd && l.lockerEnd <= today).length;

  // 목표 대비
  const weekTarget = (categories || []).reduce((a, c) => a + currentWeekTarget(c, today), 0);
  const monthTarget = (categories || []).reduce((a, c) => a + (Number(c.target) || 0), 0);

  // ---- 메시지 구성 ----
  const L = [];
  L.push(`🏋️ *M휘트니스 일일 리포트*`);
  L.push(`${today} (${weekdayKo(today)})`);
  L.push('━━━━━━━━━━━━');

  const catLine = Object.keys(catTotals).length
    ? '   ' + Object.keys(catTotals).map((k) => `${k} ${won(catTotals[k])}`).join(' · ')
    : null;
  L.push(`💰 오늘 매출  *${won(salesTotal)}*`);
  if (catLine) L.push(catLine);

  L.push(`👣 방문/상담  ${visitors.length}명 (등록완료 ${registered}명)`);
  L.push(`📞 문의전화   ${calls.length}건`);
  L.push(`🔒 사물함     신규 ${newLockers} · 정리대상 ${expiring}`);
  L.push(`⏱️ OT 진행    ${todayOtStat.achieved}명 (전환 ${todayOtStat.converted}명)`);

  // 특이사항 / 업무 요약
  const notes = todayWorklogs.map((w) => w.issues).filter(Boolean);
  const summaries = todayWorklogs.map((w) => w.summary).filter(Boolean);
  if (notes.length) L.push(`⚠️ 특이사항   ${notes.join(' / ')}`);
  if (summaries.length) L.push(`📝 업무요약   ${summaries.join(' / ')}`);

  if (todayWorklogs.length === 0) {
    L.push('');
    L.push('_※ 오늘 작성된 업무일지가 없어 매출은 0으로 표시됩니다._');
  }
  L.push('');
  L.push(achievementLine('📅 이번 주 누계', weekSales, weekTarget));
  L.push(achievementLine('🗓️ 이번 달 누계', monthSales, monthTarget));

  const weekOtStat = otAchievement(weekOt);
  const monthOtStat = otAchievement(monthOt);
  if (otWeekTarget > 0) {
    const pct = Math.round((weekOtStat.achieved / otWeekTarget) * 100);
    L.push(`🏋️ 이번 주 OT 달성률  *${pct}%* (${weekOtStat.achieved}/${otWeekTarget}명 · 전환 ${weekOtStat.converted}명)`);
  }
  if (otTarget > 0) {
    const pct = Math.round((monthOtStat.achieved / otTarget) * 100);
    L.push(`🏋️ 이번 달 OT 달성률  *${pct}%* (${monthOtStat.achieved}/${otTarget}명 · 전환 ${monthOtStat.converted}명)`);
  }

  return L.join('\n');
}

// ---------- 텔레그램 전송 ----------
async function sendTelegram(botToken, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('텔레그램 전송 실패: ' + JSON.stringify(j));
}

// ---------- 메인 ----------
async function main() {
  const { apiKey, projectId } = loadFirebaseConfig();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!apiKey || !projectId) throw new Error('firebase-config.js 에서 apiKey/projectId 를 읽지 못했습니다.');
  if (!botToken || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 설정되지 않았습니다.');

  const today = ymd(kstNow());
  const week = weekRange(today);
  const month = monthRange(today);
  const token = await signInAnonymously(apiKey);

  const [visitors, calls, monthWorklogs, lockers, catDoc, monthOt, trainerDoc] = await Promise.all([
    queryByDate(projectId, token, 'visitors', today),
    queryByDate(projectId, token, 'inquiryCalls', today),
    queryByDateRange(projectId, token, 'worklogs', month.start, month.end),
    listAll(projectId, token, 'lockers'),
    getDoc(projectId, token, 'settings/salesCategories'),
    queryByDateRange(projectId, token, 'otSessions', month.start, month.end),
    getDoc(projectId, token, 'settings/otTrainers'),
  ]);

  const todayWorklogs = monthWorklogs.filter((w) => w.date === today);
  const weekWorklogs = monthWorklogs.filter((w) => w.date >= week.start && w.date < week.end);
  const todayOt = monthOt.filter((e) => e.date === today);
  const weekOt = monthOt.filter((e) => e.date >= week.start && e.date < week.end);

  const categories = catDoc && Array.isArray(catDoc.items) ? catDoc.items : [];
  const trainers = trainerDoc && Array.isArray(trainerDoc.items) ? trainerDoc.items : [];
  const otTarget = trainers.reduce((a, t) => a + (Number(t.target) || 0), 0);
  const otWeekTarget = trainers.reduce((a, t) => a + currentWeekTarget(t, today), 0);
  const text = buildReport(today, { visitors, calls, todayWorklogs, weekWorklogs, monthWorklogs, lockers, categories, todayOt, weekOt, monthOt, otTarget, otWeekTarget });

  if (process.env.DRY_RUN === '1') {
    console.log('--- DRY RUN (전송 안 함) ---\n' + text);
    return;
  }
  await sendTelegram(botToken, chatId, text);
  console.log('전송 완료:', today);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
