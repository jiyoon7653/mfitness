// 매일 22:00(KST) 운영 보드 집계를 텔레그램으로 보냅니다.
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
function weekdayKo(dateStr) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(dateStr + 'T00:00:00+09:00');
  return days[d.getDay()];
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
function buildReport(today, data) {
  const { visitors, calls, worklogs, lockers, categories } = data;

  // 매출: 오늘 업무일지의 sales 맵 합산 + 카테고리별
  const catTotals = {};
  let salesTotal = 0;
  worklogs.forEach((w) => {
    const s = w.sales || {};
    for (const k of Object.keys(s)) {
      const v = Number(s[k]) || 0;
      catTotals[k] = (catTotals[k] || 0) + v;
      salesTotal += v;
    }
  });
  const otToday = worklogs.reduce((a, w) => a + (Number(w.otCount) || 0), 0);

  // 방문/상담
  const registered = visitors.filter((v) => v.result === '등록완료').length;

  // 사물함: 오늘 신규 등록 + 종료일이 지난(정리 대상) 건
  const newLockers = lockers.filter((l) => {
    if (!l.createdAt) return false;
    return ymd(new Date(Number(l.createdAt) + 9 * 3600 * 1000)) === today;
  }).length;
  const expiring = lockers.filter((l) => l.lockerEnd && l.lockerEnd <= today).length;

  // 목표 대비 (있으면)
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
  L.push(`⏱️ OT        ${otToday}건`);

  // 특이사항 / 업무 요약
  const notes = worklogs.map((w) => w.issues).filter(Boolean);
  const summaries = worklogs.map((w) => w.summary).filter(Boolean);
  if (notes.length) L.push(`⚠️ 특이사항   ${notes.join(' / ')}`);
  if (summaries.length) L.push(`📝 업무요약   ${summaries.join(' / ')}`);

  if (worklogs.length === 0) {
    L.push('');
    L.push('_※ 오늘 작성된 업무일지가 없어 매출은 0으로 표시됩니다._');
  }
  if (monthTarget > 0) {
    L.push('');
    L.push(`🎯 이번 달 매출 목표 ${won(monthTarget)}`);
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
  const token = await signInAnonymously(apiKey);

  const [visitors, calls, worklogs, lockers, catDoc] = await Promise.all([
    queryByDate(projectId, token, 'visitors', today),
    queryByDate(projectId, token, 'inquiryCalls', today),
    queryByDate(projectId, token, 'worklogs', today),
    listAll(projectId, token, 'lockers'),
    getDoc(projectId, token, 'settings/salesCategories'),
  ]);

  const categories = catDoc && Array.isArray(catDoc.items) ? catDoc.items : [];
  const text = buildReport(today, { visitors, calls, worklogs, lockers, categories });

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
