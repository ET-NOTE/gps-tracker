# 137차 팀 검토 배포 증거

현재 결과는 [작업 문서](../../operations/location-business-review137-20261116.md)를 따른다. r1 파일 전송 성공만으로 화면 성공을 주장하지 않는다. 실제 브라우저에서 legacy base 문제가 발견되어 이전 웹 임시 복원 후 r2로 수정했고, 이후 외부 감시용 GET 메서드 응답 호환성도 보완했다.

| 파일 | 의미 |
|---|---|
| `staged.json` | schema99/API·환경설정·이웃 서비스 기준, 후보1131개 파일 해시 확인 |
| `restore-first-failure.json` | 압축 NULL 컬럼의 최초 복원 실패. 운영 데이터 변경 전 발견 |
| `rehearsal.json`, `smoke.json` | DB 복원/99→114 전환, 기존 열 해시, 5개 인증 조회와 미인증401 |
| `executed-deploy.py` | 실제 r1 실행본. 배포 기록의 script SHA256과 일치; 재실행용 아님 |
| `deployment.json` | API/DB r1 적용,107.855초 구간, DB 전환3.616초, 백업·환경·다른 서비스 보호 |
| `verified.json` | r1에서 파일 바이트 확인. **브라우저 동작 보증이 아님** |
| `web-path-failure.json` | 잘못된 legacy base와 이전 웹 링크 임시 복원 |
| `web-root-manifest.json`, `web-root-deployment.json` | `VITE_BASE=/` 재빌드 해시, r2 엔트리 경로·JS MIME 확인 |
| `live-ui.json`, `live-profile.png`, `live-privacy.png` | r2 웹·r3 API 실제 서비스의 테스트 계정 로그인/API10개200/페이지 오류0. 합성 UI나 생성 이미지가 아님 |
| `backup-final-restore.json` | 적용 직전 실제 백업을 별도 DB에 다시 복원하고 5개 핵심 테이블 해시 대조 |
| `cleanup.json` | 임시 DB2개/연습 덤프 제거; 실제 백업 보존 |
| `final-state.json` | r3 전 상태.114·계정42·장치18·압축25청크·수신 지속·실제 경고 수치 |
| `build-api-first-failure.log` | 새 메서드 회귀 검사의 최초 실패: 외부 `/ingest`와 Axum `/gps-tracker/ingest` 경로 구분 보완 |
| `build-api.log`, `monitor-fix-manifest.json` | 메서드 거부 수정본 fmt/clippy·Rust98개 통과, 바이너리/소스 해시 |
| `monitor-fix-deployment.json` | r3 API 교체·HTTP/HTTPS GET/HEAD405·Allow POST, 잘못된 JSON POST400 |
| `post-fix-state.json` | 최종 API·스키마·환경·웹·다른 서비스와 이후 수신/감시 응답 |
| `SHA256SUMS.json` | 이 디렉터리 증거 파일별 해시(목록 자체 제외) |

`rehearsal.json`의 `production_unchanged=true`는 API/환경/웹 버전·업무 데이터가 바뀌지 않았다는 비교 결과다. 물리 DB 복사본을 만들기 위한 **GPS API의 일시 중단/재개는 있었다**. 이를 무중단 검증으로 해석하지 않는다. 실제 배포 전환과 최초 웹 빈 화면도 숨기지 않고 별도로 기록했다.

원본 덤프·환경파일·JWT/비밀번호·SIM 인증키·위치 행 내용은 이 디렉터리에 보관하지 않는다. 화면은 사용자가 검증을 허용한 테스트 계정의 실제 화면이다. 중지/삭제/통보 기능을 운영에서 실행한 증빙이나, 암호화·MFA·백신·WAF의 최종 운영 인수 증빙은 아니다.
