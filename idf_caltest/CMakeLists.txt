cmake_minimum_required(VERSION 3.16)
# ? C3 USB-Serial-JTAG CDC ? Serial ? (arduino-cli ? CDCOnBoot=cdc ??). ?? ??? Serial=UART0=GPS ??.
add_compile_definitions(ARDUINO_USB_CDC_ON_BOOT=1 ARDUINO_USB_MODE=1)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(caltest)
