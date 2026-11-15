# 129차 실제 검증 증거 — 2026-11-15

**검증 완료 / 8조회 혼합 부하의 8대×1Hz 무누락 기준 미달 / 운영 미배포.** 실제 합성 DB·API·TLS·PDF·정리 작업에서 수집한 원본이다. `audit129-*`의 보호·저장 검사 통과와 용량 판정을 구분한다. 전용·공유의 `capacity_passed`는 false이고 낮은 조회 부하 진단만 true다. 제품 API/SQL은 변경하지 않았다.

| 확인할 내용 | 원본 |
|---|---|
| 사전 부하·인수 기준, 실제 자원 상한 | [criteria129.json](criteria129.json), [isolation129.json](isolation129.json), `units/`, 각 부하의 before/after/resources |
| 실행 시각·종료 코드·실패 traceback | [commands.jsonl](commands.jsonl), 날짜가 붙은 seed/dedicated/shared/shared-low/final 로그 |
| 압축 6청크·8SIM·119,040행·714,240점 | [fixture129.json](fixture129.json), [seed122.json](seed122.json) |
| 압축 전후·최종 28응답 의미 해시 | [압축 전](equivalence129-before.json), [압축 후](equivalence129-compressed.json), [최종](equivalence129-final.json) |
| 전용·공유·낮은 조회 부하의 전 요청/전송/카운터·자원 | [전용](dedicated-129.json), [공유](shared-129.json), [진단](shared-low-129.json), `temp129-*.json` |
| 미발송과 저장 누락 구분·발송 카운터 전량 일치 | [전용 검사](audit129-dedicated.json), [공유 검사](audit129-shared.json), [진단 검사](audit129-shared-low.json) |
| HTTP·재시도·DB 연결/처리 시간 | [summary129.json](summary129.json), `timings124-*-129.json` |
| 공유 부하 중 30회 DB 대기·WAL·I/O 표본 | [wait-observation129-shared.json](wait-observation129-shared.json) |
| 동의·철회·권한·취소/429·정리·최종 상태 | [final129.json](final129.json), `rights124.log`, `fairness124.json`, `final-state122.json`, 관련 로그·어댑터 |
| 실제 실행 소스·unit·API/DB 출력 | [running-source129.json](running-source129.json), [api129-journal.log](api129-journal.log), [db129-journal.log](db129-journal.log), `units/` |
| 시험 자원만 정리·기존 자료/다른 서비스 불변 | [host-after.json](host-after.json), [정리 바이트 대조](post-cleanup-byte-check.json) |
| 재현 묶음·코드·의존 후보 | [candidate-manifest129.json](candidate-manifest129.json), [묶음 바이트 대조](post-package-byte-check.json) |

빌드 호스트 원본 67개를 실제 무작위 저장키·DB 비밀번호·개별 HMAC 키와 대조한 뒤 반출했다. [remote-byte-check.json](remote-byte-check.json)의 크기·SHA와 다운로드 바이트가 모두 같고, 원본 증거 아카이브 SHA는 `8803848f2e1c99843e2d219a7995d519b19c515328c471937abd14e16db3ae02`다. `.gitattributes`로 Git의 줄바꿈 변환을 막았으며 [sha256.json](sha256.json)에 정리·묶음·안내를 포함한 최종 74파일의 해시를 고정한다.

진단 `timings124-shared-low-129.json`은 후속 무부하 대조까지 포함한 원본이므로 API 단계 p95 요약에서는 제외했다. 별도의 클라이언트 부하 기록은 유효하다. 이후 검증기는 기존 부하 종료 계측을 보존하도록 수정했다.

`GPS121/122/124` 이름의 unit·함수·출력은 기존 검증기를 129 환경에서 다시 실행한 것이다. 이전 결과 파일을 통과 증거로 복사하지 않았다. 99→114 전체 전환·복원은 [128차](../runtime128-20261115/README.md)의 결과이며 이번 129차 재실행 항목은 아니다.

시험 범위는 내부망 합성 TLS 1.2와 warm cache다. 현재 3GB 운영 VPS·실물 LTE·실제 백신/다른 프로젝트·콜드 캐시·장기 부하를 대신하지 않는다. 월간 조회 SIM과 신규 수신 SIM은 별개다. `shared-low`는 개인 월간 집계·이력·페이지만 남긴 2작업자 진단으로, 8작업자와 요청 구성까지 같지는 않다. 계획된 시험량은 제품의 확정된 운영 SLA가 아니다.
