"""Test the actual config generator without executing deployment side effects."""
import ast
import pathlib
import re
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'deploy_shield_batch.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'planned_nginx')
namespace = {'re': re}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
planned_nginx = namespace['planned_nginx']


class ShieldNginxTests(unittest.TestCase):
    def test_each_server_gets_one_route_even_with_identical_blocks(self):
        block = ('    location = /ingest {\n'
                 '        proxy_pass http://127.0.0.1:3040/gps-tracker/ingest;\n'
                 '        client_max_body_size 64k;\n    }')
        for second in (block, block.replace('64k;', '64k; # HTTPS')):
            with self.subTest(identical=block == second):
                old = f'server {{\n    listen 80;\n{block}\n}}\nserver {{\n    listen 443 ssl;\n{second}\n}}\n'
                planned = planned_nginx(old)
                servers = planned.split('server {')[1:]
                self.assertEqual(len(servers), 2)
                for server in servers:
                    self.assertEqual(server.count('location = /ingest/shield {'), 1)
                    self.assertEqual(server.count('location = /ingest {'), 1)
                restored = re.sub(r'\n\n    location = /ingest/shield \{\n.*?\n    \}', '', planned, flags=re.S)
                self.assertEqual(restored, old)
                self.assertEqual(planned_nginx(planned), planned)

    def test_missing_legacy_server_is_rejected(self):
        with self.assertRaises(AssertionError):
            planned_nginx('server {}')


if __name__ == '__main__':
    unittest.main()
