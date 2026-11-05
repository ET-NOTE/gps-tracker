#!/usr/bin/env python3
"""Private, temporary TLS 1.2 fixture. Never connects to production API/DB.

generate DIR: create ephemeral private keys/certificates and a public CA header.
serve DIR --allow-ip IP: serve only loopback and the specified modem egress IP.
Set DIR/active-case.json to {"case":"valid|expired|untrusted|wrong-host", "run":"..."}.
Remove the listener, firewall rule and private fixture after the hardware run.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import socket
import ssl
import time

HOST = "gps.serial.kr"
PORT = 18443
CASES = ("valid", "expired", "untrusted", "wrong-host")


def generate(folder):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    now = datetime.utcnow()
    pem = serialization.Encoding.PEM
    def name(cn): return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    def issue(cn, key, issuer_cert=None, issuer_key=None, ca=False, expired=False, dns=None):
        issuer_key = issuer_key or key
        subject = name(cn)
        b = (x509.CertificateBuilder().subject_name(subject)
             .issuer_name(issuer_cert.subject if issuer_cert else subject)
             .public_key(key.public_key()).serial_number(x509.random_serial_number())
             .not_valid_before(now - timedelta(days=400 if expired else 1))
             .not_valid_after(now - timedelta(days=1) if expired else now + timedelta(days=365))
             .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
             .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
             .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False)
             .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                 key_encipherment=False, data_encipherment=False, key_agreement=False,
                 key_cert_sign=ca, crl_sign=ca, encipher_only=False, decipher_only=False), critical=True))
        if dns:
            b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(dns)]), critical=False)
            b = b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        return b.sign(issuer_key, hashes.SHA256())
    def write_key(stem,key):
        p=folder/(stem+".key")
        p.write_bytes(key.private_bytes(pem,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        p.chmod(0o600)
    roots=[]
    for suffix in ("trusted", "untrusted"):
        key=ec.generate_private_key(ec.SECP384R1())
        cert=issue("GPS test root "+suffix,key,ca=True)
        (folder/(suffix+"-root.pem")).write_bytes(cert.public_bytes(pem)); write_key(suffix+"-root",key)
        ikey=ec.generate_private_key(ec.SECP384R1())
        icert=issue("GPS test intermediate "+suffix,ikey,cert,key,ca=True)
        roots.append((cert,ikey,icert))
    metadata={}
    for case in CASES:
        root,ikey,intermediate=roots[int(case=="untrusted")]
        key=ec.generate_private_key(ec.SECP256R1())
        dns="wrong-host.invalid" if case=="wrong-host" else HOST
        cert=issue(dns,key,intermediate,ikey,expired=case=="expired",dns=dns)
        (folder/(case+".pem")).write_bytes(cert.public_bytes(pem)+intermediate.public_bytes(pem))
        write_key(case,key)
        metadata[case]={"dns":dns,"not_before":cert.not_valid_before.isoformat(),
                        "not_after":cert.not_valid_after.isoformat(),"sha256":cert.fingerprint(hashes.SHA256()).hex()}
    root_pem=roots[0][0].public_bytes(pem).decode()
    digest=hashlib.sha256(roots[0][0].public_bytes(serialization.Encoding.DER)).hexdigest()
    (folder/"test_ca.h").write_text('#pragma once\n#define GPS_CA_FILE "gt-'+digest[:12]+'.pem"\n'
        'static constexpr char gpsRootCa[] = R"PEM('+root_pem+')PEM";\n')
    (folder/"metadata.json").write_text(json.dumps({"root_sha256":digest,"certificates":metadata},indent=2)+"\n")
    (folder/"active-case.json").write_text(json.dumps({"case":"valid","run":"initial"}))
    print(json.dumps({"directory":str(folder),"root_sha256":digest,"cases":list(metadata)}))


def serve(folder, allowed, duration):
    def log(event,**data):
        print(json.dumps({"at":datetime.now(timezone.utc).isoformat(),"event":event,**data}),flush=True)
    deadline=time.monotonic()+duration
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        listener.bind(("0.0.0.0",PORT)); listener.listen(8); listener.settimeout(1)
        log("listening",port=PORT,allowed=allowed)
        while time.monotonic()<deadline:
            try: raw,peer=listener.accept()
            except socket.timeout: continue
            if peer[0] not in ("127.0.0.1",allowed): raw.close(); continue
            state=json.loads((folder/"active-case.json").read_text())
            case=state["case"]; run=state["run"]
            if case not in CASES: raw.close(); continue
            # New context per connection disables reuse across certificate changes.
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_2
            ctx.options |= ssl.OP_NO_TICKET
            ctx.set_ciphers("ECDHE-ECDSA-AES256-GCM-SHA384")
            ctx.load_cert_chain(str(folder/(case+".pem")),str(folder/(case+".key")))
            ctx.set_servername_callback(lambda sock,server_name,context: log("sni",case=case,run=run,name=server_name))
            raw.settimeout(12)
            log("accepted",case=case,run=run,peer=peer[0])
            try:
                with ctx.wrap_socket(raw,server_side=True) as tls:
                    log("handshake",case=case,run=run,version=tls.version(),cipher=tls.cipher()[0],reused=tls.session_reused)
                    data=b""
                    while b"\r\n\r\n" not in data and len(data)<8192:
                        block=tls.recv(1024)
                        if not block: break
                        data+=block
                    # Do not persist request headers or arbitrary bodies.
                    is_probe=data.startswith(b"GET /tls-probe HTTP/")
                    log("http",case=case,run=run,probe=is_probe,bytes=len(data))
                    body=b"TLS probe only\n"
                    tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: "+str(len(body)).encode()+b"\r\n\r\n"+body)
            except (ssl.SSLError,OSError) as e:
                log("tls_error",case=case,run=run,reason=str(e))
                raw.close()
        log("stopped")


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("command",choices=("generate","serve")); p.add_argument("directory",type=Path)
    p.add_argument("--allow-ip"); p.add_argument("--duration",type=int,default=3600)
    a=p.parse_args()
    if a.command=="generate": generate(a.directory)
    elif a.allow_ip: serve(a.directory,a.allow_ip,a.duration)
    else: p.error("serve requires --allow-ip")
