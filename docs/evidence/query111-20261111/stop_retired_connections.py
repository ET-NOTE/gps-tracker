from benchmark_location111 import connect, info, NET
assert set(info('network',NET)['Containers'][k]['Name'] for k in info('network',NET)['Containers'])=={'gps-query111-db'}
with connect() as db:
 rows=db.execute("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchall()
 for (pid,) in rows:db.execute('SELECT pg_terminate_backend(%s)',(pid,))
 print('Retired synthetic API sessions closed:',len(rows))
