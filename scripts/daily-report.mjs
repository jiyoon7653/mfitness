// 운영 보드 집계를 텔레그램으로 보냅니다. 세 가지 리포트를 한 파일에서 처리합니다.
//   REPORT_KIND=daily   (기본) 매일 22:10 KST — 그날 하루
//   REPORT_KIND=weekly        일요일 22:20 KST — 그 주 월요일~일요일 누적
//   REPORT_KIND=monthly       말일 22:30 KST — 그 달 마감
// GitHub Actions에서 실행되며, Firebase에는 익명 로그인으로 접속해 읽기만 합니다.
//
// 필요한 환경변수(= GitHub Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// 선택 환경변수:
//   REPORT_KIND (daily|weekly|monthly), DRY_RUN=1 (전송 안 하고 출력만), FORCE=1 (말일 검사 건너뛰기)
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
function addDays(dateStr, n) {
  const d = dateFromYMD(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
// 이번 달의 마지막 날짜(YYYY-MM-DD)
function lastDayOfMonth(today) {
  const { y, m } = parseYMD(today);
  return ymd(new Date(Date.UTC(y, m, 0)));
}
function pctOf(value, target) {
  return target > 0 ? Math.round((value / target) * 100) : null;
}
// 달성률에 눈에 띄는 표시를 붙입니다.
function pctMark(pct) {
  if (pct === null) return '';
  if (pct >= 100) return ' ✅';
  if (pct >= 70) return '';
  return ' ⚠️';
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


// ---------- 공통 조각 ----------
// 사물함 대조 스냅샷(settings/lockerSnapshot)에서 상태별 개수를 셉니다.
function lockerStats(snapshot) {
  const rows = (snapshot && Array.isArray(snapshot.rows)) ? snapshot.rows : [];
  if (!rows.length) return null;
  const c = { target: 0, soon: 0, orphan: 0, ok: 0, empty: 0 };
  rows.forEach((r) => { if (c[r.status] !== undefined) c[r.status]++; });
  return { ...c, total: rows.length, used: rows.length - c.empty, builtOn: snapshot.builtOn || '' };
}
// 당직표(settings/dutyRoster)에서 [start, end) 구간에 걸린 당직을 날짜순으로 뽑습니다.
function dutiesBetween(dutyDoc, start, end) {
  if (!dutyDoc) return [];
  return Object.keys(dutyDoc)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k >= start && k < end)
    .sort()
    .map((k) => ({ date: k, ...(dutyDoc[k] || {}) }))
    .filter((e) => e.person);
}
function conversionLine(visitors, calls) {
  const registered = visitors.filter((v) => v.result === '등록완료').length;
  const pct = pctOf(registered, visitors.length);
  const L = [];
  L.push(`👣 방문/상담  ${visitors.length}명 · 등록완료 ${registered}명` + (pct === null ? '' : ` (전환 ${pct}%)`));
  L.push(`📞 문의전화   ${calls.length}건`);
  return L;
}
function categoryLines(byCat, categories, targetOf) {
  const names = new Set([...Object.keys(byCat), ...categories.map((c) => c.name)]);
  const out = [];
  [...names].forEach((name) => {
    const sales = byCat[name] || 0;
    const cat = categories.find((c) => c.name === name);
    const target = cat ? targetOf(cat) : 0;
    const pct = pctOf(sales, target);
    out.push(`   ${name}  ${won(sales)}` + (pct === null ? '' : ` / ${won(target)} · ${pct}%${pctMark(pct)}`));
  });
  return out;
}

// ---------- 주간 리포트 (월요일 ~ 일요일 누적) ----------
function buildWeeklyReport(today, data) {
  const { week, weekWorklogs, monthWorklogs, weekVisitors, weekCalls, weekOt,
          categories, otWeekTarget, lockerSnapshot, dutyDoc } = data;
  const lastDay = addDays(week.end, -1);            // 그 주 일요일
  const weekSales = sumSales(weekWorklogs);
  const monthSales = sumSales(monthWorklogs);
  const weekTarget = categories.reduce((a, c) => a + currentWeekTarget(c, today), 0);
  const monthTarget = categories.reduce((a, c) => a + (Number(c.target) || 0), 0);

  const L = [];
  L.push('📊 *M휘트니스 주간 리포트*');
  L.push(`${week.start}(${weekdayKo(week.start)}) ~ ${lastDay}(${weekdayKo(lastDay)})`);
  if (today < lastDay) L.push(`_※ 아직 주가 끝나지 않았습니다 (${today} 까지 집계)_`);
  L.push('━━━━━━━━━━━━');

  const wPct = pctOf(weekSales.total, weekTarget);
  L.push(`💰 주간 매출  *${won(weekSales.total)}*`
    + (wPct === null ? ' (목표 미설정)' : ` (목표 ${won(weekTarget)} · ${wPct}%${pctMark(wPct)})`));
  L.push('');

  // 일자별 누적 — 하루하루가 어떻게 쌓였는지
  L.push('📅 *일자별*');
  const byDate = {};
  weekWorklogs.forEach((w) => { byDate[w.date] = (byDate[w.date] || 0) + sumSales([w]).total; });
  let running = 0;
  for (let i = 0; i < 7; i++) {
    const ds = addDays(week.start, i);
    if (ds > today) break;
    running += byDate[ds] || 0;
    const mark = byDate[ds] === undefined ? '  _(일지 없음)_' : '';
    L.push(`   ${weekdayKo(ds)} ${ds.slice(5)}   ${won(byDate[ds] || 0)}   누적 ${won(running)}${mark}`);
  }
  L.push('');

  const catLines = categoryLines(weekSales.byCat, categories, (c) => currentWeekTarget(c, today));
  if (catLines.length) {
    L.push('🏷️ *카테고리별*');
    catLines.forEach((l) => L.push(l));
    L.push('');
  }

  conversionLine(weekVisitors, weekCalls).forEach((l) => L.push(l));

  const otStat = otAchievement(weekOt);
  const otPct = pctOf(otStat.achieved, otWeekTarget);
  L.push(`⏱️ OT 진행    ${otStat.achieved}명 (전환 ${otStat.converted}명)`
    + (otPct === null ? '' : ` · 목표 ${otWeekTarget}명 · ${otPct}%${pctMark(otPct)}`));

  const lk = lockerStats(lockerSnapshot);
  if (lk) L.push(`🔒 사물함     재등록 안내 ${lk.target}명 · 곧 만료 ${lk.soon}명 · 정리 대상 ${lk.orphan}명`);

  const duties = dutiesBetween(dutyDoc, week.start, week.end);
  if (duties.length) L.push(`🗓️ 이번 주 당직  ${duties.map((d) => d.person).join(' · ')}`);

  L.push('');
  const mPct = pctOf(monthSales.total, monthTarget);
  L.push(`🗓️ 이번 달 누계  *${won(monthSales.total)}*`
    + (mPct === null ? ' (목표 미설정)' : ` (목표 ${won(monthTarget)} · ${mPct}%${pctMark(mPct)})`));
  return L.join('\n');
}

// ---------- 월간 마감 리포트 ----------
function buildMonthlyReport(today, data) {
  const { monthWorklogs, monthVisitors, monthCalls, monthOt,
          categories, otTarget, lockerSnapshot } = data;
  const { y, m } = parseYMD(today);
  const monthSales = sumSales(monthWorklogs);
  const monthTarget = categories.reduce((a, c) => a + (Number(c.target) || 0), 0);

  const L = [];
  L.push('📈 *M휘트니스 월간 마감 리포트*');
  L.push(`${y}년 ${m}월 (${monthRange(today).start} ~ ${lastDayOfMonth(today)})`);
  if (today < lastDayOfMonth(today)) L.push(`_※ 아직 달이 끝나지 않았습니다 (${today} 까지 집계)_`);
  L.push('━━━━━━━━━━━━');

  const mPct = pctOf(monthSales.total, monthTarget);
  L.push(`💰 월 매출  *${won(monthSales.total)}*`
    + (mPct === null ? ' (목표 미설정)' : ` (목표 ${won(monthTarget)} · ${mPct}%${pctMark(mPct)})`));
  L.push('');

  const catLines = categoryLines(monthSales.byCat, categories, (c) => Number(c.target) || 0);
  if (catLines.length) {
    L.push('🏷️ *카테고리별*');
    catLines.forEach((l) => L.push(l));
    L.push('');
  }

  // 주차별 — 그 주 월요일 기준으로 묶습니다. 주차 번호는 보드 화면과 같은 규칙이라
  // 달 경계에 걸친 주는 앞 달의 주차 번호를 그대로 씁니다(예: 8/31~9/6 은 5주차).
  // 번호만 보면 헷갈려서 기간을 함께 적습니다.
  const byWeek = {};
  monthWorklogs.forEach((w) => {
    const mon = weekRange(w.date).start;
    if (!byWeek[mon]) byWeek[mon] = 0;
    byWeek[mon] += sumSales([w]).total;
  });
  const mondays = Object.keys(byWeek).sort();
  if (mondays.length) {
    L.push('📅 *주차별 매출*');
    mondays.forEach((mon) => {
      const i = weekOfMonthIndex(mon);
      const sun = addDays(mon, 6);
      const target = categories.reduce((a, c) => a + (Array.isArray(c.weekTargets) ? (Number(c.weekTargets[i - 1]) || 0) : 0), 0);
      const pct = pctOf(byWeek[mon], target);
      L.push(`   ${i}주차 (${mon.slice(5)}~${sun.slice(5)})   ${won(byWeek[mon])}`
        + (pct === null ? '' : ` / ${won(target)} · ${pct}%${pctMark(pct)}`));
    });
    L.push('');
  }

  conversionLine(monthVisitors, monthCalls).forEach((l) => L.push(l));

  const otStat = otAchievement(monthOt);
  const otPct = pctOf(otStat.achieved, otTarget);
  L.push(`⏱️ OT 진행    ${otStat.achieved}명 (전환 ${otStat.converted}명)`
    + (otPct === null ? '' : ` · 목표 ${otTarget}명 · ${otPct}%${pctMark(otPct)}`));

  const lk = lockerStats(lockerSnapshot);
  if (lk) {
    L.push(`🔒 사물함     사용 ${lk.used} / ${lk.total}칸 · 빈 칸 ${lk.empty}`);
    L.push(`   재등록 안내 ${lk.target}명 · 곧 만료 ${lk.soon}명 · 정리 대상 ${lk.orphan}명${lk.builtOn ? ` (${lk.builtOn} 기준)` : ''}`);
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
  const kind = (process.env.REPORT_KIND || 'daily').trim().toLowerCase();
  if (!['daily', 'weekly', 'monthly'].includes(kind)) throw new Error('REPORT_KIND 는 daily/weekly/monthly 중 하나여야 합니다: ' + kind);

  if (!apiKey || !projectId) throw new Error('firebase-config.js 에서 apiKey/projectId 를 읽지 못했습니다.');
  if (!botToken || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 설정되지 않았습니다.');

  const today = ymd(kstNow());
  const week = weekRange(today);
  const month = monthRange(today);

  // 월간은 cron 으로 "말일"을 지정할 수 없어 28~31일에 매일 돌리고, 여기서 말일이 아니면 조용히 끝냅니다.
  if (kind === 'monthly' && today !== lastDayOfMonth(today) && process.env.FORCE !== '1' && process.env.DRY_RUN !== '1') {
    console.log('오늘은 말일이 아니라 월간 리포트를 보내지 않습니다:', today);
    return;
  }

  const token = await signInAnonymously(apiKey);

  // 일일은 오늘 하루치만, 주간·월간은 기간 전체를 불러옵니다.
  const rangeStart = kind === 'daily' ? today : (kind === 'weekly' ? week.start : month.start);
  const rangeEnd = kind === 'daily' ? addDays(today, 1) : (kind === 'weekly' ? week.end : month.end);

  const [visitorsRange, callsRange, monthWorklogs, lockers, catDoc, monthOt, trainerDoc, lockerSnapshot, dutyDoc] = await Promise.all([
    queryByDateRange(projectId, token, 'visitors', rangeStart, rangeEnd),
    queryByDateRange(projectId, token, 'inquiryCalls', rangeStart, rangeEnd),
    queryByDateRange(projectId, token, 'worklogs', month.start, month.end),
    listAll(projectId, token, 'lockers'),
    getDoc(projectId, token, 'settings/salesCategories'),
    queryByDateRange(projectId, token, 'otSessions', month.start, month.end),
    getDoc(projectId, token, 'settings/otTrainers'),
    getDoc(projectId, token, 'settings/lockerSnapshot'),
    getDoc(projectId, token, 'settings/dutyRoster'),
  ]);

  const todayWorklogs = monthWorklogs.filter((w) => w.date === today);
  const weekWorklogs = monthWorklogs.filter((w) => w.date >= week.start && w.date < week.end);
  const todayOt = monthOt.filter((e) => e.date === today);
  const weekOt = monthOt.filter((e) => e.date >= week.start && e.date < week.end);

  const categories = catDoc && Array.isArray(catDoc.items) ? catDoc.items : [];
  const trainers = trainerDoc && Array.isArray(trainerDoc.items) ? trainerDoc.items : [];
  const otTarget = trainers.reduce((a, t) => a + (Number(t.target) || 0), 0);
  const otWeekTarget = trainers.reduce((a, t) => a + currentWeekTarget(t, today), 0);

  let text;
  if (kind === 'weekly') {
    text = buildWeeklyReport(today, {
      week, weekWorklogs, monthWorklogs, weekVisitors: visitorsRange, weekCalls: callsRange,
      weekOt, categories, otWeekTarget, lockerSnapshot, dutyDoc,
    });
  } else if (kind === 'monthly') {
    text = buildMonthlyReport(today, {
      monthWorklogs, monthVisitors: visitorsRange, monthCalls: callsRange, monthOt,
      categories, otTarget, lockerSnapshot,
    });
  } else {
    text = buildReport(today, {
      visitors: visitorsRange, calls: callsRange, todayWorklogs, weekWorklogs, monthWorklogs,
      lockers, categories, todayOt, weekOt, monthOt, otTarget, otWeekTarget,
    });
  }

  if (process.env.DRY_RUN === '1') {
    console.log(`--- DRY RUN / ${kind} (전송 안 함) ---\n` + text);
    return;
  }
  await sendTelegram(botToken, chatId, text);
  console.log(`전송 완료 (${kind}):`, today);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
