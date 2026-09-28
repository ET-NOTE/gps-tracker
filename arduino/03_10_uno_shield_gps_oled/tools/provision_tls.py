#!/usr/bin/env python3
"""SIM7080G provisioning through tls_bridge; no payment/provider API calls.

Private transcripts/identifiers stay in the operator's output directory, not Git.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import serial
import sys
import time
sys.stdout.reconfigure(encoding='utf-8')

class Modem:
    def __init__(self,port,output):
        self.port=serial.Serial(port,115200,timeout=0.1)
        self.log=(output/'provision-private.log').open('a',encoding='utf-8')
        time.sleep(2)
        self.port.reset_input_buffer()
    def send(self,data):
        # SoftwareSerial TX temporarily masks UNO UART interrupts. No USB bursts.
        for byte in data:
            self.port.write(bytes([byte]));time.sleep(0.002)
    def until(self,markers,timeout):
        deadline=time.monotonic()+timeout;data=b''
        while time.monotonic()<deadline:
            data+=self.port.read(self.port.in_waiting or 1)
            if any(marker in data for marker in markers):break
        text=data.decode('ascii','replace')
        self.log.write(text);self.log.flush()
        return text
    def command(self,command,timeout=5,required=True,private=False):
        self.log.write('\n> '+command+'\n');self.log.flush()
        self.send((command+'\r').encode())
        answer=self.until([b'\r\nOK\r\n',b'\r\nERROR\r\n',b'+CME ERROR:'],timeout)
        if '+CME ERROR:' in answer and not answer.endswith('\r\n'):
            answer+=self.until([b'\r\n'],2)
        ok='\r\nOK\r\n' in answer
        print(('OK ' if ok else 'FAIL ')+command+(' [private response]' if private else ' '+answer.strip().replace('\r\n',' | ')[:250]),flush=True)
        if required and not ok:raise RuntimeError('Modem command failed: '+command)
        return answer
    def close(self):self.port.close();self.log.close()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['probe','provision','verify'])
    p.add_argument('--port',default='COM26');p.add_argument('--output',type=Path,required=True)
    p.add_argument('--ca',type=Path);p.add_argument('--sha256')
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    if a.mode=='provision' and (not a.ca or not a.sha256):
        p.error('provision requires --ca and --sha256 from a trusted certificate source')
    m=Modem(a.port,a.output)
    try:
        m.command('AT');m.command('ATE0');m.command('AT+CMEE=2')
        m.command('AT+CGNSPWR=0')
        state=m.command('AT+SHSTATE?')
        if '+SHSTATE: 1' in state:m.command('AT+SHDISC')
        if a.mode=='probe':
            m.command('AT+CGMR');m.command('AT+CCLK?');m.command('AT+CSSLCFG=?');m.command('AT+SHSSL?')
            sim=m.command('AT+CCID',private=True)
            imei=m.command('AT+GSN',private=True)
            ids={'iccid':re.findall(r'\b\d{19,20}\b',sim),'imei':re.findall(r'\b\d{15}\b',imei)}
            (a.output/'hardware-identifiers.json').write_text(json.dumps(ids),encoding='utf-8')
            return
        if a.mode=='provision':
            cert=a.ca.read_bytes()
            assert hashlib.sha256(cert).hexdigest()==a.sha256
            assert b'-----BEGIN CERTIFICATE-----' in cert and len(cert)<4000
            m.command('AT+CFSINIT')
            m.send(f'AT+CFSWFILE=3,"shield-ca.pem",0,{len(cert)},10000\r'.encode())
            assert 'DOWNLOAD' in m.until([b'DOWNLOAD',b'ERROR'],5)
            m.send(cert)
            assert '\r\nOK\r\n' in m.until([b'\r\nOK\r\n',b'ERROR'],10)
            print('CA transferred; bytes='+str(len(cert)),flush=True)
            size=m.command('AT+CFSGFIS=3,"shield-ca.pem"')
            assert str(len(cert)) in size
            m.command('AT+CFSTERM')
            m.command('AT+CSSLCFG="CONVERT",2,"shield-ca.pem"',timeout=15)
        clock=m.command('AT+CCLK?')
        if not re.search(r'"(?:2[6-9]|[3-6][0-9])/',clock):
            m.command('AT+CNTPCID=0')
            m.command('AT+CNTP="time.cloudflare.com",0')
            result=m.command('AT+CNTP')
            if '+CNTP:' not in result:result+=m.until([b'+CNTP:',b'ERROR'],45)+m.until([b'\r\n'],2)
            print('NTP '+result.strip().replace('\r\n',' | '),flush=True)
            clock=m.command('AT+CCLK?')
            assert re.search(r'"(?:2[6-9]|[3-6][0-9])/',clock),'Valid RTC required; no verification bypass'
        m.command('AT+CSSLCFG="SSLVERSION",1,3')
        m.command('AT+CSSLCFG="IGNORERTCTIME",1,0')
        m.command('AT+CSSLCFG="SNI",1,"shield.serial.kr"')
        m.command('AT+SHSSL=1,"shield-ca.pem"')
        m.command('AT+SHCONF="URL","https://shield.serial.kr"')
        m.command('AT+SHCONF="BODYLEN",1024')
        m.command('AT+SHCONF="HEADERLEN",350')
        m.command('AT+CNACT?')
        m.command('AT+SHCONN',timeout=60)
        m.command('AT+SHSTATE?');m.command('AT+SHCHEAD')
        result=m.command('AT+SHREQ="/",1',timeout=15)
        if '+SHREQ:' not in result:result+=m.until([b'+SHREQ:',b'ERROR'],45)
        if '+SHREQ:' in result and not re.search(r'\+SHREQ: "GET",\d+,\d+\r\n',result):
            result+=m.until([b'\r\n'],2)
        print('HTTPS response '+result.strip().replace('\r\n',' | '),flush=True)
        m.command('AT+SHDISC')
        assert re.search(r'\+SHREQ: "GET",200,[1-9]\d*',result),'HTTPS GET did not return 200 with a body'
    finally:m.close()

if __name__=='__main__':main()
