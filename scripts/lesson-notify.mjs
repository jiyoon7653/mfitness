// 개인레슨 신청서가 새로 들어오면 텔레그램으로 알립니다.
// GitHub Actions 에서 몇 분마다 돌면서, 지난번에 알린 것보다 뒤에 들어온 신청만 보냅니다.
// 신청 폼을 거친 것만 알립니다 — 시트에서 옮긴 기록은 알리지 않습니다.
//
// 왜 이렇게 하나
//   신청자 정보(이름·연락처·통증 기록)는 보안 규칙이 관리자 계정에게만 읽기를 허용합니다.
//   그래서 운영 리포트(scripts/daily-report.mjs)처럼 익명 로그인으로는 읽을 수 없고,
//   서비스 계정으로 접속합니다. 봇 토큰을 웹페이지에 넣으면 누구나 봇을 조종할 수 있으니
//   알림은 반드시 서버(Actions) 쪽에서 보내야 합니다.
//
// 필요한 환경변수(= GitHub Secrets):
//   TELEGRAM_BOT_TOKEN        기존 운영 리포트와 같은 봇을 씁니다
//   TELEGRAM_CHAT_ID          알림을 받을 대화방 ID (운영 리포트와 같은 값을 그대로 씁니다)
// 선택:
//   TELEGRAM_LESSON_CHAT_ID   레슨 알림만 다른 방으로 받고 싶을 때. 있으면 이쪽이 우선입니다.
//   GOOGLE_APPLICATION_CREDENTIALS  서비스 계정 JSON 파일 경로 (워크플로가 만들어 줍니다)
// 선택 환경변수:
//   DRY_RUN=1   전송하지 않고 무엇을 보낼지 출력만 합니다
//   FIREBASE_PROJECT  기본값은 firebase-config.js 의 projectId
//   FIRESTORE_EMULATOR_HOST  에뮬레이터로 시험할 때 (예: 127.0.0.1:8571)
//   TELEGRAM_API_BASE        전송 주소 바꾸기 (시험용, 기본 https://api.telegram.org)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_PER_RUN = 20;          // 한 번에 너무 많이 쏟아내지 않습니다
const NOTIFY_DOC = 'lessonSettings/notify';

function loadProjectId() {
  if (process.env.FIREBASE_PROJECT) return process.env.FIREBASE_PROJECT;
  const txt = readFileSync(join(__dirname, '..', 'public', 'firebase-config.js'), 'utf8');
  const m = txt.match(/projectId\s*:\s*"([^"]*)"/);
  return m ? m[1] : '';
}

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || '';
const TELEGRAM_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

// ---------- 서비스 계정으로 액세스 토큰 받기 ----------
async function accessToken() {
  // 에뮬레이터는 권한 검사를 하지 않고 'owner' 를 관리자 토큰으로 받아들입니다.
  if (EMULATOR) return 'owner';
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !existsSync(keyFile)) {
    throw new Error('서비스 계정 키 파일이 없습니다. GOOGLE_APPLICATION_CREDENTIALS 를 확인하세요.');
  }
  const sa = JSON.parse(readFileSync(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('액세스 토큰을 받지 못했습니다: ' + JSON.stringify(j));
  return j.access_token;
}

// ---------- Firestore REST ----------
const BASE = (p) => (EMULATOR ? `http://${EMULATOR}` : 'https://firestore.googleapis.com') +
  `/v1/projects/${p}/databases/(default)/documents`;

// Firestore 가 돌려주는 타입별 값({stringValue:...})을 보통 값으로 바꿉니다.
function plain(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return fields(v.mapValue.fields || {});
  return null;
}
function fields(f) {
  const out = {};
  Object.keys(f).forEach((k) => { out[k] = plain(f[k]); });
  return out;
}

async function firestore(projectId, token, path, init) {
  const r = await fetch(BASE(projectId) + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 403) {
      throw new Error(
        'Firestore 를 읽을 권한이 없습니다 (403).\n' +
        '  Google Cloud 콘솔 → IAM 에서 이 서비스 계정에 "Cloud Datastore 사용자"(Cloud Datastore User) 역할을 주세요.\n' +
        '  https://console.cloud.google.com/iam-admin/iam?project=' + projectId + '\n' +
        '  응답: ' + text.slice(0, 400));
    }
    throw new Error('Firestore 요청 실패 (' + r.status + '): ' + text.slice(0, 400));
  }
  return text ? JSON.parse(text) : {};
}

async function runQuery(projectId, token, query) {
  const rows = await firestore(projectId, token, ':runQuery', {
    method: 'POST',
    body: JSON.stringify({ structuredQuery: query }),
  });
  return (rows || [])
    .filter((x) => x.document)
    .map((x) => fields(x.document.fields || {}));
}

// ---------- 알림 기준점 ----------
async function readMarker(projectId, token) {
  try {
    const doc = await firestore(projectId, token, '/' + NOTIFY_DOC);
    const v = fields(doc.fields || {});
    return Number.isFinite(v.lastSeq) ? v.lastSeq : null;
  } catch (e) {
    if (/404|NOT_FOUND/.test(e.message)) return null;
    throw e;
  }
}
async function writeMarker(projectId, token, lastSeq) {
  await firestore(projectId, token, '/' + NOTIFY_DOC + '?updateMask.fieldPaths=lastSeq', {
    method: 'PATCH',
    body: JSON.stringify({ fields: { lastSeq: { integerValue: String(lastSeq) } } }),
  });
}

// ---------- 메시지 ----------
function fmtDateTime(d) {
  if (!(d instanceof Date)) return '';
  const k = new Date(d.getTime() + 9 * 3600 * 1000);   // KST
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}
function cut(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 신청자가 쓴 글이 그대로 들어가므로 Markdown 을 쓰지 않습니다.
// 이름에 * 나 _ 가 있으면 서식이 깨지고 전송이 실패할 수 있습니다.
function buildMessage(r, rank, waiting, adminUrl) {
  const lines = [
    '🆕 개인레슨 신규 신청',
    '',
    `접수번호   ${r.code || '-'}`,
    `접수일시   ${fmtDateTime(r.createdAt)}`,
    `이름       ${r.name || '-'}`,
    `연락처     ${r.phone || '-'}`,
    `희망 요일   ${(r.days || []).join(', ') || '-'}`,
    `희망 시간   ${(r.slots || []).join(', ') || '-'}`,
  ];
  if (r.shortGoal) lines.push(`단기 목표   ${cut(r.shortGoal, 60)}`);
  if (r.longGoal) lines.push(`장기 목표   ${cut(r.longGoal, 60)}`);
  if (r.notes) lines.push('', '통증·생활 패턴', cut(r.notes, 300));
  lines.push('', `대기 ${rank}번째 (전체 대기 ${waiting}명)`, '', adminUrl);
  return lines.join('\n');
}

// 알림에 신청자의 이름·연락처·통증 기록이 들어갑니다. 그래서 어디로 가는지를
// 실행 기록에 남깁니다 — 여러 사람이 보는 그룹이면 바로 알아볼 수 있게.
async function describeChat(botToken, chatId) {
  try {
    const r = await fetch(`${TELEGRAM_API}/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const j = await r.json();
    if (!j.ok) return '';
    const type = j.result.type === 'private' ? '개인 대화' : '그룹';
    const who = j.result.title || [j.result.first_name, j.result.last_name].filter(Boolean).join(' ') || '';
    return type + (who ? ' · ' + who : '');
  } catch {
    return '';
  }
}

async function sendTelegram(botToken, chatId, text) {
  const r = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('텔레그램 전송 실패: ' + JSON.stringify(j));
}

// ---------- 메인 ----------
async function main() {
  const projectId = loadProjectId();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  // 레슨 전용 방을 따로 지정했으면 그쪽으로, 아니면 운영 리포트와 같은 방으로 보냅니다.
  const lessonChat = (process.env.TELEGRAM_LESSON_CHAT_ID || '').trim();
  const sharedChat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const chatId = lessonChat || sharedChat;
  const chatSource = lessonChat ? 'TELEGRAM_LESSON_CHAT_ID' : 'TELEGRAM_CHAT_ID';

  if (!projectId) throw new Error('firebase-config.js 에서 projectId 를 읽지 못했습니다.');
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN 이 설정되지 않았습니다.');
  if (!chatId) {
    const guide =
      '보낼 대화방을 찾지 못했습니다.\n' +
      '  GitHub → Settings → Secrets and variables → Actions 에 TELEGRAM_CHAT_ID 가 있어야 합니다.\n' +
      '  레슨 알림만 다른 방으로 받고 싶으면 TELEGRAM_LESSON_CHAT_ID 를 따로 넣으세요.';
    // 5분마다 도는 예약 실행까지 빨갛게 실패하면 알림 메일만 쌓입니다.
    // 설정 전에는 조용히 넘어가고, 손으로 실행했을 때만 오류로 알립니다.
    if (process.env.EVENT_NAME === 'schedule') {
      console.log('아직 설정 전이라 건너뜁니다.\n' + guide);
      return;
    }
    throw new Error(guide);
  }

  const adminUrl = `https://${projectId}.web.app/lesson-admin`;
  const where = await describeChat(botToken, chatId);
  console.log(`알림 대상: ${chatSource}${where ? ' (' + where + ')' : ''}`);

  const token = await accessToken();

  const lastSeq = await readMarker(projectId, token);

  // 처음 켰을 때 예전 신청서를 한꺼번에 쏟아내지 않습니다.
  if (lastSeq === null) {
    const latest = await runQuery(projectId, token, {
      from: [{ collectionId: 'lessonApplications' }],
      orderBy: [{ field: { fieldPath: 'seq' }, direction: 'DESCENDING' }],
      limit: 1,
    });
    const start = latest.length ? Number(latest[0].seq) || 0 : 0;
    console.log(`처음 실행입니다. 지금까지 들어온 ${start}건은 건너뛰고, 다음 신청부터 알립니다.`);
    if (!DRY_RUN) {
      await writeMarker(projectId, token, start);
      await sendTelegram(botToken, chatId,
        '✅ 개인레슨 신규 신청 알림이 연결되었습니다.\n' +
        '지금부터 새로 들어오는 신청을 이 방으로 보냅니다.\n' +
        '신청자의 이름·연락처·통증 기록이 함께 옵니다.\n\n' + adminUrl);
    }
    return;
  }

  const fresh = await runQuery(projectId, token, {
    from: [{ collectionId: 'lessonApplications' }],
    where: {
      fieldFilter: { field: { fieldPath: 'seq' }, op: 'GREATER_THAN', value: { integerValue: String(lastSeq) } },
    },
    orderBy: [{ field: { fieldPath: 'seq' }, direction: 'ASCENDING' }],
    limit: MAX_PER_RUN,
  });

  if (!fresh.length) {
    console.log(`새 신청 없음 (마지막 알림: ${lastSeq}번)`);
    return;
  }

  // 대기 순번을 같이 알려주기 위해 대기 중인 신청서만 따로 셉니다.
  const waitingRows = await runQuery(projectId, token, {
    from: [{ collectionId: 'lessonApplications' }],
    where: {
      fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: '대기' } },
    },
  });
  const waitingSeqs = waitingRows.map((r) => Number(r.seq) || 0).sort((a, b) => a - b);

  let sent = 0;
  let skipped = 0;
  for (const r of fresh) {
    const seq = Number(r.seq) || 0;

    // 알리지 않고 넘기는 두 가지
    //  1) 폼을 거치지 않은 기록 — 폼은 개인정보 동의 시각을 남깁니다. 그 값이 없으면
    //     시트에서 옮겼거나 손으로 넣은 것이라, 명단을 가져올 때마다 한꺼번에 울리게 됩니다.
    //  2) 이미 대기가 아닌 건 — 알림이 나가기 전에 대표님이 먼저 처리한 경우입니다.
    if (!r.privacyAgreedAt || r.status !== '대기') {
      skipped += 1;
      if (!DRY_RUN) await writeMarker(projectId, token, seq);
      continue;
    }

    const rank = waitingSeqs.filter((s) => s <= seq).length || waitingSeqs.length + 1;
    const text = buildMessage(r, rank, waitingSeqs.length, adminUrl);
    if (DRY_RUN) {
      console.log('--- 보낼 내용 ---\n' + text + '\n');
    } else {
      await sendTelegram(botToken, chatId, text);
      // 한 건 보낼 때마다 기준점을 옮겨, 중간에 실패해도 같은 신청을 두 번 보내지 않습니다.
      await writeMarker(projectId, token, seq);
    }
    sent += 1;
  }
  console.log(`${sent}건 ${DRY_RUN ? '미리보기' : '전송'} 완료` +
    (skipped ? ` · 알릴 필요 없는 ${skipped}건은 건너뜀` : '') +
    ` (마지막 ${Number(fresh[fresh.length - 1].seq)}번)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
