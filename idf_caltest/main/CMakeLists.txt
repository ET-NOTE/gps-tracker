set(APP_ENTRY "main.cpp")
if(FIRMWARE_PROFILE STREQUAL "tls-cert-test")
  set(APP_ENTRY "tls_cert_probe.cpp")
endif()
idf_component_register(
  SRCS "${APP_ENTRY}" "lte.cpp" "hw_power.cpp" "buzzer.cpp" "breadcrumb.cpp" "gps.cpp" "motion.cpp" "telemetry.cpp" "recovery.cpp" "sleep_mgr.cpp" "device_security.cpp" "report_config.cpp"
  INCLUDE_DIRS "."
  REQUIRES arduino-esp32 TinyGPSPlus mbedtls json)
