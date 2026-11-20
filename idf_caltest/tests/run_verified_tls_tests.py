#!/usr/bin/env python3
"""Real Mbed TLS + loopback OpenSSL certificate and HTTP boundary tests. No device/API."""
import importlib.util
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading

ROOT=Path(__file__).resolve().parent

def main():
    source=Path(os.environ['IDF_PATH'])/'components/mbedtls/mbedtls'
    build=ROOT.parent/'build/host-mbedtls'
    subprocess.run(['cmake','-S',str(source),'-B',str(build),'-DENABLE_PROGRAMS=OFF','-DENABLE_TESTING=OFF'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['cmake','--build',str(build),'-j4'],check=True,stdout=subprocess.DEVNULL)
    exe=build/'verified-tls-test'
    subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-Werror','-I',str(source/'include'),
        str(ROOT/'verified_tls_test.cpp'),str(ROOT.parent/'main/verified_tls.cpp'),
        '-L',str(build/'library'),'-lmbedtls','-lmbedx509','-lmbedcrypto','-pthread','-o',str(exe)],check=True)
    spec=importlib.util.spec_from_file_location('fixture',ROOT.parent/'tools/tls_cert_fixture.py')
    fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
    with tempfile.TemporaryDirectory(prefix='gps-mcu-tls-test-') as tmp:
        folder=Path(tmp)/'certs';fixture.generate(folder)
        tests=[('valid','gps.serial.kr',0,b'Content-Length: 4\r\n\r\ntest',True),
               ('expired','gps.serial.kr',1,b'',False),
               ('untrusted','gps.serial.kr',8,b'',False),
               ('wrong-host','gps.serial.kr',4,b'',False),
               # The same wrong-host certificate succeeds for its actual DNS name.
               ('wrong-host','wrong-host.invalid',0,b'Content-Length: 4\r\n\r\ntest',True),
               ('valid','gps.serial.kr',0,b'Transfer-Encoding: chunked\r\n\r\n2\r\nte\r\n2\r\nst\r\n0\r\n\r\n',True)]
        for bad in [b'Content-Length: 4\r\n',b'Content-Length: 4\r\n\r\nte',
                    b'Content-Length: 4\r\nContent-Length: 4\r\n\r\ntest',
                    b'Content-Length: 2048\r\n\r\n',b'Transfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n',
                    b'Transfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n',b'\r\ntest']:
            tests.append(('valid','gps.serial.kr',0,bad,False))
        for case,host,flags,payload,expected in tests:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(10)
                ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_2
                ctx.load_cert_chain(folder/(case+'.pem'),folder/(case+'.key'))
                seen=[]
                def serve():
                    raw,_=listener.accept();raw.settimeout(5)
                    try:
                        with ctx.wrap_socket(raw,server_side=True) as conn:
                            request=conn.recv(2048);seen.append(request)
                            conn.sendall(b'HTTP/1.1 200 OK\r\n'+payload)
                    except (ssl.SSLError,ConnectionError):raw.close()
                worker=threading.Thread(target=serve);worker.start()
                subprocess.run([str(exe),str(listener.getsockname()[1]),str(folder/'trusted-root.pem'),host,format(flags,'x'),str(int(expected))],check=True)
                worker.join(timeout=10);assert not worker.is_alive()
                if flags:assert not seen, 'HTTP sent before certificate validation'
        print(f'PASS: {len(tests)} actual Mbed TLS certificate/HTTP boundary tests')

if __name__=='__main__':main()
