#!/usr/bin/env python3
# =================================================================
# drive_logger.py — ESP32-C3 시리얼 상시 로거 (안정판)
#   · deep sleep 로 USB(CDC) 가 끊겨도 자동 재연결 (무한 재시도)
#   · 각 라인에 호스트 타임스탬프 [HH:MM:SS.mmm] → 실외 구간전환 상관분석용
#   · UTF-8 디코드(errors=replace) → 한글 깨짐/char-spacing 없음
#   · 라인 단위 flush → 크래시/정전에도 로그 유실 최소
#   · 연결/두절 마커 기록
#   사용: python drive_logger.py [COM포트] [baud]
#   중지: Ctrl+C
#   로그: Desktop\esp32c3-mini_gps\logs\serial_YYYYMMDD_HHMMSS.log
# =================================================================
import sys, os, time, datetime
import serial  # pyserial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM15"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
STALL_SEC = 25   # 연결됐는데 N초 무데이터 = CDC read 스톨 → 강제 재연결 (단말은 1s 마다 STATUS 출력)
LOGDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOGDIR, exist_ok=True)
LOGPATH = os.path.join(LOGDIR, "serial_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S") + ".log")


def ts():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def main():
    print(f"[logger] port={PORT} baud={BAUD}")
    print(f"[logger] -> {LOGPATH}")
    print("[logger] Ctrl+C to stop")
    f = open(LOGPATH, "a", encoding="utf-8", buffering=1)
    f.write(f"===== drive_logger start @ {datetime.datetime.now().isoformat()} port={PORT} =====\n")
    f.flush()
    connected = False
    try:
        while True:
            try:
                # ESP32-C3 USB-JTAG: open 시 DTR/RTS 어서트가 리셋 시퀀스를 유발 → 모니터가
                #   단말을 리셋(reset_cause=USB)하는 것 방지. dtr/rts 를 open 전에 False 로 고정.
                ser = serial.Serial()
                ser.port = PORT; ser.baudrate = BAUD; ser.timeout = 1
                ser.dsrdtr = False; ser.rtscts = False
                ser.dtr = False; ser.rts = False
                ser.open()
            except Exception:
                if connected:
                    f.write(f"----- [disconnected @ {ts()}] (port gone; deep sleep?) -----\n")
                    f.flush()
                    connected = False
                time.sleep(0.4)
                continue

            connected = True
            f.write(f"\n===== [connected @ {ts()}] =====\n")
            f.flush()
            buf = b""
            last_rx = time.time()
            try:
                while True:
                    data = ser.read(512)
                    if data:
                        last_rx = time.time()
                        buf += data
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            text = line.decode("utf-8", errors="replace").rstrip("\r")
                            f.write(f"[{ts()}] {text}\n")
                        f.flush()
                    elif time.time() - last_rx > STALL_SEC:
                        # 포트는 살아있는데 N초 무데이터 = USB CDC read 스톨(핸들 wedge).
                        #   강제 재연결 → blocking-CDC 단말이 리더 부재로 hang 되는 것도 완화.
                        f.write(f"----- [stall {STALL_SEC}s no-data @ {ts()}] force reconnect -----\n")
                        f.flush()
                        raise IOError("inactivity stall")
            except Exception:
                # 읽기 중 포트 상실 (deep sleep) → 재연결 루프로
                try:
                    ser.close()
                except Exception:
                    pass
                f.write(f"----- [read error/disconnect @ {ts()}] -----\n")
                f.flush()
                connected = False
                time.sleep(0.4)
    except KeyboardInterrupt:
        f.write(f"===== [stopped @ {ts()}] =====\n")
    finally:
        f.flush()
        f.close()
        print(f"[logger] stopped. log: {LOGPATH}")


if __name__ == "__main__":
    main()
