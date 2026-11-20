"""Recreate only the known disposable clone from the full114 fixture backup."""
import json
import verify_runtime126 as v
from runtime121_control import job

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
for action in ('drop','create','pre','restore','post'):
    job('recovery',action=action,database='gps_cumulative_restore')
import test_backfill128
