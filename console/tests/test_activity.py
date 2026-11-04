"""Laptop tests for the Activity dashboard's data (phase 10): the journal lines the probe
parses, the console's own cast history (merge, refresh, a rolled journal), nickname
matching, what counts as a cast, and UK-time bucketing across the clock changes.
Every name here is made up.

    python -m unittest discover -s console/tests      (from the repo root)
"""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
sys.path.insert(0, CONSOLE)
sys.dont_write_bytecode = True
import activity_history as ah  # noqa: E402
import probe  # noqa: E402

H = 'projectboard pb-listener[612]:'
LINES = '\n'.join([
    "2026-11-02T18:00:00.000001+00:00 %s cast received: 'Fake Slab' mirrored [wall, guest]" % H,
    "2026-11-02T18:01:00.000002+00:00 %s cast received: 'Fake Slab'" % H,                       # an old app: no [source, who]
    "2026-11-02T18:02:00.000003+00:00 %s cast received: \"Pete's Fake\" [phone, member]" % H,  # %r quotes a ' with "
    "2026-11-02T23:10:00.000004+00:00 %s cast 'Fake Slab' mirrored ignored: night mode [phone, guest]" % H,
    "2026-11-02T18:10:00.000005+00:00 %s circuit ended: 'Fake Circuit' finished after 40 moves (128 s), 3 s a move, once, run abc123 [phone, member]" % H,
    "2026-11-02T18:20:00.000006+00:00 %s circuit ended: 'Fake Circuit' sent to idle after 5 moves (20 s), 2.5 s a move, loop, run - [wall, guest]" % H,
    "2026-11-02T18:30:00.000007+00:00 %s circuit ended: 'Fake Circuit' stopped after 3 moves (9 s), 3 s a move, loop, run def456" % H,
    "2026-11-02T23:20:00.000008+00:00 %s circuit 'Fake Circuit' ignored: night mode [wall, guest]" % H,
    "2026-11-02T18:40:00.000009+00:00 %s circuit view received: 'Fake Circuit' [wall, guest]" % H,
    "2026-11-02T23:30:00.000010+00:00 %s circuit view 'Fake Circuit' ignored: night mode [wall, guest]" % H,
    "2026-11-02T18:50:00.000011+00:00 %s cast received: '~cast-test-A' [console, guest]" % H,
    "2026-11-02T18:51:00.000012+00:00 %s cast received: 'Fake Overhang' [console, guest]" % H,
    "2026-11-02T18:52:00.000013+00:00 %s circuit received: 'Fake Circuit', 3 s a move, once [phone, member]" % H,  # not counted: its end is
])


def raw_from(text):
    casts, circuits, views = probe.parse_activity(text)
    return {'ok': True, 'casts': casts, 'circuits': circuits, 'views': views, 'journal_from': '2026-10-01 00:00:00'}


class FakeRemote:
    def __init__(self, text):
        self.text, self.asked = text, []

    def probe(self, mode):
        self.asked.append(mode)
        return raw_from(self.text)


class JournalLines(unittest.TestCase):
    def test_every_line_kind(self):
        casts, circuits, views = probe.parse_activity(LINES)
        self.assertEqual([c[1] for c in casts], ['Fake Slab', 'Fake Slab', "Pete's Fake", 'Fake Slab', '~cast-test-A', 'Fake Overhang'])
        self.assertEqual(casts[0][2:], [True, True, 'wall', 'guest'])
        self.assertEqual(casts[1][2:], [False, True, None, None])            # old line: no source, no who
        self.assertEqual(casts[2][4:], ['phone', 'member'])
        self.assertEqual(casts[3][2:4], [True, False])                       # mirrored, ignored at night
        self.assertEqual(len(circuits), 4)
        self.assertEqual(circuits[0][1:10], ['Fake Circuit', 'finished', 40, 128, 3.0, False, 'abc123', 'phone', 'member'])
        self.assertEqual(circuits[1][2], 'sent to idle')
        self.assertIsNone(circuits[1][7])                                    # run -: no token
        self.assertEqual(circuits[2][8:], [None, None])
        self.assertEqual(circuits[3][2], 'night mode')
        self.assertEqual([(v[1], v[2]) for v in views], [('Fake Circuit', True), ('Fake Circuit', False)])

    def test_events(self):
        evs = ah.events_from_probe(raw_from(LINES))
        self.assertNotIn('~cast-test-A', [e['name'] for e in evs])
        run = next(e for e in evs if e['kind'] == 'circuit' and e.get('run') == 'abc123')
        self.assertEqual(run['start'], '2026-11-02T18:07:52.000005+00:00')  # ended 18:10:00, 128 s long
        night = [e for e in evs if e['night']]
        self.assertEqual(sorted(e['kind'] for e in night), ['circuit', 'problem', 'view'])
        self.assertEqual(len({e['key'] for e in evs}), len(evs))

    def test_parse_time(self):
        self.assertEqual(ah.parse_time('2026-11-02T18:00:00+0000'), datetime.datetime(2026, 11, 2, 18, tzinfo=ah.UTC))
        self.assertEqual(ah.parse_time('2026-07-02T19:00:00.5+01:00').hour, 19)
        self.assertIsNone(ah.parse_time('nonsense'))
        self.assertIsNone(ah.parse_time(None))


class Cache(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'activity-history.json')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_merge_is_idempotent(self):
        evs = ah.events_from_probe(raw_from(LINES))
        cache = {'events': {}}
        self.assertEqual(ah.merge(cache, evs), len(evs))
        self.assertEqual(ah.merge(cache, evs), 0)
        self.assertEqual(ah.merge(cache, ah.events_from_probe(raw_from(LINES))), 0)
        self.assertEqual(len(cache['events']), len(evs))

    def test_refresh_survives_a_rolled_journal(self):
        lines = LINES.splitlines()
        first = FakeRemote('\n'.join(lines[:6]))
        cache, st = ah.refresh(first, self.path)
        self.assertTrue(st['ok'])
        self.assertEqual(first.asked, ['history 0'])                          # the first time: the whole journal
        n1 = len(cache['events'])
        # the journal rolled: the oldest three lines are gone, two new ones written
        later = FakeRemote('\n'.join(lines[3:8]))
        cache, st = ah.refresh(later, self.path)
        newest = datetime.datetime(2026, 11, 2, 23, 10, 0, 4, tzinfo=ah.UTC)
        self.assertEqual(later.asked, ['history %d' % (int(newest.timestamp()) - ah.OVERLAP_S)])
        self.assertEqual(st['added'], 2)
        with open(self.path, encoding='utf-8') as f:
            saved = json.load(f)
        self.assertEqual(len(saved['events']), n1 + 2)
        names = [e['name'] for e in saved['events'].values()]
        self.assertIn('Fake Slab', names)                                    # still there after the roll

    def test_refresh_keeps_the_cache_when_the_pi_is_down(self):
        ah.refresh(FakeRemote(LINES), self.path)

        class Down:
            def probe(self, mode):
                return {'ok': False, 'error': 'ssh: no route'}
        cache, st = ah.refresh(Down(), self.path)
        self.assertFalse(st['ok'])
        self.assertIn('no route', st['error'])
        self.assertTrue(cache['events'])


class Build(unittest.TestCase):
    def db(self, **kw):
        d = {'error': None, 'rows': [
            {'at': '2026-11-02T18:02:30+00:00', 'kind': 'problem', 'name': "Pete's Fake", 'mirror': False, 'source': 'phone', 'run': None, 'nickname': 'climber_one'},
            {'at': '2026-11-02T18:07:00+00:00', 'kind': 'circuit', 'name': 'Fake Circuit', 'mirror': False, 'source': 'phone', 'run': 'abc123', 'nickname': 'climber_two'}],
            'ticks': [{'at': '2026-11-02T19:00:00+00:00', 'nickname': 'climber_three', 'name': 'Fake Slab', 'grade': '6a', 'mirrored': True},
                      {'at': '2026-11-02T19:01:00+00:00', 'nickname': 'climber_three', 'name': 'Fake Slab', 'grade': '6a', 'mirrored': False}],
            'accounts': [{'nickname': 'climber_three', 'at': '2026-11-01T10:00:00+00:00'}]}
        d.update(kw)
        return d

    def cache(self, text=LINES):
        c = {'events': {}}
        ah.merge(c, ah.events_from_probe(raw_from(text)))
        return c

    def test_casts_and_exclusions(self):
        out = ah.build(self.cache(), self.db(), {('p', 'Fake Slab'): '6a', ('c', 'Fake Circuit'): '6b'}, today=datetime.date(2026, 11, 4))
        day = [c for c in out['casts'] if c['k'] in ('p', 'c') and not c['x']]
        self.assertEqual(len(day), 7)        # 4 problem casts (one from the console) + 3 circuit runs
        self.assertIn('Fake Overhang', [c['n'] for c in day])
        self.assertNotIn('~cast-test-A', [c['n'] for c in out['casts']])
        self.assertEqual(len([c for c in out['casts'] if c['x']]), 3)        # night: counted apart
        self.assertEqual(len([c for c in out['casts'] if c['k'] == 'v']), 2)
        self.assertEqual(sum(1 for c in day if c['k'] == 'c' and c['how'] == 'finished'), 1)
        self.assertTrue(all(ah.is_cast(e) == (e['kind'] in ('problem', 'circuit') and not e['night'])
                            for e in self.cache()['events'].values()))
        self.assertEqual(next(c for c in day if c['n'] == 'Fake Slab')['g'], '6a')
        self.assertEqual(len(out['ticks']), 2)                               # a mirrored tick is its own tick
        self.assertEqual(out['accounts'][0]['d'], '2026-11-01')

    def test_nicknames(self):
        out = ah.build(self.cache(), self.db(), today=datetime.date(2026, 11, 4))
        by = {(c['n'], c['k']): c for c in out['casts'] if not c['x']}
        self.assertEqual(by[("Pete's Fake", 'p')]['who'], 'climber_one')     # 30 s apart: matched
        self.assertTrue(by[("Pete's Fake", 'p')]['mem'])
        runs = [c for c in out['casts'] if c['k'] == 'c' and not c['x']]
        self.assertEqual(sorted(str(c['who']) for c in runs), ['None', 'None', 'climber_two'])   # by run token
        guests = [c for c in out['casts'] if not c['mem']]
        self.assertTrue(all(c['who'] is None for c in guests))
        # 3 minutes apart: too far to be the same cast, so a guest
        far = self.db(rows=[dict(self.db()['rows'][0], at='2026-11-02T18:05:01+00:00')])
        out = ah.build(self.cache(), far, today=datetime.date(2026, 11, 4))
        self.assertIsNone(next(c for c in out['casts'] if c['n'] == "Pete's Fake")['who'])

    def test_without_the_database(self):
        out = ah.build(self.cache(), {'error': 'no db/.env on this laptop', 'rows': [], 'ticks': [], 'accounts': []},
                       today=datetime.date(2026, 11, 4))
        self.assertEqual(out['names'], 'no db/.env on this laptop')
        self.assertEqual((out['ticks'], out['accounts']), ([], []))
        self.assertTrue(all(c['who'] is None for c in out['casts']))
        self.assertTrue(next(c for c in out['casts'] if c['n'] == "Pete's Fake")['mem'])   # signed in: a member
        self.assertFalse(next(c for c in out['casts'] if c['n'] == 'Fake Overhang')['mem'])

    def test_days_trims_to_twice_the_range(self):
        out = ah.build(self.cache(), None, today=datetime.date(2026, 11, 10), days=3)     # from 5 Nov
        self.assertEqual(out['casts'], [])
        out = ah.build(self.cache(), None, today=datetime.date(2026, 11, 4), days=3)
        self.assertTrue(out['casts'])


class UkTime(unittest.TestCase):
    def at(self, *a):
        return ah.stamp(datetime.datetime(*a, tzinfo=ah.UTC))

    def test_spring_forward(self):                                          # Sun 29 Mar 2026, 01:00 UTC
        self.assertEqual((self.at(2026, 3, 29, 0, 30)['d'], self.at(2026, 3, 29, 0, 30)['h']), ('2026-03-29', 0))
        self.assertEqual(self.at(2026, 3, 29, 1, 30)['h'], 2)
        self.assertEqual(self.at(2026, 3, 28, 23, 30)['h'], 23)

    def test_fall_back(self):                                               # Sun 25 Oct 2026, 01:00 UTC
        self.assertEqual(self.at(2026, 10, 25, 0, 30)['h'], 1)              # 01:30 BST
        self.assertEqual(self.at(2026, 10, 25, 1, 30)['h'], 1)              # 01:30 GMT
        self.assertEqual(self.at(2026, 10, 24, 23, 30)['d'], '2026-10-25')  # past midnight in BST: the next day
        self.assertEqual(self.at(2026, 10, 24, 23, 30)['w'], 6)             # a Sunday
        self.assertEqual(self.at(2026, 10, 25, 23, 30)['d'], '2026-10-25')  # GMT again: the same day

    def test_summer_and_winter(self):
        s = self.at(2026, 7, 1, 23, 30)
        self.assertEqual((s['d'], s['h'], s['w']), ('2026-07-02', 0, 3))    # Thursday, 00:30 BST
        w = self.at(2026, 12, 1, 23, 30)
        self.assertEqual((w['d'], w['h']), ('2026-12-01', 23))
        self.assertEqual(ah.stamp(datetime.datetime(2026, 7, 1, 20, tzinfo=datetime.timezone(datetime.timedelta(hours=1))))['h'], 20)


if __name__ == '__main__':
    unittest.main()
