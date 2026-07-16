idf_component_register(
  SRCS "main.cpp" "lte.cpp" "hw_power.cpp" "buzzer.cpp" "breadcrumb.cpp"
  INCLUDE_DIRS "."
  REQUIRES arduino-esp32)
