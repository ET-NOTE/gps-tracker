# etcom-hub 빌드 러너

Windows가 소스와 배포를 제어하고 Hub는 빌드 산출물만 반환한다.

`Windows Git commit → etcom-hub 컨테이너 빌드·검사 → Windows 해시 확인 → dev VPS 사전 검사·배포`

## 사양과 격리

2026-09-24 확인: Hub 32 CPU 스레드, 메모리 31,189MiB 중 가용 26,513MiB, 디스크 58GB 가용. Node v22.22.2, Docker 29.5.2.
호스트 glibc 2.39와 VPS glibc 2.35 차이가 있어 Debian bullseye 기반 Rust 1.88.0/Node 22.22.2 이미지에서 빌드한다.
Rustfmt/Clippy와 npm lockfile 검사를 같은 이미지에서 수행한다. Node 배포 파일은 공식 SHASUMS256으로 확인한다.

- 작업 디렉터리: Hub `~/build/gps-tracker`, 전용 `flock`으로 동시 빌드 차단.
- 빌드 컨테이너: 최대 CPU 4개, 메모리 6GiB, swap 추가 사용 없음, PID 512개. 호스트 포트와 GPU를 사용하지 않는다.
- 시스템 Node/운영 KC·AI·카메라 서비스 설정을 바꾸지 않는다.
- Windows가 커밋된 API/웹/ops만 보내며 `.env.example` 외 환경 파일을 거부한다. DB 덤프·VPS SSH 키·사용자 홈을 컨테이너에 전달하지 않는다.
- Cargo/Node 캐시는 프로젝트 전용이며 기존 다른 프로젝트의 Docker 이미지나 캐시는 정리하지 않는다.
- 산출물에 Git 커밋, 소스/API/웹 해시, 도구 버전, 빌더 이미지 ID를 기록한다.

[Docker 자원 제한 공식 문서](https://docs.docker.com/engine/containers/resource_constraints/), [Rust 공식 이미지](https://hub.docker.com/_/rust).

## Windows 명령

```powershell
# 의도한 변경을 커밋하고 작업 트리가 깨끗한 상태에서 실행
.\ops\Build-HubRelease.ps1

# 위 명령이 반환한 로컬 산출물 디렉터리를 지정. dev만 지원.
.\ops\Deploy-DevArtifact.ps1 -ArtifactDirectory "$env:LOCALAPPDATA\GPS-Builds\dev-YYYYMMDD-HHMMSS-COMMIT7"
```

빌드 명령 자체는 배포하지 않는다. 개발 배포는 DB/환경/기존 API 백업 → 3042 임시 API + 회귀 검사 → dev API/web 전환 → health 및 공개 HTTPS 회귀 검사의 순서다.
사전 검사에는 기존 dev `.env.dev.validation`을 사용한다. 3042 포트가 이미 사용 중이면 중단한다.
전환 후 health가 실패하면 직전 API/웹을 복원한다. DB migration을 자동으로 되돌리지는 않으므로, 향후 비호환 migration은 별도 전환 설계가 필요하다.
기존 API/웹 `deploy.sh`의 VPS 내 빌드 경로는 비활성화했다. **prod 배포 명령은 제공하지 않으며 명시적 허가와 별도 릴리스 검토가 필요하다.**

매 빌드마다 소스·산출물을 보관하므로 오래된 Hub 릴리스/캐시 정리는 추후 보존 정책에 따라 한다. 전역 `docker prune`은 사용하지 않는다.
