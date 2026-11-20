# 개발 서버 정합 증거 — 2026-11-16

대상: `dev-gps.serial.kr`, 기존 개발 DB72→114, UI·API 정합. [상세 기록/사용 방법](../../operations/dev-alignment-20261116.md).

| 파일 | 확인 범위 |
|---|---|
| `prepared.json` | 소스/산출물 준비, 기존 데이터 집계/해시, 운영 기준 상태 |
| `rehearsal.json` | 개발 DB 복사본 전환, 기존 열 보존, 격리 API18건200/익명401 |
| `deployment.json` | 실제 개발 배포16:55:36 KST, SQL9.160초·전환19.087초 |
| `verified.json` | 공개 개발 API18건, 정적 파일41개, 개발 정책OFF와 운영 불변 |
| `browser.json` | 실제 브라우저4화면, 페이지 오류/서버5xx/운영API호출0 |
| `dev-profile.png` / `dev-profile-mobile.png` | 기존 개발 테스트 계정의 계정 화면, 데스크톱/모바일 폭 |
| `dev-privacy.png` | 개인정보 요청 탭의 수집·이용·제공 제어 화면 |
| `dev-corporate.png` | 실제 개발 DB를 조회하는 법인 운영 현황 |
| `cleanup.json` | 임시 DB 제거, 개발72 백업 DB 보존/접속 닫힘 |
| `final.json` | 배포 후 서비스/스키마/설정/운영 불변 최종 점검 |
| `prepare-permission-error.txt` | 최초 준비의 소스 묶음 접근 권한 오류; API/DB 변경 전 |
| `executed-deploy.py` | 리허설·적용에 사용한 실제 스크립트 |
| `SHA256SUMS` | 위 증거의 SHA256 |

생성 UI가 아니라 실제 개발 서버 화면이다. Android 실기기 검증, 실제 로그인 폼, 신규 동의/파기/외부통보 실행, 추가 부하 검증은 이번 증거에 포함되지 않는다. 개발 세션 토큰은 브라우저 검증 프로세스의 메모리에서만 사용했고 기록하지 않았다. DB 덤프·환경 파일·JWT 비밀값·개인정보 원본 행은 증거에 넣지 않는다.

`core_rows_unchanged`는 기존 사용자·장치·위치 열의 전환 직전/직후 비교다. `verified.json`의 해시는 새 열을 포함하므로 이전 스키마 전체 행 해시와 직접 비교하지 않는다. 차량 자산 생성/참조 전환 등 마이그레이션의 정상 데이터 변환은 상세 문서에 구분했다.
