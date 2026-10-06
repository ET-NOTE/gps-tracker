"""Install a reviewed public root CA via example 01_connection. Does not send device keys or data."""
import argparse, hashlib, time
from pathlib import Path
import serial

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port',required=True);p.add_argument('--pem',type=Path,required=True)
    p.add_argument('--sha256',required=True)
    p.add_argument('--name',choices=['shield-example-ca.pem','firebase-example-ca.pem'],required=True)
    a=p.parse_args();data=a.pem.read_bytes()
    if not 500<len(data)<4000 or b'-----BEGIN CERTIFICATE-----' not in data or hashlib.sha256(data).hexdigest()!=a.sha256.lower():
        p.error('Certificate format/size/SHA256 mismatch. Use the certificate manifest from this package.')
    with serial.Serial(a.port,115200,timeout=0.1) as port:
        def until(markers,timeout):
            end=time.monotonic()+timeout;reply=b''
            while time.monotonic()<end:
                reply+=port.read(port.in_waiting or 1)
                if any(m in reply for m in markers):return reply
                if len(reply)>16000:raise RuntimeError('Unexpected modem response size')
            raise RuntimeError('Timed out; check example 01, serial monitor closed, port, power and baud.')
        def send(value):
            for byte in value:port.write(bytes([byte]));time.sleep(.002)
        def command(text,timeout=5):
            port.reset_input_buffer();send((text+'\r').encode('ascii'))
            reply=until([b'\r\nOK\r\n',b'ERROR'],timeout)
            if b'\r\nOK\r\n' not in reply:raise RuntimeError('Modem rejected certificate operation: '+text.split('=')[0])
            return reply
        until([b'[READY]'],75)
        command('AT');command('ATE0');command('AT+CGNSPWR=0')
        if b'+SHSTATE: 1' in command('AT+SHSTATE?'):command('AT+SHDISC',15)
        if b'+SHSTATE: 0' not in command('AT+SHSTATE?'):raise RuntimeError('HTTP session is still active')
        command('AT+CFSINIT')
        try:
            send(f'AT+CFSWFILE=3,"{a.name}",0,{len(data)},10000\r'.encode())
            if b'DOWNLOAD' not in until([b'DOWNLOAD',b'ERROR'],5):raise RuntimeError('No certificate upload prompt')
            send(data)
            if b'\r\nOK\r\n' not in until([b'\r\nOK\r\n',b'ERROR'],15):raise RuntimeError('Certificate write failed')
            answer=command(f'AT+CFSGFIS=3,"{a.name}"')
            if str(len(data)).encode() not in answer:raise RuntimeError('Certificate size mismatch')
        finally:command('AT+CFSTERM')
        command(f'AT+CSSLCFG="CONVERT",2,"{a.name}"',20)
        print(f'Installed {a.name}: {len(data)} bytes. Upload example 04 or 05 next.')

if __name__=='__main__':main()
