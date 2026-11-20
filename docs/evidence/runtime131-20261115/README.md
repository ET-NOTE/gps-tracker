# 131차 실제 검증 증거

합성 내부망의 실제 출력이다. 운영/실물 증거와 구분한다. [구현·결과·한계](../../operations/location-business-runtime131-20261115.md).

- `summary131.json`, `*-131.json`, `audit131-*.json`: 기존300초 두 조건, 개별 요청·재시도/미발송·실제DB 대조·보호 상태.
- `endpoints131.json`, `download131.json`: 암호화된 이전/수정 SQL 결과·실행계획, 실제TLS XLSX429/취소/재시도/타인 데이터 제외.
- `equivalence131-*.json`: 암호화/압축/수정 뒤28응답의 의미 비교. XLSX의 작성시각만 제외.
- `guards131-candidate.json`, `rights124.log`, `fairness124.json`, `cancellation122.json`, `read-settings131.log`: 수집·권리·조회보호 기능 회귀.
- `build-api.log`, `source131-*.json`, `running-source131*.json`, `installed131-candidate.json`: 빌드/소스/실행 일치. `commands.jsonl`·시각별 로그는 실패도 보존한다.
- `final131.json`, `final-state122.json`, `host-after.json`: 평문/열린거래/이미지/정리대기0, 시험 자원만 정리한 상태.
- `candidate-manifest131.json`: 소스·바이너리·증거 재현 묶음, 운영 설치기가 아니다.

원격 원본 81개는 `remote-byte-check.json`의 크기/SHA와 모두 같다. 원본에 실제 시험키·DB 비밀번호가 없는지 검사했다. 압축 SHA `4a2353858f0cc3eecfb523dfb76f73f10f5400cc92fe751403402b37b2d2f0e9`. 아래 전체 목록은 원격 원본에 정리/묶음·인계용 메타데이터를 더한 해시다.
