"""Mutation checks: inventory must fail for unreviewed/new registration forms."""
import pathlib
import shutil
import tempfile
from check_location_access_routes import ROOT, check

check()
mutations = {
    'new location route': '.route("/new-location", get(location_handler))',
    'dynamic registration': '.route(dynamic_path, get(location_handler))',
    'service registration': '.route_service("/new-location", service)',
}
for label, code in mutations.items():
    with tempfile.TemporaryDirectory(prefix='gps-inventory-') as directory:
        root = pathlib.Path(directory)
        shutil.copytree(ROOT/'gps-tracker-api/src/routes', root/'gps-tracker-api/src/routes')
        (root/'gps-tracker-api/src/services').mkdir()
        shutil.copy2(ROOT/'gps-tracker-api/src/services/access_ledger.rs', root/'gps-tracker-api/src/services')
        shutil.copy2(ROOT/'gps-tracker-api/location-access-routes.json', root/'gps-tracker-api')
        new = root/'gps-tracker-api/src/routes/nested/new.rs'
        new.parent.mkdir()
        new.write_text(code)
        try:
            check(root)
        except AssertionError:
            print('PASS rejected:', label)
        else:
            raise AssertionError('inventory accepted: '+label)
