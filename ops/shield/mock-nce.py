#!/usr/bin/env python3
"""Loopback-only fake 1NCE: never uses provider credentials or the Internet."""
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import json
import threading
state={'mode':'success','posts':0,'gets':0,'last_sim':None}
lock=threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def answer(self,code,data,headers=None):
        body=json.dumps(data).encode();self.send_response(code)
        self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
        for k,v in (headers or {}).items():self.send_header(k,v)
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        with lock:
            if self.path=='/__state':return self.answer(200,state)
            state['gets']+=1
            if '/quota/data' in self.path:return self.answer(200,{'volume':321.25,'total_volume':500,'expiry_date':'2036-08-18 00:00:00'})
            if '/orders/' in self.path:return self.answer(200,{'order_number':self.path.rsplit('/',1)[-1],'order_type':'TOPUP','sims':[{'iccid':state['last_sim']}]})
            return self.answer(200,{'status':'Enabled','activation_date':'2026-05-18'})
    def do_POST(self):
        data=self.rfile.read(int(self.headers.get('Content-Length',0)))
        with lock:
            if self.path=='/__mode':state['mode']=json.loads(data)['mode'];return self.answer(200,{'ok':True})
            if self.path.endswith('/oauth/token'):return self.answer(200,{'access_token':'mock-provider-token'})
            if '/topup' in self.path:
                state['posts']+=1;state['last_sim']=self.path.split('/sims/')[1].split('/')[0]
                if state['mode']=='unknown':return self.answer(503,{'message':'uncertain outcome'})
                if state['mode']=='reject':return self.answer(403,{'message':'SIM forbidden'})
                return self.answer(201,{}, {'Location':'/management-api/v1/orders/mock-order-'+str(state['posts'])})
            return self.answer(404,{'error':'unknown mock request'})
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',9043),Handler).serve_forever()
