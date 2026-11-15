"""Paired uncompressed control; compression is paused only in this clone."""
import os
os.environ['PERF127_PHASE']='uncompressed'
import restore_load127
