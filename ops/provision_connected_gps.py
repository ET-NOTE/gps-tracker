"""Provision an already verified USB device; never prints the secret or erases flash."""
import argparse
import json
from pathlib import Path
import time
import serial

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('credential',type=Path);p.add_argument('--port',required=True)
a=p.parse_args();data=json.loads(a.credential.read_text())
assert len(data['key'])==64 and all(x in '0123456789abcdef' for x in data['key'])
assert 0<len(data['device_uid'])<=64 and all(x.isascii() and (x.isalnum() or x in '-_') for x in data['device_uid'])
s=serial.Serial(port=None,baudrate=115200,timeout=.3);s.dtr=False;s.rts=False;s.port=a.port;s.open()
try:
 s.write(('AUTH '+data['device_uid']+' '+data['key']+'\n').encode());s.flush()
 deadline=time.monotonic()+25;received=''
 while time.monotonic()<deadline:
  try: chunk=s.read(s.in_waiting or 1).decode(errors='replace')
  except serial.SerialException: break
  received+=chunk
  if '[AUTH] Provisioned.' in received:
   print('PASS: device accepted its private credential and is restarting.');break
 else: raise SystemExit('Provisioning acknowledgement not received; inspect the serial log without resending blindly.')
 if '[AUTH] Provisioned.' not in received: raise SystemExit('Device disconnected before a provisioning acknowledgement.')
finally: s.close()
