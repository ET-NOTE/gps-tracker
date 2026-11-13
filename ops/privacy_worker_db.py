"""Worker connections: preserve legacy OFF, use server-bound keys when encrypted.

No key in SQL literals, DSN, output or command arguments. Install psycopg[binary]
3.2.10 alongside the existing worker dependency before enabling encryption.
"""
import json


def transaction(db):
    # psycopg 3's connection context closes the connection; workers reuse it.
    return db.transaction() if hasattr(db, 'transaction') else db


def connect(cfg, *, maintenance_owner=False):
    # Opt-in is reserved for the checkpoint maintenance entry point. Ordinary
    # workers still fail closed. It never changes the storage maintenance flag.
    mode = cfg.get('GPS_LOCATION_ENCRYPTION', 'off')
    if mode not in ('off', 'pilot'):
        raise ValueError('invalid location encryption mode')
    if mode == 'pilot':
        import psycopg
        from location_storage import private_json, validate_keyring
        ring = private_json(cfg['GPS_LOCATION_KEYRING_FILE'])
        validate_keyring(ring)
        db = psycopg.connect(cfg['DATABASE_URL'])
    else:
        import psycopg2
        db = psycopg2.connect(cfg['DATABASE_URL'])
    try:
        with transaction(db), db.cursor() as c:
            c.execute("SELECT to_regclass('location_storage_policy') IS NOT NULL")
            exists = c.fetchone()[0]
            if not exists:
                if mode != 'off':
                    raise ValueError('encrypted schema required')
                return db
            c.execute('SELECT enabled,coalesce(to_jsonb(p)->>\'maintenance\',\'false\')::boolean FROM location_storage_policy p WHERE singleton')
            enabled, maintenance = c.fetchone()
            if enabled != (mode == 'pilot'):
                raise ValueError('storage policy mismatch or maintenance; worker stopped')
            if maintenance:
                if not maintenance_owner:
                    raise ValueError('storage policy mismatch or maintenance; worker stopped')
                c.execute("SELECT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='privacy_retention_policy'::regclass),'USAGE')")
                if not c.fetchone()[0]:
                    raise ValueError('maintenance owner required')
                c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
                if c.fetchone()[0]:
                    raise ValueError('stop all API/worker/client sessions before maintenance checkpoint')
            if enabled:
                c.execute("SELECT current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND coalesce(current_setting('pgaudit.log_parameter',true),'off') IN ('off','false','0')")
                if not c.fetchone()[0]:
                    raise ValueError('bind logging must be disabled')
                c.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
                c.execute("SELECT gps_open_cell(gps_seal_cell('1'::jsonb,'worker-probe'),'worker-probe')='1'::jsonb")
                if not c.fetchone()[0]:
                    raise ValueError('worker encryption self-test failed')
        return db
    except BaseException:
        db.close()
        raise
