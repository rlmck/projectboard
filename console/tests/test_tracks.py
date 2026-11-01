"""Laptop tests for PB Console's Circuit tracks tab (contract 8.6, db/37). No Pi, no database.

    python -m unittest discover -s console/tests      (from the repo root)

The board positions match the circuit trace demo's table; the demo's export
imports and passes the save check (which is the Pi's check_track plus every move
present and the size limit); stale, incomplete and oversized tracks are refused;
the change list; the actions' argument checks, confirm and the write (the
database faked); the /api/tracks route behind the token; the circuit test cast's
journal receipt; the new config keys in the helper.
"""
import copy
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
REPO = os.path.dirname(CONSOLE)
sys.path.insert(0, CONSOLE)
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import actions  # noqa: E402
import tracks  # noqa: E402
from test_console import ServerBase  # noqa: E402

PB_ROW = {'id': 'x', 'name': 'Pat Burner', 'grade': '5a', 'start_count': 2, 'loops': True, 'led_track': None,
          'hold_sequence': ['hold47', 'hold24', 'hold98', 'hold119', 'hold213', 'hold235', 'hold235', 'hold206',
                            'hold148', 'hold112', 'hold53', 'hold49']}


def export():
    with open(os.path.join(REPO, 'tools', 'circuit-tracks-pat-burner.json'), encoding='utf-8') as f:
        return json.load(f)


def pb_track():
    return tracks.from_export(export(), PB_ROW)[0]


class Positions(unittest.TestCase):
    def test_cells_match_the_demo(self):
        with open(os.path.join(REPO, 'tools', 'circuit-trace-demo.html'), encoding='utf-8') as f:
            line = next(l for l in f if l.startswith('const CELLS = '))
        demo = json.loads(line[line.index('{'):line.rindex('}') + 1])
        mine = tracks.cells()
        self.assertEqual(len(mine), 247)
        for n in range(1, 248):
            self.assertEqual(mine[n], demo[str(n)], n)


class Checks(unittest.TestCase):
    def test_the_demo_export_imports_clean(self):
        track, notes = tracks.from_export(export(), PB_ROW)
        self.assertEqual(notes, [])
        self.assertEqual([m['move'] for m in track['moves']], [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12])
        self.assertEqual(track['moves'][4]['cells'], ['hold214', 'hold177', 'hold178'])
        self.assertEqual(tracks.check_for_save(track, PB_ROW), track)

    def test_import_fills_missing_moves_and_drops_stale_ones(self):
        data = export()
        data['circuits']['Pat Burner']['moves'] = [m for m in data['circuits']['Pat Burner']['moves'] if m['move'] != 3]
        data['circuits']['Pat Burner']['moves'][0]['from'] = 'hold1'       # stale
        track, notes = tracks.from_export(data, PB_ROW)
        self.assertEqual(len(notes), 3)                                   # move 3 + move 1 suggested, the stale one left out
        tracks.check_for_save(track, PB_ROW)
        with self.assertRaises(tracks.Refused):
            tracks.from_export({'format': 'other'}, PB_ROW)
        with self.assertRaises(tracks.Refused):
            tracks.from_export(data, dict(PB_ROW, name='Nope'))

    def test_save_refuses_what_the_pi_would_skip(self):
        for change in (lambda t: t['moves'][1].update(cells=['hold21']),            # a feet sign
                       lambda t: t['moves'][1].update(cells=['hold43', 'hold43']),  # twice
                       lambda t: t['moves'][1].update(**{'from': 'hold1'}),         # stale
                       lambda t: t['moves'].pop(3),                                 # a move missing
                       lambda t: t['moves'][1].update(cells=['hold%d' % n for n in range(60, 101)]),   # 41 LEDs
                       lambda t: t.update(version=2)):
            t = pb_track()
            change(t)
            with self.assertRaises(tracks.Refused):
                tracks.check_for_save(t, PB_ROW)
        with self.assertRaises(tracks.Refused):
            tracks.check_for_save('nope', PB_ROW)

    def test_size_limit(self):
        t = pb_track()
        t['moves'][0]['cells'] = []
        t['moves'][0]['junk'] = 'x' * 40000                 # extra keys are dropped before the size check
        tracks.check_for_save(t, PB_ROW)
        with mock.patch.object(tracks.circuit_mod(), 'TRACK_MAX_BYTES', 200):
            with self.assertRaises(tracks.Refused):
                tracks.check_for_save(pb_track(), PB_ROW)

    def test_suggested_lines(self):
        cells = tracks.suggested(PB_ROW['hold_sequence'], 'hold24', 'hold98')     # E2 -> C6
        self.assertTrue(cells)
        self.assertFalse(set(cells) & set(PB_ROW['hold_sequence']))
        self.assertFalse(set(cells) & {'hold2', 'hold21'})

    def test_describe_changes(self):
        new = pb_track()
        self.assertEqual(len(tracks.describe_changes(None, new, PB_ROW['hold_sequence'])), 11)  # every move is new
        old = copy.deepcopy(new)
        old['moves'][1]['cells'] = ['hold43']
        lines = tracks.describe_changes(old, new, PB_ROW['hold_sequence'])
        self.assertEqual(lines, ['move 2 (E2 -> C6): E3 -> E3, D4'])
        self.assertEqual(tracks.describe_changes(new, new, PB_ROW['hold_sequence']), [])


class Actions(unittest.TestCase):
    def test_arguments_checked_before_the_database(self):
        with mock.patch.object(tracks, 'get_circuit', side_effect=AssertionError('no db call')):
            for kind, args in (('circuit-track-save', {}), ('circuit-track-save', {'circuit': 'x' * 61, 'track': {}}),
                               ('circuit-track-save', {'circuit': 'Pat Burner', 'track': 'x'}),
                               ('circuit-track-remove', {'circuit': 5}), ('circuit-test-cast', {'circuit': ''})):
                with self.assertRaises(actions.Invalid, msg=kind):
                    actions.build(kind, args)

    def test_save_is_checked_and_confirmed(self):
        with mock.patch.object(tracks, 'get_circuit', return_value=dict(PB_ROW)):
            a = actions.build('circuit-track-save', {'circuit': 'Pat Burner', 'track': pb_track()})
            self.assertTrue(a.confirm)
            self.assertIn('move 5 (D12 -> G13)', a.preview['diff'])
            bad = pb_track()
            bad['moves'][2]['to'] = 'hold1'
            with self.assertRaises(actions.Invalid):
                actions.build('circuit-track-save', {'circuit': 'Pat Burner', 'track': bad})
        with mock.patch.object(tracks, 'get_circuit', return_value=None):
            with self.assertRaises(actions.Invalid):
                actions.build('circuit-track-save', {'circuit': 'Nope', 'track': pb_track()})
        with mock.patch.object(tracks, 'get_circuit', side_effect=RuntimeError('no db/.env on this laptop')):
            with self.assertRaises(actions.Invalid):
                actions.build('circuit-track-save', {'circuit': 'Pat Burner', 'track': pb_track()})

    def test_remove_needs_a_track(self):
        with mock.patch.object(tracks, 'get_circuit', return_value=dict(PB_ROW)):
            with self.assertRaises(actions.Invalid):
                actions.build('circuit-track-remove', {'circuit': 'Pat Burner'})
        with mock.patch.object(tracks, 'get_circuit', return_value=dict(PB_ROW, led_track=pb_track())):
            self.assertTrue(actions.build('circuit-track-remove', {'circuit': 'Pat Burner'}).confirm)

    def test_test_cast_is_confirmed_and_busy_checked(self):
        a = actions.build('circuit-test-cast', {'circuit': 'Pat Burner'})
        self.assertTrue(a.confirm and a.busy)
        actions.LAST_TEST_RUN.clear()
        with self.assertRaises(actions.Invalid):
            actions.build('circuit-test-stop', {})

    def test_circuit_receipt(self):
        sent = 1000.0
        lines = [{'MESSAGE': "circuit received: 'Pat Burner', 3 s a move, once, trace 3 s [console, unknown]",
                  '__REALTIME_TIMESTAMP': '1000200000'},
                 {'MESSAGE': "circuit 'Pat Burner': track moves skipped: move 3: stale", '__REALTIME_TIMESTAMP': '1000300000'},
                 {'MESSAGE': "circuit started 'Pat Burner': 12 holds, 10 moves, 3 s a move, once, trace 3 s, track 11 moves, "
                             "run ab, in 300 ms", '__REALTIME_TIMESTAMP': '1000400000'}]
        got = actions._circuit_receipt('\n'.join(json.dumps(l) for l in lines), 'Pat Burner', sent)
        self.assertIn('+200 ms', got['received'])
        self.assertIn('track 11 moves', got['started'])
        self.assertIn('stale', got['skipped'])

    def test_helper_has_the_circuit_keys(self):
        h = actions.helper()
        for k, v in (('CIRCUIT_GHOST', '0'), ('CIRCUIT_GHOST', '0.3'), ('CIRCUIT_TRACK_RUN', 'all'),
                     ('CIRCUIT_TRACK_LEVEL', '0.5'), ('CIRCUIT_MAX_S', '1800')):
            h.check_value(k, v)
        for k, v in (('CIRCUIT_GHOST', '0.31'), ('CIRCUIT_TRACK_RUN', 'some'), ('CIRCUIT_TRACK_LEVEL', '-1'),
                     ('CIRCUIT_MAX_S', '5')):
            with self.assertRaises(h.Refused):
                h.check_value(k, v)
        self.assertTrue(h.needs_restart('CIRCUIT_GHOST'))
        keys = [r['key'] for r in actions.config_keys()]
        self.assertIn('CIRCUIT_TRACK_RUN', keys)


class Server(ServerBase):
    def test_tracks_route_behind_the_token(self):
        self.assertEqual(self.req('GET', '/api/tracks', token=None)[0], 401)
        with mock.patch.object(tracks, 'list_circuits', return_value=[dict(PB_ROW)]):
            status, body = self.req('GET', '/api/tracks')[:2]
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertEqual(d['circuits'][0]['name'], 'Pat Burner')
        self.assertEqual(len(d['cells']), 247)
        self.assertEqual(d['limits']['cells'], 40)

    def test_board_photo_and_script_served(self):
        import http.client
        self.assertEqual(self.req('GET', '/static/tracks.js', token=None)[0], 200)
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=20)
        c.request('GET', '/board.jpg', headers={'Host': '127.0.0.1:%d' % self.port})
        r = c.getresponse()
        self.assertEqual((r.status, r.getheader('Content-Type'), r.read()[:2]), (200, 'image/jpeg', bytes([0xFF, 0xD8])))
        c.close()

    def test_save_needs_confirm_and_writes(self):
        written = []
        with mock.patch.object(tracks, 'get_circuit', return_value=dict(PB_ROW)), \
                mock.patch.object(tracks, 'write', side_effect=lambda *a, **k: written.append(a) or 1):
            body = {'action': 'circuit-track-save', 'args': {'circuit': 'Pat Burner', 'track': pb_track()}}
            self.assertEqual(self.req('POST', '/api/action', body)[0], 400)            # no confirm
            self.assertEqual(written, [])
            status, text = self.req('POST', '/api/action', dict(body, confirm=True))[:2]
        self.assertEqual(status, 200)
        self.assertIn('"ok": true', text if isinstance(text, str) else text.decode())
        self.assertEqual(written[0][0], 'Pat Burner')
        self.assertEqual(written[0][2], PB_ROW['hold_sequence'])
        with open(actions.AUDIT, encoding='utf-8') as f:
            audit = f.read()
        self.assertIn('circuit track save Pat Burner', audit)


if __name__ == '__main__':
    unittest.main()
