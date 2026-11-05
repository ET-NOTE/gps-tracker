"""Local file outbox worker. Dry-run by default; never sweeps untracked files.

Linux only. Every path component is opened with O_NOFOLLOW; only regular files
with one hard link are unlinked. Reference tables are locked before the queue,
so no new committed reference can appear between checking and unlinking.
No file contents, filenames, credentials or locations are printed.
"""
import argparse
import errno
import json
import os
import pathlib
import re
import stat

def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (s.split('=', 1) for s in pathlib.Path(path).read_text().splitlines()
             if '=' in s and not s.lstrip().startswith('#'))}


def resolve_key(kind, key, cfg):
    uploads = pathlib.PurePosixPath(cfg.get('UPLOAD_DIR', '/home/mmm/uploads'))
    if kind == 'document':
        root = uploads
        # Reject traversal even if a normalization would resolve inside the root.
        if not key.startswith(str(root) + '/') or any(x in ('.', '..', '') for x in key[1:].split('/')):
            raise ValueError('invalid_document_path')
        parts = pathlib.PurePosixPath(key).relative_to(root).parts
        if len(parts) != 4 or parts[0] not in ('device_documents', 'fleet_documents') or not all(x.isdecimal() for x in parts[1:3]):
            raise ValueError('invalid_document_layout')
    elif kind == 'car_image':
        root = pathlib.PurePosixPath(cfg.get('PRIVATE_UPLOAD_DIR', str(uploads.with_name('gps-private-uploads'))))
        match = re.fullmatch(r'/uploads/car-images/((?:dev|fleet)_\d+_[0-9a-fA-F-]{36}\.(?:jpg|png|webp))', key)
        if not match:
            raise ValueError('invalid_image_key')
        parts = ('car-images', match[1])
    else:
        raise ValueError('unknown_storage')
    if not root.is_absolute() or str(root) == '/' or '..' in root.parts or '\x00' in key:
        raise ValueError('invalid_storage_root')
    return root, parts


def unlink_local(kind, key, cfg):
    """Return absent only after validating the path; never follow symlinks."""
    try:
        root, relative = resolve_key(kind, key, cfg)
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            # An unavailable configured root is not evidence of destruction.
            for part in root.parts[1:]:
                try:
                    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    return 'retry', 'storage_root_unavailable'
                os.close(fd)
                fd = nxt
            for part in relative[:-1]:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nxt
            info = os.stat(relative[-1], dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                return 'blocked', 'not_regular_file'
            if info.st_nlink != 1:
                return 'blocked', 'multiple_hard_links'
            os.unlink(relative[-1], dir_fd=fd)
            # Persist directory removal before recording success in PostgreSQL.
            os.fsync(fd)
            return 'local_absent', 'unlinked'
        finally:
            os.close(fd)
    except FileNotFoundError:
        return 'local_absent', 'already_absent'
    except ValueError as exc:
        return 'blocked', str(exc)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            return 'blocked', 'symlink_or_invalid_parent'
        return 'retry', 'filesystem_error_' + str(exc.errno)


def process_one(db, cfg):
    with db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'")
            # Match producer lock order: reference writes -> queue. Locks also
            # protect shared legacy dev_* photos copied into fleet profiles.
            q.execute('LOCK TABLE device_documents,devices,fleet_vehicles IN SHARE MODE')
            q.execute("""SELECT id,storage_kind,storage_key FROM privacy_file_cleanup
              WHERE state IN ('pending','retry','shared') AND next_attempt_at<=clock_timestamp()
              ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED""")
            row = q.fetchone()
            if row is None:
                return None
            job, kind, key = row
            if kind == 'document':
                q.execute('SELECT EXISTS(SELECT 1 FROM device_documents WHERE stored_path=%s)', (key,))
            else:
                q.execute("SELECT EXISTS(SELECT 1 FROM devices WHERE car_image_url=%s) OR EXISTS(SELECT 1 FROM fleet_vehicles WHERE profile->>'car_image_url'=%s)", (key, key))
            if q.fetchone()[0]:
                state, reason = 'shared', 'live_reference'
            else:
                state, reason = unlink_local(kind, key, cfg)
            q.execute("""UPDATE privacy_file_cleanup SET state=%s,reason=%s,attempts=attempts+1,
              updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()+
              CASE WHEN %s='shared' THEN interval '1 day' ELSE interval '5 minutes' END,
              local_verified_at=CASE WHEN %s='local_absent' THEN clock_timestamp() ELSE NULL END
              WHERE id=%s""", (state, reason, state, state, job))
            q.execute('INSERT INTO privacy_file_cleanup_events(job_id,state,reason) VALUES(%s,%s,%s)', (job, state, reason))
            return {'job_id': job, 'state': state, 'reason': reason}


def main():
    import psycopg2

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('limit must be 1..100')
    cfg = config(args.env_file)
    db = psycopg2.connect(cfg['DATABASE_URL'])
    try:
        if not args.execute:
            db.set_session(readonly=True)
            with db.cursor() as q:
                q.execute('SELECT state,count(*) FROM privacy_file_cleanup GROUP BY state')
                print(json.dumps({'read_only': True, 'states': dict(q.fetchall())}))
            return
        processed = []
        for _ in range(args.limit):
            result = process_one(db, cfg)
            if result is None:
                break
            processed.append(result)
        print(json.dumps({'processed': processed, 'external_copies_verified': False}))
    except psycopg2.Error as exc:
        # SQL diagnostics can include filenames; log only the safe SQLSTATE.
        print(json.dumps({'failed': True, 'sqlstate': exc.pgcode}))
        raise SystemExit(1) from None
    finally:
        db.close()


if __name__ == '__main__':
    main()
