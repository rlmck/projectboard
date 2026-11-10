"""Laptop tests for PB Console's Holds tab (console/holds.py). No network, no database.

    python -m unittest discover -s console/tests      (from the repo root)

The edits laid over a fake board build admin_publish_board()'s payload (hand holds keep
their position, footholds move to their outline's centre, every hold listed once); bad
edits are refused before anything is sent (shapes, a foothold in use, hand <-> foot pairs,
a pair that doesn't point back, two footholds with one name); the actions check their
arguments and the board version, and confirm with the change list; the routes sit behind
the token and the image path is checked; the page's scripts are served.
"""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
sys.path.insert(0, CONSOLE)
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import actions  # noqa: E402
import holds  # noqa: E402
from test_console import ServerBase  # noqa: E402

SQ = [[10, 10], [20, 10], [20, 20], [10, 20]]
V = '2026-11-10T17:35:33.089+00:00'


def rows():
    return [
        {'id': 'hold1', 'name': 'A1', 'kind': 'hand', 'led': 1, 'x': 15.0, 'y': 15.0, 'outline': SQ * 20, 'mirror': 'hold19'},
        {'id': 'hold19', 'name': 'S1', 'kind': 'hand', 'led': 19, 'x': 85.0, 'y': 15.0,
         'outline': [[80, 10], [90, 10], [90, 20], [80, 20]], 'mirror': 'hold1'},
        {'id': 'hold2', 'name': 'B1', 'kind': 'feet_sign', 'led': 26, 'x': 1, 'y': 1, 'outline': None, 'mirror': None},
        {'id': 'foot1', 'name': 'FT1', 'kind': 'foot', 'led': None, 'x': 30.0, 'y': 90.0,
         'outline': [[29, 89], [31, 89], [31, 91], [29, 91]], 'mirror': 'foot2'},
        {'id': 'foot2', 'name': 'FT2', 'kind': 'foot', 'led': None, 'x': 70.0, 'y': 90.0,
         'outline': [[69, 89], [71, 89], [71, 91], [69, 91]], 'mirror': 'foot1'},
        {'id': 'foot3', 'name': 'FT3', 'kind': 'foot', 'led': None, 'x': 50.0, 'y': 95.0,
         'outline': [[49, 94], [51, 94], [51, 96], [49, 96]], 'mirror': None},
    ]


NAMES = {'foot1': 'FT1', 'foot2': 'FT2', 'foot3': 'FT3'}


class Edits(unittest.TestCase):
    def test_a_redrawn_outline(self):
        payload, lines = holds.apply_edits(rows(), {'outlines': {'hold1': SQ}, 'names': NAMES})
        self.assertEqual(lines, ['A1: outline 80 -> 4 points'])
        by = {h['id']: h for h in payload}
        self.assertEqual(set(by), {'hold1', 'hold19', 'foot1', 'foot2', 'foot3'})     # no feet sign, ever
        self.assertEqual(by['hold1']['outline'], SQ)
        self.assertEqual((by['hold1']['x'], by['hold1']['y']), (15.0, 15.0))        # a hand hold keeps its place
        self.assertEqual(by['hold1']['mirror'], 'hold19')
        self.assertNotIn('name', by['hold1'])
        self.assertEqual(by['foot1']['name'], 'FT1')
        self.assertEqual([h['kind'] for h in payload], ['hand', 'hand', 'foot', 'foot', 'foot'])

    def test_a_redrawn_foothold_moves_to_its_centre_and_points_are_clamped(self):
        e = {'outlines': {'foot3': [[60, 94], [62, 94], [62, 96.004], [60, 96]]}, 'names': NAMES}
        by = {h['id']: h for h in holds.apply_edits(rows(), e)[0]}
        self.assertEqual((by['foot3']['x'], by['foot3']['y']), (61.0, 95.0))
        e = {'outlines': {'hold19': [[-9, 0], [200, 0], [50, 50]]}, 'names': NAMES}
        self.assertEqual(holds.apply_edits(rows(), e)[0][1]['outline'], [[-5.0, 0.0], [105.0, 0.0], [50.0, 50.0]])

    def test_a_new_foothold_paired_and_one_deleted(self):
        e = {'added': [{'id': 'foot4', 'pts': [[40, 90], [42, 90], [42, 92]]}], 'removed': ['foot1'],
             'pairs': {'foot2': 'foot4', 'foot4': 'foot2'}, 'names': {'foot2': 'FT2', 'foot3': 'FT3', 'foot4': 'FT1'}}
        payload, lines = holds.apply_edits(rows(), e)
        by = {h['id']: h for h in payload}
        self.assertNotIn('foot1', by)
        self.assertEqual((by['foot4']['mirror'], by['foot2']['mirror']), ('foot2', 'foot4'))
        self.assertEqual(by['foot4']['name'], 'FT1')
        self.assertIn('FT1: deleted', lines)
        self.assertIn('FT1: new foothold (3 points), paired with FT2', lines)
        self.assertIn('FT2: paired with FT1', lines)

    def test_a_deleted_partner_is_unpaired(self):
        payload, lines = holds.apply_edits(rows(), {'removed': ['foot1'], 'names': NAMES})
        self.assertIsNone({h['id']: h for h in payload}['foot2']['mirror'])
        self.assertIn('FT2: unpaired (was FT1)', lines)

    def test_renamed(self):
        _, lines = holds.apply_edits(rows(), {'names': {'foot1': 'FT2', 'foot2': 'FT1', 'foot3': 'FT3'}})
        self.assertIn('FT1: renamed FT2 (left to right, bottom row up; its id stays foot1)', lines)

    def test_nothing_changed(self):
        self.assertEqual(holds.apply_edits(rows(), {'names': NAMES})[1], [])

    def test_refused(self):
        bad = [
            {'outlines': {'hold1': [[1, 1], [2, 2]]}},                          # too few points
            {'outlines': {'hold1': [[1, 1]] * 401}},                            # too many
            {'outlines': {'hold1': [[1, 'x'], [2, 2], [3, 3]]}},
            {'outlines': {'drop table': SQ}},
            {'outlines': {'hold7': SQ}, 'names': NAMES},                        # not on this board
            {'removed': ['hold1']},                                             # hand holds can't be deleted
            {'removed': ['foot9'], 'names': NAMES},
            {'pairs': {'foot3': 'hold1'}},                                      # never hand <-> foot
            {'pairs': {'foot3': 'foot1'}, 'names': NAMES},                      # foot1 still points at foot2
            {'names': {'foot1': 'FT1', 'foot2': 'FT1', 'foot3': 'FT3'}},        # one name twice
            {'names': {'foot1': 'A1', 'foot2': 'FT2', 'foot3': 'FT3'}},
            {'added': [{'id': 'foot1', 'pts': SQ}], 'names': NAMES},            # already there
            {'added': [{'id': 'foot4', 'pts': SQ}], 'names': NAMES},            # no name for it
            'not an object',
        ]
        for e in bad:
            with self.assertRaises(holds.Refused, msg=repr(e)[:80]):
                holds.apply_edits(rows(), e)

    def test_a_foothold_in_use_stays(self):
        with self.assertRaises(holds.Refused):
            holds.apply_edits(rows(), {'removed': ['foot3'], 'names': NAMES}, {'foot3': 2})

    def test_versions(self):
        self.assertTrue(holds.same_version('2026-11-10T17:35:33.089+00:00', '2026-11-10 17:35:33.089000+00:00'))
        self.assertTrue(holds.same_version('2026-11-10T17:35:33.089Z', V))
        self.assertFalse(holds.same_version(V, '2026-11-10T17:35:33.090+00:00'))
        self.assertFalse(holds.same_version(None, V))


class Actions(unittest.TestCase):
    def test_publish_checks_and_confirms(self):
        with mock.patch.object(holds, 'preview', side_effect=AssertionError('no read')):
            for args in ({}, {'version': 'x', 'edits': {}}, {'version': 5, 'edits': {}}):
                with self.assertRaises(actions.Invalid):
                    actions.build('holds-publish', args)
        with mock.patch.object(holds, 'preview', return_value=(['A1: outline 80 -> 4 points'], V)):
            a = actions.build('holds-publish', {'version': V, 'edits': {}})
            self.assertTrue(a.confirm)
            self.assertIn('A1: outline 80 -> 4 points', a.preview['diff'])
            with self.assertRaises(actions.Invalid):                           # the board moved on
                actions.build('holds-publish', {'version': '2026-11-09T10:00:00+00:00', 'edits': {}})
        with mock.patch.object(holds, 'preview', return_value=([], V)):
            with self.assertRaises(actions.Invalid):                           # nothing to publish
                actions.build('holds-publish', {'version': V, 'edits': {}})
        with mock.patch.object(holds, 'preview', side_effect=holds.Refused('FT3 is in 2 problems')):
            with self.assertRaises(actions.Invalid):
                actions.build('holds-publish', {'version': V, 'edits': {}})

    def test_undo_and_snapshot_are_confirmed(self):
        self.assertTrue(actions.build('holds-undo-publish', {}).confirm)
        with mock.patch.object(actions.gitops, 'status', return_value={'branch': 'main', 'files': [], 'unpushed': []}):
            self.assertTrue(actions.build('holds-ship-snapshot', {}).confirm)
        with mock.patch.object(actions.gitops, 'status', return_value={'branch': 'dev', 'files': [], 'unpushed': []}):
            with self.assertRaises(actions.Invalid):
                actions.build('holds-ship-snapshot', {})


class Server(ServerBase):
    def test_routes_behind_the_token(self):
        self.assertEqual(self.req('GET', '/api/holds', token=None)[0], 401)
        self.assertEqual(self.req('GET', '/api/holds-image?path=x.jpg', token=None)[0], 401)
        fake = {'board': {'version': V}, 'holds': [], 'feet_used': {}, 'snapshot': {}, 'can_publish': False}
        with mock.patch.object(holds, 'board', return_value=fake):
            status, body = self.req('GET', '/api/holds')[:2]
        self.assertEqual(status, 200)
        for bad in ('../db/.env', '/etc/passwd', 'a/../../b.jpg', ''):
            self.assertEqual(self.req('GET', '/api/holds-image?path=' + bad)[0], 400, bad)
        with mock.patch.object(holds, 'image', return_value=b'jpeg bytes'):
            status = self.req('GET', '/api/holds-image?path=setup/x-edit.jpg')[0]
        self.assertEqual(status, 200)

    def test_the_page_scripts_are_served(self):
        for path in ('/static/holds.js', '/app/trace.js', '/app/setup.js'):
            self.assertEqual(self.req('GET', path, token=None)[0], 200, path)
