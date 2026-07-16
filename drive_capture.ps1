# =================================================================
# drive_capture.ps1 — 운행 중 시리얼 연속 캡처.
#   deep sleep 로 USB(CDC)가 끊겼다 wake 시 재등장하면 자동 재연결·append.
#   중지: 이 창에서 Ctrl+C. 로그는 Desktop\esp32c3-mini_gps\drive_*.log.
# =================================================================
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$port = "COM15"
$log  = "C:\Users\test\Desktop\esp32c3-mini_gps\drive_$(Get-Date -Format yyyyMMdd_HHmmss).log"
Write-Host "===== 캡처 시작 ====="
Write-Host "로그 파일: $log"
Write-Host "중지하려면 Ctrl+C"
while ($true) {
  ("`n===== [connect @ {0}] =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) | Out-File -Append -Encoding utf8 $log
  # 포트가 없으면 arduino-cli monitor 가 즉시 실패 → 아래 sleep 후 재시도 (wake 대기)
  arduino-cli monitor -p $port --config baudrate=115200 *>> $log
  ("===== [disconnect @ {0}] — 재연결 대기 =====" -f (Get-Date -Format 'HH:mm:ss')) | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 2
}
