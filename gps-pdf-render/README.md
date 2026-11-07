# gps-pdf-render

저장된 PDF의 한 쪽을 검토·제공용 RGB 이미지로 그리는 격리 처리기다. `gps-tracker-api`와 **별도 프로그램, 별도 툴체인**으로 빌드하며 API는 이 프로그램과 파이프 2개로만 통신한다. 설계와 검증 기록은 [16차 문서](../docs/operations/location-rights-round16-20261106.md)에 있다.

## 동작

```
gps-pdf-render            요청 1건 처리 (stdin → stdout)
gps-pdf-render selftest   이 커널에서 제한이 실제로 걸리는지, 그 안에서 렌더링되는지 확인
```

- 요청: `GPSPDF1\n`, 쪽 번호(u32, 1부터), 길이(u32), PDF 바이트. 모든 정수는 빅엔디언.
- 응답: `GPSPDF1\n`, 상태(u32). 상태가 0이면 폭, 높이, 쪽수, 쪽 폭·높이(1/1000pt)와 `폭×높이×3` 바이트의 RGB.
- 상태: 0 정상, 1 잘못된 요청, 2 읽을 수 없는 PDF, 3 암호화, 4 쪽수 초과(200), 5 없는 쪽, 6 쪽 크기 초과, 7 렌더링 실패.
- 출력은 한 변 2048px·100만 화소 이하이며 배경은 흰색이다.

입력을 읽기 전에 `src/sandbox.rs`의 제한을 적용한다. 새 권한 획득 금지, 자원 한도(주소 공간 768MB, CPU 10초, 파일 쓰기 0, 새 프로세스 0), 그리고 파일·네트워크·프로세스 관련 호출이 없는 시스템 호출 허용 목록이다. 제한을 적용하지 못하면 입력을 읽지 않고 끝낸다.

## 빌드

API의 빌드 이미지가 아니라 전용 이미지(`ops/pdf-builder.Dockerfile`, Rust 1.92.0)를 쓴다.

```bash
cargo fmt --check
cargo clippy --locked --all-targets --target x86_64-unknown-linux-musl -- -D warnings
cargo test --locked --target x86_64-unknown-linux-musl
cargo build --locked --release --target x86_64-unknown-linux-musl
```

결과물은 정적 바이너리 하나다. API 바이너리와 같은 디렉터리에 `gps-pdf-render`라는 이름으로 두면 API가 찾는다(다른 위치는 `GPS_PDF_RENDERER`). 한글 대체 글꼴은 `gps-tracker-web/src/assets/fonts`의 나눔고딕을 빌드 때 포함한다.

## 렌더러 평가

`eval/`의 스크립트로 합성 표본을 만들고 poppler와 비교한다. poppler·qpdf는 `ops/pdf-tools.Dockerfile`의 시험용 이미지에만 있으며 배포하지 않는다.

```bash
node eval/make_korean.cjs <gps-tracker-web> <corpus>          # 한글·표 문서 (글꼴 내장)
python3 eval/make_corpus.py <corpus>                          # 미내장 글꼴, 스캔, 암호화, 손상, 과대 문서
python3 eval/evaluate.py <gps-pdf-render> <corpus> <results>  # 품질·시간·메모리
```
