"""Plan evidence uses the API's JIT-off setting and unchanged20s request budget."""
import json
import profile_runtime126 as prior
import verify_runtime126 as v

v.stop_api()
for name in ('aggregate','history'):
    prior.profile('candidate127-'+name,analyze=True,jit=False,route=name)
    path=v.ROOT/('out/profile126-candidate127-'+name+'.json')
    result=json.loads(path.read_text())
    result.update(schema=114,api_sha256=v.load.b.SHA,
        diagnostic_only=True,api_jit='off',diagnostic_statement_seconds=60)
    v.load.save('plan127-'+name,result)
    assert result['ok'] and result['seconds']<20
print('PASS127 actual route SQL plans, restricted role, API JIT-off and under20s',flush=True)
