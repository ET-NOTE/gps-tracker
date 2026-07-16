idf_component_register(
  SRCS "main.cpp" "lte.cpp" "hw_power.cpp" "buzzer.cpp" "breadcrumb.cpp" "gps.cpp" "motion.cpp" "telemetry.cpp" "recovery.cpp" "sleep_mgr.cpp"
  INCLUDE_DIRS "."
  REQUIRES arduino-esp32 TinyGPSPlus)
