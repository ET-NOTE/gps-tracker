"""Read-only final119 inventory, including on-demand PDF capacity omitted by idle snapshots."""
import contextlib
import io
import json
import urllib.request
from observe_runtime118 import main as inventory, run
from budget_runtime118 import assess


def main():
    stream=io.StringIO()
    with contextlib.redirect_stdout(stream): inventory()
    value=json.loads(stream.getvalue())
    with urllib.request.urlopen('http://127.0.0.1:3040/gps-tracker/health',timeout=5) as response:
        value['health']=json.load(response)
    value['pdf_service']={line.split('=',1)[0]:line.split('=',1)[1] for line in
      run('systemctl','show','gps-pdf-render@capacity.service','-p','MemoryMax','-p','MemorySwapMax','-p','User').splitlines()}
    value['pdf_socket']={line.split('=',1)[0]:line.split('=',1)[1] for line in
      run('systemctl','show','gps-pdf-render.socket','-p','MaxConnections','-p','NConnections','-p','ActiveState').splitlines()}
    value['budget']=assess(value)
    maximum=value['pdf_service'].get('MemoryMax','infinity')
    sockets=value['pdf_socket'].get('MaxConnections','0')
    value['pdf_capacity']={'per_process_bytes':int(maximum) if maximum.isdigit() else None,
      'socket_max_connections':int(sockets) if sockets.isdigit() else None,
      'on_demand_not_reserved_by_running_service_snapshot':True,
      'note':'Single API semaphore is1, but dropped callers or multiple API processes can overlap socket workers. Global aggregate budget remains open.'}
    print(json.dumps(value,indent=2))


if __name__=='__main__': main()
