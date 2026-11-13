import _isolate  # noqa: F401  (first: keeps tests away from the real %APPDATA%)
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import spotify_link as sl  # noqa: E402
from spotify_link import Query, Candidate, Match  # noqa: E402

SECRET_ACCESS = 'ACCESS-SECRET-XYZ'
SECRET_REFRESH = 'REFRESH-SECRET-XYZ'


def resp(status=200, body=None, headers=None):
    return status, headers or {}, json.dumps(body if body is not None else {}).encode()


def track(i, name, artist, dur=200, album='Album'):
    return {'id': 't%s' % i, 'uri': 'spotify:track:t%s' % i, 'name': name,
            'artists': [{'name': a} for a in ([artist] if isinstance(artist, str) else artist)],
            'album': {'name': album}, 'duration_ms': int(dur * 1000),
            'external_urls': {'spotify': 'https://open.spotify.com/track/t%s' % i}}


class Fake:
    """Transport: handler(method, url, headers, body) -> (status, headers, bytes)."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, method, url, headers, body, timeout=30):
        self.calls.append((method, url, headers, body))
        return self.handler(method, url, headers, body)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tokfile = os.path.join(self.tmp.name, 'sub', 'spotify.json')
        self.clock = [1000.0]
        self.sleeps = []
        os.environ.pop('DANKCRAWL_SPOTIFY_CLIENT_ID', None)

    def link(self, handler, cid='cid1', **kw):
        self.fake = Fake(handler)
        return sl.SpotifyLink(client_id=cid, transport=self.fake, now=lambda: self.clock[0],
                              sleep=self.sleeps.append, token_file=self.tokfile, **kw)

    def seed(self, cid='cid1', expires=5000, access=SECRET_ACCESS):
        os.makedirs(os.path.dirname(self.tokfile), exist_ok=True)
        with open(self.tokfile, 'w') as f:
            json.dump({'client_id': cid, 'access_token': access, 'refresh_token': SECRET_REFRESH,
                       'expires_at': expires}, f)


class TestPkceAndServer(Base):
    def test_rfc7636_vector(self):
        v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
        self.assertEqual(sl.pkce_challenge(v), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')

    def test_verifier_length(self):
        v = sl.make_verifier()
        self.assertGreaterEqual(len(v), 64)
        self.assertLessEqual(len(v), 128)

    def test_server_localhost_only_state_and_shutdown(self):
        srv = sl.CallbackServer('good-state', [0])
        self.assertEqual(srv.httpd.server_address[0], '127.0.0.1')
        base = srv.redirect_uri
        got = {}

        def hit():
            try:
                urllib.request.urlopen(base + '?code=BAD&state=evil', timeout=5)
            except urllib.error.HTTPError as e:
                got['bad'] = e.code
            r = urllib.request.urlopen(base + '?code=GOOD&state=good-state', timeout=5)
            got['good'] = r.read().decode()
        t = threading.Thread(target=hit)
        t.start()
        res = srv.wait(10)
        t.join()
        self.assertEqual(got['bad'], 400)  # state mismatch rejected, and did not end the wait
        self.assertEqual(res, {'code': 'GOOD'})
        self.assertIn('close this tab', got['good'])
        with self.assertRaises(OSError):  # shut down
            urllib.request.urlopen(base + '?code=x&state=good-state', timeout=2)

    def test_server_cancel(self):
        srv = sl.CallbackServer('s', [0])
        stop = threading.Event()
        stop.set()
        with self.assertRaises(sl.AuthCancelled):
            srv.wait(5, stop)

    def test_port_in_use_is_clear_error(self):
        a = sl.CallbackServer('s', [0])
        try:
            with self.assertRaises(sl.SpotifyError):
                sl.CallbackServer('s', [a.port])
        finally:
            a.close()

    def test_sign_in_full_flow(self):
        seen = {}

        def handler(method, url, headers, body):
            if url == sl.TOKEN_URL:
                form = urllib.parse.parse_qs(body.decode())
                self.assertEqual(form['grant_type'], ['authorization_code'])
                self.assertEqual(sl.pkce_challenge(form['code_verifier'][0]), seen['challenge'])
                self.assertEqual(form['redirect_uri'], [seen['redirect']])
                return resp(200, {'access_token': SECRET_ACCESS, 'refresh_token': SECRET_REFRESH, 'expires_in': 3600})
            if url.endswith('/me'):
                return resp(200, {'display_name': 'Ian', 'id': 'ian1'})
            raise AssertionError(url)

        def open_browser(url):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            seen['challenge'] = q['code_challenge'][0]
            seen['redirect'] = q['redirect_uri'][0]
            self.assertEqual(q['code_challenge_method'], ['S256'])
            self.assertEqual(q['scope'], [sl.SCOPES])
            cb, st = q['redirect_uri'][0], q['state'][0]
            threading.Thread(target=lambda: urllib.request.urlopen(cb + '?code=C&state=' + st, timeout=5).read()).start()
        link = self.link(handler, open_browser=open_browser, ports=[0])
        self.assertEqual(link.sign_in(), 'Ian')
        self.assertTrue(link.is_signed_in())
        with open(self.tokfile) as f:
            self.assertEqual(json.load(f)['client_id'], 'cid1')


class TestTokens(Base):
    def test_refresh_when_expired_and_persisted(self):
        self.seed(expires=900)  # now=1000 -> expired

        def handler(method, url, headers, body):
            if url == sl.TOKEN_URL:
                self.assertEqual(urllib.parse.parse_qs(body.decode())['grant_type'], ['refresh_token'])
                return resp(200, {'access_token': 'NEW', 'expires_in': 3600})
            self.assertEqual(headers['Authorization'], 'Bearer NEW')
            return resp(200, {'tracks': {'items': []}})
        link = self.link(handler)
        link.find([Query('a', 'b')])
        with open(self.tokfile) as f:
            t = json.load(f)
        self.assertEqual(t['access_token'], 'NEW')
        self.assertEqual(t['refresh_token'], SECRET_REFRESH)  # kept when not rotated
        self.assertEqual(t['expires_at'], 1000 + 3600)
        self.assertFalse(os.path.exists(self.tokfile + '.tmp'))

    def test_client_id_change_ignores_tokens_but_never_deletes_them(self):
        # Another Spotify app's sign-in is unusable here, yet it is not ours to delete: a
        # test run or a wrong client id once wiped a real sign-in this way.
        self.seed(cid='old')
        link = self.link(lambda *a: resp(), cid='new')
        self.assertFalse(link.is_signed_in())
        self.assertTrue(os.path.exists(self.tokfile))

    def test_tests_never_point_at_the_real_sign_in_folder(self):
        home = os.environ['DANKCRAWL_TEST_HOME']
        path = os.path.abspath(sl.token_path())
        self.assertTrue(path.startswith(os.path.abspath(home) + os.sep), path)

    def test_a_failed_refresh_for_network_reasons_keeps_the_sign_in(self):
        self.seed(expires=900)   # expired, so a refresh is attempted
        link = self.link(lambda *a: resp(503, {'error': 'unavailable'}))
        with self.assertRaises(sl.SpotifyError):
            link.find([Query('a', 'b')])
        self.assertTrue(os.path.exists(self.tokfile), 'a 5xx must not log the user out')

    def test_a_rejected_refresh_token_forgets_the_sign_in(self):
        self.seed(expires=900)
        link = self.link(lambda *a: resp(400, {'error': 'invalid_grant'}))
        with self.assertRaises(sl.SpotifyError):
            link.find([Query('a', 'b')])
        self.assertFalse(os.path.exists(self.tokfile))

    def test_sign_out_deletes(self):
        self.seed()
        link = self.link(lambda *a: resp())
        self.assertTrue(link.is_signed_in())
        link.sign_out()
        self.assertFalse(os.path.exists(self.tokfile))
        self.assertFalse(link.is_signed_in())

    def test_needs_client_id(self):
        path = os.path.join(self.tmp.name, 'none.json')
        old = sl.client_id_file
        sl.client_id_file = lambda: path
        self.addCleanup(setattr, sl, 'client_id_file', old)
        # A machine that builds the exe has crawler/_baked_client.py; block it here.
        saved = sys.modules.get('_baked_client', 0)
        sys.modules['_baked_client'] = None
        self.addCleanup(lambda: sys.modules.pop('_baked_client', None) if saved == 0
                        else sys.modules.__setitem__('_baked_client', saved))
        with self.assertRaises(sl.NeedsClientId):
            sl.resolve_client_id(None)
        with open(path, 'w') as f:
            json.dump({'client_id': 'fromfile'}, f)
        self.assertEqual(sl.resolve_client_id(None), 'fromfile')
        os.environ['DANKCRAWL_SPOTIFY_CLIENT_ID'] = 'fromenv'
        self.addCleanup(os.environ.pop, 'DANKCRAWL_SPOTIFY_CLIENT_ID', None)
        self.assertEqual(sl.resolve_client_id(None), 'fromenv')
        self.assertEqual(sl.resolve_client_id('arg'), 'arg')

    def test_401_refreshes_once_then_retries(self):
        self.seed()
        n = {'api': 0}

        def handler(method, url, headers, body):
            if url == sl.TOKEN_URL:
                return resp(200, {'access_token': 'FRESH', 'expires_in': 3600})
            n['api'] += 1
            if headers['Authorization'] == 'Bearer ' + SECRET_ACCESS:
                return resp(401, {'error': {'message': 'expired'}})
            return resp(200, {'tracks': {'items': []}})
        self.link(handler).find([Query('a', 'b')])
        self.assertGreaterEqual(n['api'], 2)

    def test_401_twice_gives_error_without_loop(self):
        self.seed()

        def handler(method, url, headers, body):
            if url == sl.TOKEN_URL:
                return resp(200, {'access_token': 'F', 'expires_in': 3600})
            return resp(401, {'error': {'message': 'nope'}})
        with self.assertRaises(sl.SpotifyError):
            self.link(handler).find([Query('a', 'b')])
        self.assertEqual(sum(1 for c in self.fake.calls if c[1] == sl.TOKEN_URL), 1)

    def test_429_retry_after(self):
        self.seed()
        seq = [resp(429, {}, {'Retry-After': '7'}), resp(200, {'tracks': {'items': []}})]
        link = self.link(lambda *a: seq.pop(0) if len(seq) > 1 else seq[0])
        link.find([Query('a', 'b')])
        self.assertTrue(any(7 <= s <= 8 for s in self.sleeps), self.sleeps)

    def test_403_not_allowlisted(self):
        self.seed()
        link = self.link(lambda *a: resp(403, {'error': {'status': 403, 'message':
                         'Check settings on developer.spotify.com/dashboard, the user may not be registered.'}}))
        with self.assertRaises(sl.NotAllowlisted) as cm:
            link.find([Query('a', 'b')])
        self.assertIn('owner', str(cm.exception))

    def test_5xx_and_network_retries(self):
        self.seed()
        seq = [resp(503), OSError('boom'), resp(200, {'tracks': {'items': []}})]

        def handler(*a):
            r = seq.pop(0) if len(seq) > 1 else seq[0]
            if isinstance(r, Exception):
                raise r
            return r
        m = self.link(handler).find([Query('a', 'b')])
        self.assertEqual(m[0].status, 'missing')

    def test_no_tokens_in_errors(self):
        self.seed()
        for status in (400, 403, 404, 500):
            link = self.link(lambda *a, s=status: resp(s, {'error': {'message': 'bad'}}))
            with self.assertRaises(sl.SpotifyError) as cm:
                link.find([Query('a', 'b')])
            self.assertNotIn(SECRET_ACCESS, str(cm.exception))
            self.assertNotIn(SECRET_REFRESH, str(cm.exception))

        def net(*a):
            raise OSError('down')
        with self.assertRaises(sl.SpotifyError) as cm:
            self.link(net).find([Query('a', 'b')])
        self.assertNotIn(SECRET_ACCESS, str(cm.exception))


def search_link(case, items):
    """Link whose every search returns the given track dicts."""
    case.seed()
    return case.link(lambda method, url, headers, body: resp(200, {'tracks': {'items': items}}))


class TestMatching(Base):
    def one(self, q, tracks):
        return search_link(self, tracks).find([q])[0]

    def test_exact_matched(self):
        m = self.one(Query('Daft Punk', 'Digital Love', duration_sec=301),
                     [track(1, 'Digital Love', 'Daft Punk', 301)])
        self.assertEqual(m.status, 'matched')
        self.assertIs(m.chosen, m.best)

    def test_noise_stripped(self):
        self.assertEqual(sl.clean_title('Song (Official Video) [HD]'), 'Song')
        self.assertEqual(sl.clean_title('Song - 2011 Remaster'), 'Song')
        self.assertEqual(sl.clean_title('Song (Remastered 2009)'), 'Song')
        self.assertEqual(sl.clean_title('Song (feat. Bob)'), 'Song')
        self.assertIn('feat', sl.clean_title('Song (feat. Bob)', keep_feat=True))
        m = self.one(Query('Queen', 'Bohemian Rhapsody (Official Video) [HD]'),
                     [track(1, 'Bohemian Rhapsody - Remastered 2011', 'Queen')])
        self.assertEqual(m.status, 'matched')

    def test_live_penalised_vs_studio(self):
        m = self.one(Query('Muse', 'Starlight', duration_sec=240),
                     [track(1, 'Starlight - Live', 'Muse', 240), track(2, 'Starlight', 'Muse', 240)])
        self.assertEqual(m.best.id, 't2')
        live = [c for c in m.candidates if c.id == 't1'][0]
        self.assertLess(live.score, m.best.score - 0.2)

    def test_live_allowed_when_query_has_live(self):
        m = self.one(Query('Muse', 'Starlight (Live)'), [track(1, 'Starlight - Live', 'Muse')])
        self.assertEqual(m.status, 'matched')

    def test_duration_tiebreak(self):
        m = self.one(Query('A Band', 'Same Name', duration_sec=180),
                     [track(1, 'Same Name', 'A Band', 300), track(2, 'Same Name', 'A Band', 181)])
        self.assertEqual(m.best.id, 't2')

    def test_artist_missing(self):
        link = search_link(self, [track(1, 'Digital Love', 'Daft Punk', 301)])
        m = link.find([Query(None, 'Digital Love', duration_sec=301)])[0]
        self.assertEqual(m.status, 'matched')
        self.assertTrue(all('artist' not in c[1] for c in self.fake.calls))

    def test_no_results_missing(self):
        m = self.one(Query('Nobody', 'Nothing'), [])
        self.assertEqual((m.status, m.best, m.chosen, m.candidates), ('missing', None, None, []))

    def test_wrong_artist_not_matched(self):
        m = self.one(Query('Real Artist', 'Digital Love'), [track(1, 'Digital Love', 'Someone Else')])
        self.assertNotEqual(m.status, 'matched')

    def test_non_latin(self):
        m = self.one(Query('宇多田ヒカル', '光'), [track(1, '光', '宇多田ヒカル')])
        self.assertEqual(m.status, 'matched')
        m = self.one(Query('Sigur Rós', 'Hoppípolla'), [track(1, 'Hoppipolla', 'Sigur Ros')])
        self.assertEqual(m.status, 'matched')

    def test_uncertain_keeps_three(self):
        tr = [track(1, 'Moonlight Sonata Part', 'Beethoven'), track(2, 'Moonlight Sonata Two', 'Beethoven'),
              track(3, 'Moonlight Sonata Three', 'Beethoven'), track(4, 'Moonlight Sonata Four', 'Beethoven')]
        m = self.one(Query('Beethoven', 'Moonlight Sonata'), tr)
        self.assertEqual(m.status, 'uncertain')
        self.assertEqual(len(m.candidates), 3)
        self.assertIsNone(m.chosen)
        self.assertIsNotNone(m.best)

    def test_cache_and_stop(self):
        link = search_link(self, [track(1, 'X', 'Y')])
        link.find([Query('Y', 'X'), Query('Y', 'X')])
        urls = [c[1] for c in self.fake.calls]
        self.assertEqual(len(urls), len(set(urls)))  # identical searches not repeated
        stop = threading.Event()
        stop.set()
        self.assertEqual(link.find([Query('Y', 'X')], stop=stop), [])

    def test_search_uses_limit_10(self):
        search_link(self, []).find([Query('Y', 'X')])
        self.assertIn('limit=10', self.fake.calls[0][1])


class TestPlaylist(Base):
    def matches(self, n, dup=0, unchosen=0):
        out = []
        for i in range(n):
            c = Candidate('spotify:track:%d' % i, str(i), 'n', ['a'], 'al', 100, 0.9, 'u')
            out.append(Match(Query('a', 'n%d' % i), 'matched', c, [c], c))
        for i in range(dup):
            out.append(out[i])
        for i in range(unchosen):
            out.append(Match(Query('a', 'x'), 'missing'))
        return out

    def handler(self):
        self.adds = []

        def h(method, url, headers, body):
            if url.endswith('/me/playlists'):
                self.created = json.loads(body)
                return resp(201, {'id': 'PL', 'external_urls': {'spotify': 'https://open.spotify.com/playlist/PL'}})
            if url.endswith('/playlists/PL/items'):
                self.adds.append(json.loads(body)['uris'])
                return resp(201, {'snapshot_id': 's'})
            raise AssertionError(url)
        return h

    def test_batches_dedup_skip(self):
        self.seed()
        link = self.link(self.handler())
        r = link.create_playlist('Mix', self.matches(250, dup=5, unchosen=3), description='d')
        self.assertEqual([len(b) for b in self.adds], [100, 100, 50])
        self.assertEqual(r['added'], 250)
        self.assertEqual(r['skipped'], 8)
        self.assertEqual(r['url'], 'https://open.spotify.com/playlist/PL')
        self.assertEqual(self.adds[0][0], 'spotify:track:0')
        self.assertIs(self.created['public'], False)

    def test_refuses_empty(self):
        self.seed()
        link = self.link(self.handler())
        with self.assertRaises(sl.SpotifyError):
            link.create_playlist('Mix', [Match(Query('a', 'b'), 'missing')])
        self.assertEqual(self.fake.calls, [])  # nothing created

    def test_save_missing(self):
        c = Candidate('u', 'i', 'Nm', ['Ar'], 'al', 1, 0.6, 'http://x')
        ms = [Match(Query('a', 'b'), 'missing'), Match(Query('c', 'd'), 'uncertain', c, [c], None),
              Match(Query('e', 'f'), 'uncertain', c, [c], c), Match(Query('g', 'h'), 'matched', c, [c], c)]
        p = os.path.join(self.tmp.name, 'm.csv')
        sl.save_missing(ms, p)
        with open(p, encoding='utf-8-sig') as f:
            lines = f.read().strip().splitlines()
        self.assertEqual(len(lines), 3)

    def test_setup_instructions(self):
        s = sl.setup_instructions('C:\\x\\spotify_client.json')
        for needle in ('http://127.0.0.1:8765/callback', 'Web API', 'Premium', 'User Management', 'C:\\x\\spotify_client.json'):
            self.assertIn(needle, s)


def _ref_norm(s):
    """The original, character-by-character normaliser that norm() must keep matching."""
    import unicodedata
    out = []
    for ch in unicodedata.normalize('NFC', s or ''):
        d = unicodedata.normalize('NFKD', ch)
        out.append(d[0] if d and d[0].isascii() else ch)
    s = ''.join(out).casefold().replace('&', ' and ')
    s = ''.join(c if c.isalnum() else ' ' for c in s)
    return ' '.join(s.split())


class TestSpeedups(Base):
    def test_norm_equals_the_original_for_every_kind_of_character(self):
        for cp in range(0, 0x110000, 5):
            if 0xD800 <= cp < 0xE000:
                continue
            s = 'a' + chr(cp) + 'B&' + chr(cp) + '_x'
            self.assertEqual(sl.norm(s), _ref_norm(s), hex(cp))
        for s in ('', None, 'Beyoncé & Jay-Z', 'Sigur Rós', '  A  b ', 'ﬁne ™ ² ½', 'a_b', 'ǅ', 'İstanbul'):
            self.assertEqual(sl.norm(s), _ref_norm(s), s)

    def test_matching_helpers_are_cached(self):
        sl.norm.cache_clear()
        for _ in range(5):
            sl.norm('Some Title (feat. X)')
            sl.clean_title('Some Title (Remastered 2011)')
        self.assertGreaterEqual(sl.norm.cache_info().hits, 4)

    def test_scores_are_unchanged_by_the_caching(self):
        q = Query('Beyoncé & Jay-Z', 'Crazy in Love (feat. Jay-Z) [Remastered]', 'Dangerously', 236)
        first = sl.score_candidate(q, 'Crazy In Love - Remastered 2014', ['Beyoncé', 'JAY-Z'], 'Dangerously in Love', 236)
        again = sl.score_candidate(q, 'Crazy In Love - Remastered 2014', ['Beyoncé', 'JAY-Z'], 'Dangerously in Love', 236)
        self.assertEqual(first, again)
        self.assertGreater(first[0], 0.9)
        self.assertTrue(first[1])

    def test_failed_token_save_leaves_no_tmp_and_the_session_still_works(self):
        link = self.link(lambda *a: resp(200, {}))
        from unittest import mock
        os.makedirs(os.path.dirname(self.tokfile))
        with mock.patch('os.replace', side_effect=PermissionError('locked')):
            link._save({'client_id': 'cid1', 'access_token': 'a', 'refresh_token': 'r', 'expires_at': 9999})
        self.assertEqual(os.listdir(os.path.dirname(self.tokfile)), [])
        self.assertEqual(link._tokens['access_token'], 'a')

    def test_default_browser_opener_is_not_imported_until_sign_in(self):
        link = sl.SpotifyLink(client_id='cid1', transport=Fake(lambda *a: resp()), token_file=self.tokfile)
        self.assertIsNone(link._open)

    def test_token_file_is_owner_only_json(self):
        link = self.link(lambda *a: resp(200, {}))
        link._save({'client_id': 'cid1', 'access_token': 'a', 'refresh_token': 'r', 'expires_at': 9999})
        with open(self.tokfile) as f:
            self.assertEqual(json.load(f)['refresh_token'], 'r')
        if os.name != 'nt':
            self.assertEqual(os.stat(self.tokfile).st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
