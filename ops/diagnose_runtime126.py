"""Before-change monthly requests and paired default/JIT-off exact SQL plans."""
import verify_runtime126 as v
import profile_runtime126 as p

v.baseline()
p.profile('before-plan',analyze=False)
p.profile('before-default')
p.profile('before-jit-off',jit=False)
