"""Reverse inventory: adding/removing/changing a route requires explicit review.

The committed manifest classifies every literal route in every routes/*.rs file,
including non-location and outside-api routes. This detects omissions, not the
semantic correctness of a classification; reviewers must inspect changed handlers.
"""
import hashlib, json, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'gps-tracker-api/location-access-routes.json'

def inventory(root=ROOT):
    found = {}
    for path in sorted((root/'gps-tracker-api/src/routes').rglob('*.rs')):
        source = path.read_text(encoding='utf-8')
        assert not re.search(r'\.route_service\s*\(',source), f'route_service needs explicit inventory support: {path}'
        for hit in re.finditer(r'\.route\(\s*"([^"\n]+)"\s*,', source):
            start=hit.end(); depth=1; quoted=False; escaped=False
            for end in range(start,len(source)):
                c=source[end]
                if quoted:
                    if escaped: escaped=False
                    elif c=='\\': escaped=True
                    elif c=='"': quoted=False
                elif c=='"': quoted=True
                elif c=='(': depth+=1
                elif c==')':
                    depth-=1
                    if depth==0: break
            expr=source[start:end]
            methods=re.findall(r'\b(get|post|patch|put|delete|head|options|any)\s*\(',expr)
            if not methods: raise AssertionError(f'unparsed route: {path.name} {hit[1]}')
            for method in methods:
                key=f'{path.name} {method.upper()} {hit[1]}'
                assert key not in found, f'duplicate route {key}'
                found[key]=True
        # Dynamic route registrations must not silently escape the literal parser.
        assert len(re.findall(r'\.route\(',source))==len(list(re.finditer(r'\.route\(\s*"([^"\n]+)"\s*,',source))),path
    return sorted(found)

def check(root=ROOT):
    manifest=root/'gps-tracker-api/location-access-routes.json'
    entries=json.loads(manifest.read_text(encoding='utf-8'))
    actual=inventory(root)
    assert set(actual)==set(entries), {'unclassified':sorted(set(actual)-set(entries)),'removed':sorted(set(entries)-set(actual))}
    ledger=(root/'gps-tracker-api/src/services/access_ledger.rs').read_text(encoding='utf-8')
    rules={(a,b) for a,b in re.findall(r'Rule\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"',ledger)}
    for key, entry in entries.items():
        file,method,route=key.split(' ',2)
        assert entry['reason'].strip(), key
        assert entry['class'] in ('ledger','handler_ledger','non_location','outside_api'),key
        if entry['class']=='handler_ledger':
            assert key=='subject_provision.rs GET /corporate/subject-mappings/:id/locations',key
            assert 'access_ledger::begin(Access' in (root/'gps-tracker-api/src/routes/subject_provision.rs').read_text(encoding='utf-8'), 'manual ledger missing'
        if entry['class']=='ledger': assert (method,route) in rules, f'missing ledger rule {key}'
    for method,route in rules:
        assert any(k.endswith(f' {method} {route}') and v['class']=='ledger' for k,v in entries.items()),(method,route)
    return {'routes':len(actual),'ledger_routes':sum(v['class']=='ledger' for v in entries.values()),
            'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest()}

if __name__=='__main__':
    if '--list' in sys.argv: print('\n'.join(inventory()))
    else: print(json.dumps(check(),indent=2))
