# 128차 실제 검증 증거

2026-11-15 빌드 호스트의 격리 합성 시험이다. **운영 화면·운영 부하·실물 단말기 증거가 아니다.** 후보114/API `5c6f4529207f9ab0d5d30598dbb4fe8a4e4b77dc4e5304a8736f311fdcdb7e52`를 사용했고 운영에 접속하지 않았다. [결과·제약·인계](../../operations/location-business-runtime128-20261115.md).

| 확인 항목 | 실제 원본 |
|---|---|
| 기존7행 보정의13만 행 해제 실패·수정판·압축2,007행 중단/재개·암호문 불변 |[backfill128.json](backfill128.json)|
| 실제 한 키 UPDATE의479행 해제, 실행 후 롤백 |[backfill128-plan.json](backfill128-plan.json)|
| 키/정책/배치/미검토115 거부·무제한 세션도5천으로 제한 |[backfill-guards128.json](backfill-guards128.json)|
| 단일99→114·15단계 실패 원복/재개·13만 행/파일3개 전체 암호화 복원 |[cumulative121.json](cumulative121.json),[정본114개](migration-bytes128.json)|
| 전체 복원 직후 월간 집계/이력/페이지·기준 해시 |[restored128.json](restored128.json)|
| 보정·재압축·재기동 후300초/3작업자 월간 TLS 부하 |[sustained128-compressed.json](sustained128-compressed.json),[재기동 첫 조회](restarted128-compressed.json)|
| 이전113 함수와585개 경계·쓰기·권한·키 대조 |[boundary128.json](boundary128.json)|
| 통계7개 보호 검사·복원DB 권리 잠금 대기 |[statistics-guards128.json](statistics-guards128.json)|
| 동의·철회·실제 정보주체 매핑·제공 경계20업무 |[22](round22-encrypted-integration.json),[22B](round22b-encrypted.json),[22D](round22d-encrypted.json),[실행 목록](regressions121.json)|
| PDF7업무 및10수명/소켓 검사 |[PDF 업무](receipt-pdf-validation.json),[수명](pdf-lifetime128.json)|
| 오래된 암호화 백업에 최신 중지·철회·파기를 적용 |[protected-restore121.json](protected-restore121.json)|
|32,000행/32단계 매핑 이력 |[mapping-history121.json](mapping-history121.json),[실행계획](mapping-history-plan.json)|
| 보호 서비스·3종 마운트 장애·작업 복구 |[runtime-faults121.json](runtime-faults121.json),[자원](resources121.json)|
| 빈 /run 연속2회 재기동 |[첫 회](reboot128-1.json),[두 번째](reboot128-2.json),[unit 순서](unit-order-verification.txt)|
| 최종TLS 월간 해시·타계정404·평문/미준비/이미지/대기/열린 거래0 |[final-state128.json](final-state128.json)|
| 조회 취소·429·슬롯 재사용 |[fairness124.json](fairness124.json),[cancellation122.json](cancellation122.json)|
| 실제 실행 소스·격리 설정·기존 입력 해시 |[running-source128.json](running-source128.json),[isolation128.json](isolation128.json),[backfill-inputs128.json](backfill-inputs128.json)|
| 실행 시각·경과·종료 코드·실패 로그 |[commands.jsonl](commands.jsonl),[API](api128-journal.log),[DB](db128-journal.log)|
| 보존 파일/다른 서비스 불변과 시험 자원 정리 |[시작](host-before.json),[정리](host-after.json)|
| 최종 복구·재현 묶음 |[candidate-manifest128.json](candidate-manifest128.json)|

파일명의121/122/124/126은 재사용한 검사기의 출처다. 실행 API/스키마는 위128 입력 해시와 어댑터로 고정했다. 원본 좌표·키·DB 비밀번호·전체 DB덤프·최신 권리 체크포인트 내용은 내보내지 않는다. 실제 무작위 시험 키와 비밀번호 문자열을 검사한 뒤 원본 크기·SHA-256을 대조했다.

초기 실패 로그도 남겼다. 중첩 트랜잭션의 설정 복원 보완, 낮은500 한도에서 앞선 키의 성공을 허용하는 시험 기대값, 압축 행의 미지원 SELECT FOR UPDATE를 실제 UPDATE 잠금으로 대체, 잠금 시험용 트랜잭션 롤백, 합성 정비 계정의 정렬 tablespace 권한, 실제3개인 압축 청크 수 기대값 정정을 포함한다. 실패를 통과 기록으로 덮어쓰지 않았으며 최종 완료 기록과 구분한다.

[remote-byte-check.json](remote-byte-check.json)은 빌드 호스트 원본의 크기/해시다. 정리·최종 묶음 기록은 나중에 별도 대조했다. [.gitattributes](.gitattributes)는 원본 줄바꿈을 보존하고 [sha256.json](sha256.json)은 최종 증거 디렉터리 파일을 검증한다. 이 묶음은 `activation_ready=false`이며 운영 설치기가 아니다.
