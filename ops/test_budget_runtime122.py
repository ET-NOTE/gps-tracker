import unittest
from budget_runtime122 import assess


class BudgetTest(unittest.TestCase):
    def fixture(self):
        return dict(at='synthetic',cpu_count='6',settings=[dict(name='max_connections',setting='50'),
            dict(name='superuser_reserved_connections',setting='3'),dict(name='shared_buffers',setting='94967',unit='8kB')],
            roles=[dict(rolname='neighbor',rolsuper=False,rolconnlimit=-1)],
            units_before={'neighbor.service':dict(MemoryCurrent=str(700*1024**2),MemoryMax='infinity')},
            samples=[dict(memory='MemTotal: 3038932 kB\n',connections=[dict(usename='neighbor',backend_type='client backend',connections=18)])])

    def test_shared_current_rejected_even_when_idle_usage_looks_low(self):
        result=assess(self.fixture())
        self.assertFalse(result['production_admission'])
        self.assertEqual(result['production']['remaining_for_others_with_api28_and_ops4'],15)
        self.assertGreater(result['production']['current_shortfall_mib'],1900)
        self.assertEqual(result['production']['uncapped_roles'],['neighbor'])

    def test_background_workers_do_not_consume_client_budget(self):
        value=self.fixture()
        value['samples'][0]['connections'].append(dict(usename='neighbor',backend_type='autovacuum worker',connections=20))
        self.assertEqual(assess(value)['production']['other_clients_peak'],18)

    def test_more_memory_is_not_automatic_approval(self):
        value=self.fixture();value['samples'][0]['memory']='MemTotal: 8388608 kB\n'
        result=assess(value)
        self.assertFalse(result['production_admission'])
        self.assertTrue(all(p['finite_arithmetic_fits'] and not p['production_approved'] for p in result['profiles'].values()))

    def test_unknown_buffer_units_fail_closed(self):
        value=self.fixture();value['settings'][2]['unit']='unknown'
        with self.assertRaises(AssertionError):assess(value)


if __name__=='__main__':unittest.main()
