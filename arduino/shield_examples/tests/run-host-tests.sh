#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="$(mktemp -d /tmp/shield-example-tests.XXXXXX)"
trap 'rm -rf "$output"' EXIT
flags=(-std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -g)
fakes=07_easy_https/tests/fakes
g++ "${flags[@]}" -I"$fakes" -Icommon/auto 07_easy_https/tests/transcript.cpp common/auto/EasyHttps.cpp -o "$output/https"
"$output/https"
g++ "${flags[@]}" -I"$fakes" -Icommon/auto 07_easy_https/tests/enrollment.cpp -o "$output/eeprom"
"$output/eeprom"
g++ "${flags[@]}" -I"$fakes" -I08_shield_http_pairing/src 08_shield_http_pairing/tests/transcript.cpp 08_shield_http_pairing/src/ShieldHttp.cpp -o "$output/http"
"$output/http"
g++ "${flags[@]}" -I"$fakes" -I08_shield_http_pairing/src 08_shield_http_pairing/tests/serial_code.cpp -o "$output/serial"
"$output/serial"
