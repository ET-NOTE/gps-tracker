#!/usr/bin/env python3
"""WebSocket origin, owner filtering and session revocation on disposable preview."""
import base64
import importlib.util
import json
import secrets
import socket
import struct
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('integration',Path(__file__).with_name('test-integration.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

class WS:
    def __init__(self, client, origin=t.ORIGIN):
        self.sock=socket.create_connection(('127.0.0.1',3043),timeout=3)
        self.stream=self.sock.makefile('rb',buffering=0)
        cookies='; '.join(f'{c.name}={c.value}' for c in client.cookies)
        key=base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f'GET /api/ws HTTP/1.1\r\nHost: localhost:3043\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\nCookie: {cookies}\r\n\r\n').encode())
        self.status=int(self.stream.readline().split()[1])
        while self.stream.readline() not in (b'\r\n',b''): pass

    def event(self, timeout=3):
        self.sock.settimeout(timeout)
        while True:
            first=self.stream.read(2)
            if not first: return 'closed'
            opcode=first[0]&15; length=first[1]&127
            if length==126: length=struct.unpack('!H',self.stream.read(2))[0]
            if length==127: length=struct.unpack('!Q',self.stream.read(8))[0]
            data=b''
            while len(data)<length: data+=self.stream.read(length-len(data))
            if opcode==8: return 'closed'
            if opcode==9:
                mask=secrets.token_bytes(4)
                self.sock.sendall(bytes([0x8a,0x80|length])+mask+bytes(c^mask[i%4] for i,c in enumerate(data)))
            if opcode==1: return json.loads(data)

    def close(self):
        self.stream.close(); self.sock.close()

def main():
    fixture=json.loads((t.ROOT/'ui-fixture.json').read_text())
    a,b=t.Client(),t.Client()
    assert a.call('/api/auth/login',{'email':fixture['email'],'password':fixture['password']})[0]==200
    assert b.call('/api/auth/register',{'email':f'ws-{secrets.token_hex(5)}@example.test','password':secrets.token_urlsafe(24),'display_name':'WS other','invite_code':t.cli('invite')['invite_code']})[0]==200
    foreign=WS(a,'https://gps.serial.kr');t.check('WS foreign origin refused',foreign.status==401);foreign.close()
    unauth=WS(t.Client());t.check('WS anonymous refused',unauth.status==401);unauth.close()
    wa,wb=WS(a),WS(b);t.check('WS own-origin login accepted',wa.status==101 and wb.status==101)
    device=fixture['device']; now=int(time.time())
    payload={'shield_v':2,'device_uid':device['device_uid'],'build_tag':'shield-synthetic-ws','ts':700,'csq':20,'reg':5,'diag':{},'points':[], 'sensors':[{'at':now,'temp_c':24.8,'hum_pct':58}]}
    key={'X-Device-Key':device['device_key']}
    assert a.call('/ingest/shield',payload,key)[0]==200
    event=wa.event();t.check('WS owner receives only device invalidation',event=={'kind':'device_changed','device_id':fixture['device_id']})
    try:
        leaked=wb.event(0.5)
        raise AssertionError(f'Other account received {leaked}')
    except TimeoutError:
        t.check('WS other account receives no event',True)
    t.check('WS logout succeeds',a.call('/api/auth/logout',{})[0]==200)
    payload['ts']=701
    assert t.Client().call('/ingest/shield',payload,key)[0]==200
    t.check('WS revoked session closed before further event',wa.event()=='closed')
    wa.close();wb.close()
    (t.ROOT/'websocket-results.json').write_text(json.dumps({'passed':len(t.checks),'checks':t.checks},indent=2))

if __name__=='__main__':main()
