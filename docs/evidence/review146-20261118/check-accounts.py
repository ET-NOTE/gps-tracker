
import json,datetime
import review146_deploy as r
import psycopg2
with psycopg2.connect(r.b.url()) as db:
 db.set_session(readonly=True)
 with db.cursor() as q:
  q.execute("SELECT now(),now()+interval '1 year'");now,target=q.fetchone();rows=[]
  for email in ('user@user.com','user@user4.com'):
   q.execute('SELECT id,role,account_type FROM users WHERE email=%s',(email,));uid,role,kind=q.fetchone()
   item={'email':email,'role':role,'account_type':kind,'subscriptions':{}}
   for sub in ('corporate_report','rentcar_report'):
    q.execute('SELECT starts_at,expires_at FROM subscriptions WHERE user_id=%s AND kind=%s AND expires_at>%s ORDER BY starts_at',(uid,sub,now));coverage=now
    for start,end in q.fetchall():
     if start<=coverage:coverage=max(coverage,end)
    assert coverage>=target,(email,sub,'less than one year continuous coverage')
    item['subscriptions'][sub]={'continuous_until':coverage.isoformat(),'at_least_one_year':True}
   rows.append(item)
print(json.dumps({'checked_at':now.isoformat(),'target':target.isoformat(),'accounts':rows,'database_changes':0},indent=2))
