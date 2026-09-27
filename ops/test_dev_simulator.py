import argparse
import unittest
from dev_gps_simulator import make_payload, NoRedirect, position, run


class SimulatorTest(unittest.TestCase):
    def test_retry_keeps_fix_identity_and_recalculates_age(self):
        first = make_payload('dev-sim-test', 1000, [20, 22], 1025)
        retry = make_payload('dev-sim-test', 1000, [20, 22], 1035)
        self.assertEqual(first['fixes'][0]['up_ms'], retry['fixes'][0]['up_ms'])
        self.assertEqual(retry['fixes'][0]['age_ms'] - first['fixes'][0]['age_ms'], 10000)
        for p in (first, retry):
            self.assertEqual(p['l80']['lat'], p['fixes'][-1]['lat'])
            self.assertEqual(p['l80']['speed_kmh'], p['fixes'][-1]['speed_kmh'])

    def test_only_synthetic_device_ids_and_no_redirects(self):
        with self.assertRaises(SystemExit):
            run(argparse.Namespace(device_uid='real-device'))
        self.assertIsNone(NoRedirect().redirect_request(None, None, 307, '', {}, 'https://gps.serial.kr/ingest'))

    def test_loop_has_movement_and_a_sustained_stop(self):
        self.assertGreater(position(10)[2], 5)
        self.assertEqual(position(420)[2], 0)
        self.assertEqual(position(779)[2], 0)
        self.assertEqual(position(780), position(0))


if __name__ == '__main__':
    unittest.main()
