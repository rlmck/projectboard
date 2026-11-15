"""Laptop tests for PB Console's Holds tab (console/holds.py). No network, no database.

    python -m unittest discover -s console/tests      (from the repo root)

The edit list is checked for shape only (the database validates it: admin_edit_holds, db/48,
whose own test is db/48_edit_holds_test.sql): a list of known edits, each naming its hold,
never an image or a turn from the laptop; the actions check their arguments, ask the
database for the change list (a rolled-back run) and confirm with it; the routes sit behind
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
    def test_a_good_list(self):
        ops = [{'op': 'outline', 'id': 'hold1', 'outline': SQ}, {'op': 'add_foot', 'id': 'foot4', 'outline': SQ, 'name': 'FT4'},
               {'op': 'delete_foot', 'id': 'foot1'}, {'op': 'pair', 'id': 'foot4', 'with': 'foot2'},
               {'op': 'name', 'id': 'foot3', 'name': 'FT1'}, {'op': 'position', 'id': 'hold1', 'x': 1, 'y': 2}]
        self.assertIs(holds.check_ops(ops), ops)

    def test_refused_by_shape(self):
        bad = [
            [],                                                     # nothing
            'not a list',
            {'outlines': {'hold1': SQ}},                            # the old format
            [{'op': 'teleport', 'id': 'hold1'}],
            [{'op': 'image', 'path': 'setup/x.jpg'}],               # never from the laptop
            [{'op': 'turn', 'id': 'hold1', 'outline': SQ}],
            [{'op': 'outline', 'outline': SQ}],                     # no hold named
            [{'op': 'outline', 'id': 'x' * 21, 'outline': SQ}],
            [{'op': 'outline', 'id': 'hold1', 'outline': SQ}] * 2001,
            ['outline'],
        ]
        for e in bad:
            with self.assertRaises(holds.Refused, msg=repr(e)[:80]):
                holds.check_ops(e)

    def test_database_refusals_in_words(self):
        r = holds._refusal(Exception({'M': 'stale', 'C': 'P0001'}))
        self.assertIn('the board changed', str(r))
        r = holds._refusal(Exception({'M': 'foot_in_use', 'D': 'FT3 is in 2 problem(s)\' Specific feet, so it can\'t be deleted.'}))
        self.assertTrue(str(r).startswith('FT3 is in 2'))
        self.assertIn('nothing to publish', str(holds._refusal(Exception({'M': 'no_change'}))))
        self.assertIsNone(holds._refusal(RuntimeError('network')))

    def test_versions(self):
        self.assertTrue(holds.same_version('2026-11-10T17:35:33.089+00:00', '2026-11-10 17:35:33.089000+00:00'))
        self.assertTrue(holds.same_version('2026-11-10T17:35:33.089Z', V))
        self.assertFalse(holds.same_version(V, '2026-11-10T17:35:33.090+00:00'))
        self.assertFalse(holds.same_version(None, V))


class Actions(unittest.TestCase):
    def test_publish_checks_and_confirms(self):
        ops = [{'op': 'outline', 'id': 'hold1', 'outline': SQ}]
        with mock.patch.object(holds, 'preview', side_effect=AssertionError('no read')):
            for args in ({}, {'version': 'x', 'edits': ops}, {'version': 5, 'edits': ops}):
                with self.assertRaises(actions.Invalid):
                    actions.build('holds-publish', args)
        with mock.patch.object(holds, 'preview', return_value=['A1: outline 80 -> 4 points']) as pv:
            a = actions.build('holds-publish', {'version': V, 'edits': ops})
            self.assertTrue(a.confirm)
            self.assertIn('A1: outline 80 -> 4 points', a.preview['diff'])
            pv.assert_called_with(ops, V)                                      # the page's version goes to the server
        with mock.patch.object(holds, 'preview', return_value=[]):
            with self.assertRaises(actions.Invalid):                           # nothing to publish
                actions.build('holds-publish', {'version': V, 'edits': ops})
        for err in (holds.Refused('the board changed since this page loaded it'), holds.Refused('FT3 is in 2 problems'),
                    RuntimeError('no route to host')):
            with mock.patch.object(holds, 'preview', side_effect=err):
                with self.assertRaises(actions.Invalid):
                    actions.build('holds-publish', {'version': V, 'edits': ops})

    def test_undo_and_snapshot_are_confirmed(self):
        self.assertTrue(actions.build('holds-undo-publish', {}).confirm)
        with mock.patch.object(actions.gitops, 'out', return_value='main'):
            self.assertTrue(actions.build('holds-ship-snapshot', {}).confirm)
        with mock.patch.object(actions.gitops, 'out', return_value='dev'):
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
