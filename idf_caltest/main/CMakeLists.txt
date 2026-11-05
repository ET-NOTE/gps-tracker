set(APP_ENTRY "main.cpp")
if(FIRMWARE_PROFILE STREQUAL "tls-cert-test")
  set(APP_ENTRY "tls_cert_probe.cpp")
endif()
set(TLS_SOURCES "")
if(FIRMWARE_PROFILE STREQUAL "https-pilot" OR FIRMWARE_PROFILE STREQUAL "https-sleep-test" OR FIRMWARE_PROFILE STREQUAL "tls-cert-test")
  set(TLS_SOURCES "secure_http.cpp" "modem_tcp.cpp" "verified_tls.cpp")
endif()
idf_component_register(
  # Collection gate is common to operating and TLS pilot profiles.
  SRCS ${TLS_SOURCES} "${APP_ENTRY}" "lte.cpp" "hw_power.cpp" "buzzer.cpp" "breadcrumb.cpp" "gps.cpp" "motion.cpp" "telemetry.cpp" "recovery.cpp" "sleep_mgr.cpp" "device_security.cpp" "report_config.cpp" "collection_control.cpp"
  INCLUDE_DIRS "."
  REQUIRES arduino-esp32 TinyGPSPlus mbedtls json)
