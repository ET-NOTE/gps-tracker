# KC 인증(콜박스) 시험용 빌드 — idf_caltest `KC_TEST_BUILD`

> 근거: `for_kc.txt` (시험소/전문가 상담 기록, 2026-08). 콜박스(기지국 시뮬레이터,
> Anritsu MT8821C / R&S CMW500 류 + 시험용 USIM PLMN 001/01)는 RRC 등록까지만 세우고
> PDP/데이터 세션은 안 붙는 경우가 많음 → 운영 펌웨어의 복구 에스컬레이션이 시험을 망침.

## 빌드 방법

[idf_caltest/main/config.h](../idf_caltest/main/config.h) 맨 아래:

```c
#define KC_TEST_BUILD   1     // ← 0 → 1
```

```
idf.py fullclean 없이 그냥: idf.py build
플래시:                    idf.py -p COMxx flash
```

**⚠️ 시험 끝나면 반드시 0 원복 후 재빌드.** (TIMER_WAKE 토글 사고와 동일한 함정 — 운영 배포 전 grep 확인: `grep "KC_TEST_BUILD   1" idf_caltest/main/config.h` 가 안 나와야 함)

## KC_TEST_BUILD=1 이 바꾸는 것

| 항목 | 운영 | KC 시험 |
|---|---|---|
| 복구 에스컬레이션 (soft/hardCycle/esp_restart) | ON | **전부 OFF** — 모뎀 항상 ON, bringUp 재시도만 |
| PDP(CNACT/APN) + 서버 POST | ON | **스킵** — 등록(reg=1\|5)만으로 ONLINE |
| deep sleep (stationary/timer) | ON | OFF (`SLEEP_DISABLED=1`) |
| loop task WDT (60s panic reset) | ON | OFF |
| 부저 (GPIO1) | ON | OFF (EMI/LTE 간섭원 차단) |
| PLMN | 모뎀 기본 | **`AT+COPS=0` 명시** (자동 — 시험용 PLMN 001/01 에 붙도록) |
| 밴드 | 전체 | **`AT+CBANDCFG` 락** (아래 설정) + 응답 캡처 로그 |
| RAT | CNMP=38 + CMNB=3 | CNMP=38 + **CMNB=1(Cat-M only)** ← `KC_CATM_ONLY=1` 시 |

## 밴드 락 설정 (config.h)

```c
#define KC_BAND_CATM    "5"   // 인증표 Cat-M1: B5/B8/B3 중 — 복수는 "5,8"
#define KC_BAND_NBIOT   "5"   // 인증표 NB-IoT: B5/B3 중
#define KC_CATM_ONLY    1     // NB 미인증이면 1 (CMNB=1)
```

실측 참고: 2026-08-27 device 3005 가 1NCE 로밍으로 **Cat-M1 B5** 에 등록 (telemetry `band:"M1-B5"`).
**어떤 밴드로 인증할지는 시험소 견적 확정 후 결정** — 밴드 수가 비용을 좌우 (2밴드 ≈ 270만원).

### 증빙 캡처 (시험소 제출)

부팅 시리얼 로그에 자동 출력됨:

```
[KC] band-lock evidence: AT+CBANDCFG? +CBANDCFG: "CAT-M",5 +CBANDCFG: "NB-IOT",5 OK
```

이 라인 캡처 + 제조사 선언서 조합 = "펌웨어 밴드 제한" 증빙 (for_kc.txt 116행).

### ⚠️ CBANDCFG 는 모듈 NVRAM 에 저장됨

시험 빌드를 돌린 모듈은 락이 **모듈에 남는다**. 전체 밴드 복원 (일반 개발로 돌릴 때):

```
AT+CBANDCFG="CAT-M",1,2,3,4,5,8,12,13,14,18,19,20,25,26,27,28,66,85
AT+CBANDCFG="NB-IOT",1,2,3,4,5,8,12,13,18,19,20,25,26,28,66,71,85
AT+CMNB=3
```

(모듈이 지원 안 하는 밴드는 에러 — `AT+CBANDCFG=?` 로 지원 목록 확인 후 그 목록으로.)
**단, 밴드 제한을 근거로 인증받으면 양산 펌웨어도 락을 유지해야 함** — 인증 확정 후
운영 빌드(bringUp)에 락을 상시 반영하는 후속 작업 필요.

## 시험소 샘플 체크리스트 (for_kc.txt 175행)

- [ ] 정상 완제품 샘플 2~3대 (복사성 방출)
- [ ] **RF 커넥터 인출 지그 샘플 1대** (전도성 — 안테나 급전점에 RG178 직결. 시험소와 사전 협의)
- [ ] 시험용 펌웨어 = 이 KC_TEST_BUILD (워치독 off, COPS=0, 밴드 락)
- [ ] 12V 전원 케이블
- [ ] `[KC] band-lock evidence` 캡처 + 밴드 제한 선언서
- [ ] SIM7080G 모듈 KC 인증서 (대리점 — 에드웍스 등에 요청)
- [ ] 동작 설명서 / 시험 모드 진입 방법 (= KC 빌드 플래시된 상태로 전원 인가만 하면 됨)

## 시험소 확인 질문 (미해결)

1. 밴드 제한 증빙(선언서+펌웨어 로그) 인정 여부 → 인정 시 1밴드 재견적
2. SIM7080G 모듈 KC 인증서 제출 시 무선시험 면제 여부
3. RF 테스트 모드 펌웨어 별도 필요 여부 (콜박스 RRC 전력제어로 충분한지)
