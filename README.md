# M휘트니스 웹 (운영 보드 · 급여 정산)

Claude 아티팩트로 쓰던 두 화면을 **Firebase Hosting + Firestore** 로 옮긴 것입니다.
이제 데이터는 Claude가 아니라 우리 Firebase 프로젝트에 쌓입니다.

| 파일 | 화면 | 배포 후 주소 |
|---|---|---|
| `public/index.html` | 운영 보드 (방문자·문의·사물함·업무일지) | `https://<프로젝트id>.web.app/` |
| `public/payroll.html` | 급여 정산 (직원/관리자 PIN 로그인) | `https://<프로젝트id>.web.app/payroll.html` |

---

## 1. 준비 (한 번만, 약 15분)

### 1-1. Firebase 프로젝트 만들기
1. https://console.firebase.google.com 접속 → **프로젝트 추가**
2. 이름은 아무거나 (예: `m-fitness`). Google 애널리틱스는 **사용 안 함**으로 둬도 됩니다.

### 1-2. Firestore 만들기
1. 왼쪽 메뉴 **빌드 → Firestore Database → 데이터베이스 만들기**
2. **프로덕션 모드**로 시작 (규칙은 아래에서 넣습니다)
3. 위치는 **asia-northeast3 (서울)** 선택 — 한 번 정하면 못 바꿉니다.

### 1-3. 익명 로그인 켜기
1. **빌드 → Authentication → 시작하기**
2. **Sign-in method** 탭 → **익명(Anonymous)** → 사용 설정 → 저장

> 두 화면 모두 열릴 때 자동으로 익명 로그인을 합니다. 직원이 따로 할 일은 없습니다.

### 1-4. 웹 앱 등록하고 설정값 복사
1. **프로젝트 설정(톱니바퀴) → 내 앱 → 웹(`</>`)** 선택, 닉네임 아무거나 입력
2. 화면에 나오는 `firebaseConfig` 값을 복사
3. `public/firebase-config.js` 를 열어 그 값으로 **전부 교체**

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "m-fitness.firebaseapp.com",
  projectId: "m-fitness",
  storageBucket: "m-fitness.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef"
};
```

이 값들은 비밀번호가 아닙니다. 공개돼도 괜찮고, 실제 통제는 `firestore.rules` 가 합니다.

---

## 2. 배포

### 방법 A — Firebase CLI (권장)

```bash
npm install -g firebase-tools
firebase login
cd <이 폴더>
firebase use --add        # 위에서 만든 프로젝트 선택
firebase deploy           # 페이지 + 보안 규칙 한 번에 배포
```

끝나면 터미널에 `https://<프로젝트id>.web.app` 주소가 나옵니다. 직원 4명에게 그 주소를 공유하면 됩니다.
이후 파일을 고칠 때마다 `firebase deploy` 만 다시 실행하면 됩니다.

### 방법 B — CLI 없이

1. **보안 규칙**: 콘솔 → Firestore Database → **규칙** 탭 → `firestore.rules` 내용을 붙여넣고 **게시**
2. **페이지**: `public/` 안의 세 파일(`index.html`, `payroll.html`, `firebase-config.js`)을 원하는 정적 호스팅
   (Netlify, Cloudflare Pages, 기존 웹호스팅의 `html` 폴더 등)에 그대로 올립니다.
   세 파일은 **같은 폴더**에 있어야 합니다.
3. Firebase 콘솔 → Authentication → **설정 → 승인된 도메인**에 그 호스팅 도메인을 추가하세요.
   (이걸 빠뜨리면 로그인이 막혀서 저장이 안 됩니다.)

---

## 3. 데이터가 어떻게 쌓이나

**운영 보드** — 아티팩트에서 쓰던 것과 같은 구조 그대로입니다.

| 컬렉션/문서 | 내용 |
|---|---|
| `visitors` | 방문자·예약자 (건별 문서) |
| `inquiryCalls` | 문의 전화 (건별 문서) |
| `worklogs` | 업무일지 + 매출 (건별 문서) |
| `lockers` | 사물함 (건별 문서) |
| `settings/salesCategories` | 매출 카테고리와 목표 |
| `settings/monthlyFocus` | 이달의 집중 항목 |

여러 명이 동시에 봐도 실시간으로 같이 갱신됩니다 (`onSnapshot`).

**급여 정산** — `payroll/state` 문서 **하나**에 전체 상태를 JSON 문자열로 저장합니다.
직원별 요율표(`brackets`)가 중첩 배열이라 Firestore 필드로는 그대로 못 넣기 때문입니다.

- 저장은 **저장/확정 버튼을 눌렀을 때**만 일어납니다. 입력만 하고 새로고침하면 사라집니다 (기존 동작과 동일).
- 화면 오른쪽 아래 배지에 `저장됨 / 저장 중 / 저장 실패` 가 표시됩니다.
- 내가 화면을 연 뒤 **다른 사람이 먼저 저장**했다면, 덮어쓰지 않고 "다른 사람이 먼저 저장했습니다" 를 띄웁니다.
  배지를 누르면 새로고침되고, 최신 데이터에서 다시 입력하면 됩니다.
- 로그인 중에는 다른 기기의 변경이 화면을 자동으로 갈아치우지 않습니다 (입력 중 날아가는 것 방지).
  대신 "다른 기기에서 변경됨 · 눌러서 새로고침" 배지가 뜹니다.

첫 실행 시 `payroll/state` 가 비어 있으면 `payroll.html` 안에 들어 있는 초기값(직원 3명, PIN `1234`)으로 자동 생성됩니다.
**배포 후 관리자 PIN과 직원 PIN을 바로 바꾸세요.**

---

## 4. 알아둘 것

**비용** — 4명 사용량은 무료(Spark) 한도(하루 읽기 5만 / 쓰기 2만 / 저장 1GiB) 근처도 안 갑니다.
카드 등록 없이 계속 무료로 쓸 수 있고, 한도를 넘으면 과금이 아니라 그날 요청이 막히는 방식입니다.

**보안 수준 (중요)** — 지금 설정은 *"링크를 아는 사람"* 기준입니다.
페이지가 자동으로 익명 로그인을 하므로, 주소를 아는 사람이 브라우저 개발자도구를 열면
급여 데이터까지 읽을 수 있습니다. PIN 화면은 앱 안에서만 막는 것이라 완벽한 방어가 아닙니다.
인터넷에서 무작위로 긁어가는 것은 막히지만, **주소를 받은 사람**은 마음먹으면 볼 수 있다고 생각하세요.

**보안 한 단계 올리기** (나중에 필요해지면)
1. Authentication → Sign-in method → **이메일/비밀번호** 사용 설정
2. 직원 4명 계정을 콘솔에서 직접 추가 (사용자 탭 → 사용자 추가)
3. `firestore.rules` 의 `signedIn()` 을 아래처럼 바꾸고 다시 배포

```
function signedIn() {
  return request.auth != null && request.auth.token.firebase.sign_in_provider == 'password';
}
```

4. 두 HTML 의 `signInAnonymously()` 를 이메일/비밀번호 로그인 화면으로 교체 (이 부분은 코드 수정이 필요합니다)

**백업** — Firestore 콘솔에서 데이터를 직접 보고 복사할 수 있습니다.
급여 데이터는 `payroll/state` 문서의 `data` 필드 하나만 복사해두면 통째로 백업됩니다.

**SDK 버전** — 두 HTML 상단이 `firebasejs/10.12.5` 를 가리킵니다.
버전을 올리고 싶으면 세 개의 `<script src>` 줄에서 숫자만 바꾸면 됩니다 (compat 빌드 유지 필요).

**기존 아티팩트** — 아티팩트 버전과 호스팅 버전은 **데이터가 서로 완전히 분리**됩니다.
아티팩트에 이미 쌓인 데이터가 있으면 옮겨오지 않으니, 옮기고 나면 한쪽만 쓰세요.
