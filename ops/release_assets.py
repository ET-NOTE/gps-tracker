"""Reuse immutable hashed assets without duplicating every prior web release."""
import errno
import os
import pathlib
import shutil


def inherit_immutable_assets(source, destination):
    source, destination = pathlib.Path(source).resolve(), pathlib.Path(destination).resolve()
    assert source.is_dir() and destination.is_dir() and source != destination
    result = {'linked': 0, 'copied': 0, 'reused_bytes': 0}
    for old in source.iterdir():
        # Only build outputs in assets/. Uploads and symlinks are never inherited.
        if old.is_symlink() or not old.is_file():
            continue
        target = destination/old.name
        if target.exists() or target.is_symlink():
            continue
        try:
            os.link(old, target)
            result['linked'] += 1
            result['reused_bytes'] += old.stat().st_size
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            shutil.copy2(old, target)
            result['copied'] += 1
    return result
