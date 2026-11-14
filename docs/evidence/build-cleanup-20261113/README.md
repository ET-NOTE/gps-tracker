# GPS 빌드 정리 실제 증빙

2026-11-13 빌드 호스트 `etcom-hub`에서만 실행했다. 운영 VPS 조회·변경 없음.

- `plan.json`: 삭제 후보 11개, 보존 압축본·바이너리 835개와 해시, 실행 서비스 상태.
- `removed.json`: 실제 삭제한 재생성 캐시 경로.
- `applied.json`: 12:18:15 KST 완료, 해시·서비스 불변, 디스크 여유 전후.
- `verification.log`: 후속 디스크 및 보존 캐시·환경 확인 출력.
- `duplicates-retained.json`: 동일 압축본 11묶음/추가 복사분 약37.15 MiB. 전부 보존.
- `evidence-sha256.json`: 이 폴더의 증빙 파일 해시(자기 자신 제외).

`plan.json`, `removed.json`, `applied.json`, `verification.log`는 빌드 호스트에서 받은 원본이다. 중복 분류 파일은 계획의 해시 목록에서 로컬로 산출했다. 인증정보·DB 내용은 수집하지 않았다.

실행 도구와 한계는 [정리 문서](../../operations/build-cleanup-20261113.md)에 기록했다. 자동 보관 제한은 켜지 않았으며 소스/릴리스/실제 백업은 삭제하지 않았다.
