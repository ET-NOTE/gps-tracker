"""Offline initial enrollment only. A private maintenance DSN is never put in the API.
Default is read-only. Requires two existing, distinct, named personal accounts and
explicit host addresses. Does not grant MFA sessions or silently enroll an OTP.
"""
import argparse,ipaddress,json,pathlib,stat
import psycopg2

def bootstrap(dsn,officer,operator,cidrs,reference,apply=False):
 if officer==operator or min(officer,operator)<1:raise ValueError('two different personal accounts required')
 if not 1<=len(cidrs)<=16 or not reference.strip() or len(reference)>160:raise ValueError('explicit IP and authorization reference required')
 nets=[ipaddress.ip_network(x,strict=False) for x in cidrs]
 if any(n.prefixlen!=n.max_prefixlen for n in nets):raise ValueError('initial enrollment accepts individual host IPs only')
 with psycopg2.connect(dsn) as db:
  with db.cursor() as c:
   c.execute('SELECT current_database(), max(version) FROM _sqlx_migrations');name,version=c.fetchone()
   if not name.startswith('gps_') or version!=102:raise ValueError('reviewed GPS schema 102 required')
   c.execute('SELECT pg_advisory_xact_lock(1911,0)')
   c.execute('SELECT count(*) FROM admin_principals')
   if c.fetchone()[0]:raise ValueError('already initialized; use approved UI change or documented offline recovery')
   c.execute('SELECT u.id,u.display_name FROM users u JOIN privacy_account_controls a ON a.user_id=u.id WHERE u.id=ANY(%s) AND NOT a.restricted FOR UPDATE OF u',([officer,operator],))
   rows=c.fetchall()
   if len(rows)!=2 or any(not (n or '').strip() for _,n in rows):raise ValueError('two active named accounts required')
   if apply:
    for uid,role in [(officer,'officer'),(operator,'operator')]:
     c.execute("UPDATE users SET role='admin' WHERE id=%s",(uid,))
     c.execute('INSERT INTO admin_principals(user_id,role,allowed_cidrs) VALUES(%s,%s,%s)',(uid,role,[str(n) for n in nets]))
     c.execute("INSERT INTO admin_audit_log(admin_id,target_user,action,data) VALUES(%s,%s,'admin_offline_bootstrap',jsonb_build_object('role',%s::text,'reference',%s::text))",(officer,uid,role,reference))
    c.execute("INSERT INTO admin_security_events(actor_id,ip,action,route,outcome) VALUES(%s,'offline-maintenance','bootstrap','offline','configured')",(officer,))
   else:db.rollback()
 return {'schema':102,'apply':apply,'officer_id':officer,'operator_id':operator,'allowed_cidrs':[str(n) for n in nets]}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--dsn-file',required=True);p.add_argument('--officer',type=int,required=True);p.add_argument('--operator',type=int,required=True);p.add_argument('--ip',action='append',required=True);p.add_argument('--reference',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
 f=pathlib.Path(a.dsn_file)
 if stat.S_IMODE(f.stat().st_mode)&0o077:raise SystemExit('DSN file must be mode 600')
 print(json.dumps(bootstrap(f.read_text().strip(),a.officer,a.operator,a.ip,a.reference,a.apply),indent=2))
