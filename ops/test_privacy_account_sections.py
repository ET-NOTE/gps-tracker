"""Real isolated API/DB projections; reuses only guarded fixture helpers, no production mode."""
import pathlib
helpers=(pathlib.Path(__file__).parent/'test_privacy_packages.py').read_text()
exec(compile(helpers.split('owner,other,admin=')[0],__file__,'exec'))
owner,other,admin=[account(n) for n in [61,62,63]]
uid=owner['user_id'];token=owner['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
secrets=['private-raw-response','private-note','private-payment-key','private-receipt','private-iccid','private-body','private-meta','private-preference','private-other']
for who in [uid,other['user_id']]:
 did=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','private-other') RETURNING id",(f'{tag}-{who}',who))
 sql("INSERT INTO user_phones(user_id,phone,is_verified) VALUES(%s,%s,true)",(who,'01099887766'))
 sql("INSERT INTO notification_settings(user_id,offline_minutes) VALUES(%s,1440) ON CONFLICT(user_id) DO UPDATE SET offline_minutes=1440",(who,))
 sql("UPDATE users SET prefs=%s::jsonb WHERE id=%s",(json.dumps({'theme':'dark','lab_phone_tracker':True,'seeker':{'speed_color':False,'token':'private-preference'},'private_key':'private-preference','device_colors':{str(did):'private-preference'}}),who))
 sql("INSERT INTO credit_log(user_id,delta,balance,reason,ref_id,note) VALUES(%s,12,12,'admin_grant',77,'private-note')",(who,))
 sql("INSERT INTO payment_orders(order_id,user_id,amount,status,payment_key,receipt_url,raw_response,fail_reason,virtual_account_info) VALUES(%s,%s,33000,'confirmed','private-payment-key','private-receipt','{\"secret\":\"private-raw-response\"}','private-note','{\"secret\":\"private-meta\"}')",(f'{tag}-{who}',who))
 sql("INSERT INTO credit_topup_requests(user_id,amount,status,payment_ref,note) VALUES(%s,30000,'approved','private-payment-key','private-note')",(who,))
 sql("INSERT INTO sim_topup_requests(user_id,device_id,iccid,data_mb,cost_credits,status,api_response,note) VALUES(%s,%s,'private-iccid',500,30000,'done','{\"secret\":\"private-raw-response\"}','private-note')",(who,did))
 sql("INSERT INTO subscriptions(user_id,kind,expires_at,paid_credits,note) VALUES(%s,'rentcar_report',now()+interval '1 year',30000,'private-note')",(who,))
 tid=sql('INSERT INTO chat_threads(user_id,last_message_text) VALUES(%s,\'private-body\') RETURNING id',(who,))
 sql("INSERT INTO chat_messages(thread_id,sender_role,sender_id,body,meta) VALUES(%s,'user',%s,'private-body','{\"secret\":\"private-meta\"}')",(tid,who))
 sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis,cost_credits) VALUES(%s,%s,current_date,'private-body',20)",(who,did))
 sql("INSERT INTO ai_usage_log(user_id,endpoint,tokens_in,tokens_out,model) VALUES(%s,'private-meta',12,3,'private-meta')",(who,))
 if who==uid:own_device=did
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Account sections fixture','password':password},token);assert s==202
rid=r['id']
s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'Review fixture','evidence_reference':'private-note','due_at':(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()},at);assert s==200
def grant(sections=None,who=at):
 rev=call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['revision']
 body={'revision':rev,'confirmed':True,'documents':[]}
 if sections is not None:body['sections']=sections
 return call('POST',f'/admin/privacy/requests/{rid}/account-packages',body,who)
def dl(p,who=token,pw=password):return call('POST',f"/privacy/account-packages/{p['id']}/account",{'password':pw},who)
s,old,_=grant();assert s==200 and old['sections']==[]
s,data,_=dl(old);assert s==200 and data['additional']=={} and data['format']=='gps-personal-account-v1'
assert len(data['unselected_sections'])==4
for invalid in [['transactions','transactions'],['all'],['contact_settings',None]]:assert grant(invalid)[0] in [400,422]
assert grant(['transactions'],token)[0]==403
check('legacy/default scope stays basic; unknown, duplicate and non-admin scope rejected')
sections=['contact_settings','transactions','activity_metadata']
s,p,_=grant(sections);assert s==200 and p['sections']==sections
assert dl(old)[0]==410
assert dl(p,other['access_token'])[0]==404 and dl(p,pw='wrong')[0]==401
s,data,h=dl(p);assert s==200,(s,data)
assert data['format']=='gps-personal-account-v2' and data['unselected_sections']==['location_facts']
assert h['Cache-Control']=='no-store, private'
for secret in secrets:assert secret.encode() not in last_body,secret
extra=data['additional'];settings=extra['contact_settings'];tx=extra['transactions'];activity=extra['activity_metadata']
assert len(settings['phones'])==1 and settings['notification_settings']['offline_minutes']==1440
assert settings['display_preferences']=={'theme':'dark','lab_phone_tracker':True,'seeker':{'speed_color':False}}
for key in ['point_ledger','payments','point_topup_requests','sim_topup_requests','subscriptions']:assert len(tx[key])==1,key
assert tx['payments'][0]['amount']==33000 and tx['point_topup_requests'][0]['amount_points']==30000
assert tx['subscriptions'][0]['kind']=='rentcar_report'
for key in ['chat_message_metadata','ai_analysis_metadata','ai_usage_metadata']:assert len(activity[key])==1,key
assert sql("SELECT sha256 FROM privacy_account_package_events WHERE package_id=%s AND action='account_prepared' ORDER BY id DESC LIMIT 1",(p['id'],))==hashlib.sha256(last_body).hexdigest()
check('explicit projections include owned records only; nested preferences, payment secrets, bodies and internal notes omitted')
sql('UPDATE devices SET owner_id=%s WHERE id=%s',(other['user_id'],own_device))
s,after,_=dl(p);assert s==200 and after['additional']['transactions']==tx
assert after['additional']['activity_metadata']==activity
assert call('GET',f'/privacy/requests/{rid}/account-packages',token=token)[1][0]['sections']==sections
check('SIM transfer does not rewrite requester transaction history or expose new owner data; grant scope is visible')
sql('DELETE FROM privacy_result_limits')
sql("INSERT INTO credit_log(user_id,delta,balance,reason) SELECT %s,1,1,'cap-fixture' FROM generate_series(1,1000)",(uid,))
before=sql("SELECT count(*) FROM privacy_account_package_events WHERE package_id=%s AND action='account_prepared'",(p['id'],))
assert dl(p)[0]==409
assert sql("SELECT count(*) FROM privacy_account_package_events WHERE package_id=%s AND action='account_prepared'",(p['id'],))==before
s,basic,_=grant([]);assert s==200 and dl(basic)[0]==200
sql("DELETE FROM credit_log WHERE user_id=%s AND reason='cap-fixture'",(uid,))
s,p,_=grant(['contact_settings']);assert s==200
sql("INSERT INTO user_phones(user_id,phone) SELECT %s,'cap-'||n FROM generate_series(1,200) n",(uid,))
assert dl(p)[0]==409
sql("DELETE FROM user_phones WHERE user_id=%s AND phone LIKE 'cap-%%'",(uid,))
assert dl(p)[0]==200
check('row limits refuse whole selected response without audit-success or silent truncation; unselected data does not block basic export')
sql("INSERT INTO credit_log(user_id,delta,balance,reason) VALUES(%s,1,1,'private-note')",(uid,))
s,p,_=grant(['transactions']);assert s==200
s,data,_=dl(p);assert s==200 and data['additional']['transactions']['point_ledger'][-1]['reason']=='other_review_required'
assert set(data['additional'])=={'transactions'} and len(data['unselected_sections'])==3
assert call('POST',f"/admin/privacy/account-packages/{p['id']}/revoke",{},at)[0]==200 and dl(p)[0]==410
check('one selected section stays isolated; unknown classifications flagged without leaking text; revocation remains effective')
sql('DELETE FROM privacy_result_limits')
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'sections-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
