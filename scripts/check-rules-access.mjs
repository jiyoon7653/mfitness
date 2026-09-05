// 규칙 자동 배포가 403 으로 막힐 때, 원인이 "권한"인지 "API 미사용"인지 가려냅니다.
// 서비스 계정 키로 직접 토큰을 만들어 Firebase Rules API 를 두 번 두드려 보고,
// 구글이 돌려준 오류 본문을 그대로 찍습니다. firebase 명령은 이 본문을 삼켜버립니다.
import fs from 'node:fs';
import crypto from 'node:crypto';

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const project = process.env.FIREBASE_PROJECT || 'mfitness-d4a16';

function line(s) { process.stdout.write(s + '\n'); }
function head(s) { line(''); line('=== ' + s + ' ==='); }

if (!keyFile || !fs.existsSync(keyFile)) {
  line('서비스 계정 키 파일을 찾지 못했습니다: ' + keyFile);
  process.exit(0);
}

let sa;
try {
  sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
} catch (e) {
  line('서비스 계정 JSON 을 읽지 못했습니다. GitHub Secret 에 JSON 전체가 들어갔는지 확인하세요.');
  line('오류: ' + e.message);
  process.exit(0);
}

head('1. 어떤 계정으로 배포를 시도하는가');
// 이메일과 프로젝트 ID 는 비밀번호가 아닙니다. IAM 에서 역할을 준 대상과 대조하려고 찍습니다.
const [local, domain] = String(sa.client_email || '').split('@');
line('계정(앞부분) : ' + local);
line('계정(뒷부분) : ' + domain);
line('키의 프로젝트: ' + sa.project_id);
line('배포 대상     : ' + project);
if (sa.project_id && sa.project_id !== project) {
  line('!! 키가 다른 프로젝트의 것입니다. 이것만으로도 403 이 납니다.');
}

head('2. 액세스 토큰 발급');
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  aud: 'https://oauth2.googleapis.com/token',
  exp: now + 3600,
  iat: now
});

let token;
try {
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig
    })
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    line('토큰 발급 실패 (' + res.status + '): ' + JSON.stringify(body));
    line('키 자체가 삭제되었거나 잘못된 값일 수 있습니다.');
    process.exit(0);
  }
  token = body.access_token;
  line('발급 성공');
} catch (e) {
  line('토큰 발급 중 오류: ' + e.message);
  process.exit(0);
}

async function probe(label, url, init) {
  head(label);
  line(url.replace(project, project));
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init && init.headers) }
    });
    const text = await res.text();
    line('HTTP ' + res.status);
    line(text.slice(0, 1500));
    return { status: res.status, text: text };
  } catch (e) {
    line('요청 실패: ' + e.message);
    return { status: 0, text: '' };
  }
}

const listed = await probe(
  '3. 규칙 목록 읽기 (firebaserules.rulesets.list)',
  'https://firebaserules.googleapis.com/v1/projects/' + project + '/rulesets?pageSize=1'
);

const tested = await probe(
  '4. 규칙 검사 (firebaserules.rulesets.test) — 실제 배포가 막히는 지점',
  'https://firebaserules.googleapis.com/v1/projects/' + project + ':test',
  {
    method: 'POST',
    body: JSON.stringify({
      source: { files: [{ name: 'probe.rules', content: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /{doc=**} { allow read, write: if false; }\n  }\n}\n" }] }
    })
  }
);

head('판정');
const blob = (listed.text + tested.text);
if (tested.status === 200) {
  line('권한 정상입니다. 이 단계가 통과하면 아래 배포도 성공해야 합니다.');
} else if (/SERVICE_DISABLED|has not been used in project|is disabled/.test(blob)) {
  line('원인: Firebase Rules API 가 이 프로젝트에서 꺼져 있습니다.');
  line('해결: https://console.cloud.google.com/apis/library/firebaserules.googleapis.com?project=' + project);
  line('      → 사용 설정 → 1~2분 뒤 이 워크플로 재실행');
} else if (/PERMISSION_DENIED|caller does not have permission/.test(blob)) {
  line('원인: 위 1번에 찍힌 계정에 규칙 배포 권한이 없습니다.');
  line('해결: https://console.cloud.google.com/iam-admin/iam?project=' + project);
  line('      → 위 계정을 찾아 역할 수정 → "Firebase Rules 관리자" 추가 → 저장');
  line('      (Firebase 콘솔의 "사용자 및 권한" 이 아니라 Google Cloud IAM 화면입니다)');
} else {
  line('예상 밖의 응답입니다. 위 HTTP 상태와 본문을 그대로 확인하세요.');
}
