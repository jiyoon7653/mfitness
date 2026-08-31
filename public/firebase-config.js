// 이 파일은 "우리 Firebase 프로젝트 주소"를 적어두는 곳입니다.
// 비밀번호가 아니라서 공개돼도 괜찮습니다. 실제 통제는 firestore.rules 가 합니다.
//
// [채우는 법] Firebase 콘솔 → 톱니바퀴(프로젝트 설정) → 아래로 스크롤 → 내 앱
//            거기 나오는 값들을 아래 따옴표 "" 안에 하나씩 넣고 저장하세요.
//            줄 이름(apiKey, projectId 등)은 그대로 두고 값만 바꾸면 됩니다.

window.__CONFIG_FILE_LOADED = true;

window.FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// 참고: 콘솔 화면의 코드를 통째로 복사해 이 아래에 붙여넣어도 동작합니다.
// (const firebaseConfig = { ... }; 형태 그대로여도 인식합니다.
//  단, import 로 시작하는 줄이 있으면 그 줄은 지워 주세요.)
