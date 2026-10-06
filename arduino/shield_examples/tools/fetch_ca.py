"""Download official public roots, select one that validates the target's TLS 1.2 chain + hostname."""
import argparse, hashlib, json, re, socket, ssl, urllib.request
from pathlib import Path
SOURCES=[('ISRG Root X1','https://letsencrypt.org/certs/isrgrootx1.pem')]+[
    (f'GTS Root R{n}',f'https://pki.goog/repo/certs/gtsr{n}.pem') for n in range(1,5)]
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    if not re.fullmatch(r'[a-z0-9.-]{3,95}',a.host) or 'YOUR' in a.host:p.error('Use the actual hostname only, without https:// or a path.')
    if a.out.exists():p.error('Output already exists. Choose a new name; do not overwrite a reviewed CA silently.')
    for name,url in SOURCES:
        try:
            with urllib.request.urlopen(url,timeout=15) as r:pem=r.read(4001)
            if not 500<len(pem)<4000 or b'-----BEGIN CERTIFICATE-----' not in pem:continue
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_2
            ctx.load_verify_locations(cadata=pem.decode('ascii'))
            with socket.create_connection((a.host,443),timeout=10) as tcp:
                with ctx.wrap_socket(tcp,server_hostname=a.host):pass
        except (OSError,ValueError):continue
        a.out.write_bytes(pem);digest=hashlib.sha256(pem).hexdigest()
        a.out.with_suffix('.manifest.json').write_text(json.dumps({'host':a.host,'root':name,'source':url,'sha256':digest,'bytes':len(pem)},indent=2)+'\n',encoding='utf-8')
        print(f'Validated TLS 1.2 on PC: {name}\nSHA256: {digest}\nSaved: {a.out}')
        return
    raise SystemExit('No supported root validated this hostname. Check endpoint/PC clock/network; do not disable certificate checks.')
if __name__=='__main__':main()
