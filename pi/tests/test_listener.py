"""Laptop tests for the listener's socket envelope and its log lines (review PI-05, PI-12).

    python -m unittest discover -s pi/tests      (from the repo root)

Listener.handle() takes one Realtime frame: junk of any shape (not JSON, not an
object, a payload that isn't an object, an event that isn't a string, a handler
that raises) is logged and ignored and never raises, so a bad frame can't drop
the socket; a good broadcast still reaches its handler; channel errors still
raise DeadSocket. A refused cast logs its body clipped to CLIP characters.
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True

TOPIC = 'realtime:board:HangoutPortland'


def frame(payload, event='broadcast', topic=TOPIC):
    return json.dumps({'topic': topic, 'event': event, 'payload': payload, 'ref': None})


class Envelope(unittest.TestCase):
    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:                 # websockets isn't installed on this machine
            self.skipTest('pb_listener not importable: %s' % e)
        self.pb = pb_listener
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.topic, self.L.status_path, self.L.mode = TOPIC, None, 'day'
        self.L.status = {'error_count': 0, 'last_error': None, 'casts_ignored_night': 0}
        self.L.pending = None
        self.warned, self.errors = [], []
        self._warn, self._err, self._log = pb_listener.warn, pb_listener.err, pb_listener.log
        pb_listener.warn = self.warned.append
        pb_listener.err = self.errors.append
        pb_listener.log = lambda msg, level=6: None

        class Ready:
            def set(_):
                pass
        self.L.cast_ready = Ready()

    def tearDown(self):
        self.pb.warn, self.pb.err, self.pb.log = self._warn, self._err, self._log

    def test_junk_never_raises(self):
        for raw in ('not json', '[1, 2]', '"x"', 'null',
                    frame(['a']), frame('a string'), frame(7), frame(None),
                    frame({'event': ['x'], 'payload': {}}), frame({'event': {'a': 1}, 'payload': {}}),
                    frame({'event': None}), frame({'payload': {}}), frame({'event': 7}),
                    frame({'event': 'cast_problem', 'payload': ['a']}),
                    frame({'event': 'cast_problem', 'payload': 'x' * 5000}),
                    frame({'event': 'nobody_listens', 'payload': {}}),
                    frame(['a'], event='system'), frame('x', event='system'),
                    frame({'status': 'error', 'message': 'y' * 5000}, event='system'),
                    json.dumps({'topic': ['x'], 'event': 'broadcast', 'payload': {}}),
                    json.dumps({'topic': TOPIC, 'event': ['broadcast'], 'payload': {}})):
            self.assertIsNone(self.L.handle(raw), raw[:60])
        self.assertTrue(all(len(w) < 400 for w in self.warned), max(map(len, self.warned)))

    def test_a_good_cast_still_arrives(self):
        self.L.handle(frame({'event': 'cast_problem', 'payload': {'problem_name': 'Good Bug'}}))
        self.assertEqual(self.L.pending[:2], ('problem', 'Good Bug'))

    def test_a_handler_that_raises_is_logged_not_fatal(self):
        def boom(_self, body):
            raise KeyError('bug')
        old = dict(self.pb.Listener.EVENTS)
        self.pb.Listener.EVENTS['cast_problem'] = boom
        try:
            self.assertIsNone(self.L.handle(frame({'event': 'cast_problem', 'payload': {}})))
        finally:
            self.pb.Listener.EVENTS.clear()
            self.pb.Listener.EVENTS.update(old)
        self.assertEqual(self.L.status['error_count'], 1)
        self.assertTrue(any('cast_problem not handled: KeyError' in e for e in self.errors))

    def test_heartbeat_and_channel_errors(self):
        self.assertEqual(self.L.handle(json.dumps({'topic': 'phoenix', 'event': 'phx_reply', 'payload': {}})),
                         'heartbeat')
        with self.assertRaises(self.pb.DeadSocket):
            self.L.handle(frame({}, event='phx_error'))
        self.assertIsNone(self.L.handle(frame({}, event='phx_error', topic='realtime:other')))

    def test_refused_bodies_are_clipped(self):
        self.L.on_cast({'problem_name': 'x' * 61, 'junk': 'y' * 100000})
        self.assertEqual(len(self.warned), 1)
        self.assertLess(len(self.warned[0]), self.pb.CLIP + 100)
        self.assertIn('characters)', self.warned[0])
        self.assertEqual(self.pb.clip({'a': 1}), "{'a': 1}")                 # short ones whole

    def test_frame_size_limit(self):
        self.assertLessEqual(self.pb.MAX_FRAME, 1 << 16)


if __name__ == '__main__':
    unittest.main()
