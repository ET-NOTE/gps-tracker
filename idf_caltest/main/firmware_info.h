#pragma once
#include "config.h"

#ifndef FIRMWARE_BUILD_TAG
#error "Firmware identity must be supplied by the profile build"
#endif

// This string is printed at boot AND extracted from the actual .bin by the build
// tool. Thus the manifest records compiled settings, not the operator's intent.
#define FW_STRING_IMPL(x) #x
#define FW_STRING(x) FW_STRING_IMPL(x)
namespace firmware {
inline constexpr char settings[] =
  "FW-CONFIG:{\"build_tag\":\"" FIRMWARE_BUILD_TAG "\","
  "\"ingest_url\":\"" POST_URL_HOST POST_PATH "\","
#if GPS_HTTPS_PILOT
  "\"tls_engine\":\"esp32_mbedtls\",\"tls_hostname_verify\":1,"
#endif
#if GPS_TLS_CERT_TEST
  "\"request_auth\":\"none_test_probe\",\"response_auth\":0,\"credential_store\":\"unused\","
#else
  "\"request_auth\":\"hardware_hmac_sim_v2\",\"response_auth\":1,\"credential_store\":\"nvs\","
#endif
  "\"version\":\"" FIRMWARE_VERSION "\",\"profile\":\"" FIRMWARE_PROFILE "\","
  "\"kc_test\":" FW_STRING(KC_TEST_BUILD) ","
  "\"sleep_disabled\":" FW_STRING(SLEEP_DISABLED) ","
  "\"timer_wake_enabled\":" FW_STRING(TIMER_WAKE_ENABLED) ","
  "\"timer_wake_s\":" FW_STRING(TIMER_WAKE_INTERVAL_S) ","
  "\"sleep_bench\":" FW_STRING(GPS_HTTPS_SLEEP_TEST) ","
  "\"sleep_bench_max_cycles\":" FW_STRING(SLEEP_TEST_MAX_CYCLES) ","
  "\"buzzer_enabled\":" FW_STRING(BUZZER_ENABLED) ","
  "\"loop_wdt_enabled\":" FW_STRING(LOOP_WDT_ENABLED) ","
  "\"stationary_ms\":\"" FW_STRING(STATIONARY_WINDOW_MS) "\","
  "\"timer_wake_us\":\"" FW_STRING(TIMER_WAKE_INTERVAL_US) "\","
  "\"no_gps_grace_ms\":\"" FW_STRING(NO_GPS_SLEEP_GRACE_MS) "\","
  "\"pwrkey_pin\":" FW_STRING(PIN_PWRKEY) ","
  "\"pwrkey_pulse_ms\":" FW_STRING(PWRKEY_PULSE_MS)
#if KC_TEST_BUILD
  ",\"catm_bands\":\"" KC_BAND_CATM "\",\"nbiot_bands\":\"" KC_BAND_NBIOT "\","
  "\"catm_only\":" FW_STRING(KC_CATM_ONLY)
#endif
  "}";
static_assert(!KC_TEST_BUILD || (SLEEP_DISABLED && !BUZZER_ENABLED && !LOOP_WDT_ENABLED),
              "KC power/sleep protections must remain enabled");
static_assert(!BATTERY_TEST_BUILD || (!KC_TEST_BUILD && SLEEP_DISABLED && LOOP_WDT_ENABLED && BUZZER_ENABLED),
              "Battery profile must preserve operating protections and disable sleep");
static_assert(!GPS_HTTPS_SLEEP_TEST || (!SLEEP_DISABLED && TIMER_WAKE_ENABLED &&
              LOOP_WDT_ENABLED && !KC_TEST_BUILD && !BATTERY_TEST_BUILD),
              "Sleep bench must use the real protected sleep/wake path");
}
#undef FW_STRING
#undef FW_STRING_IMPL
