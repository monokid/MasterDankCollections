"""Spotify playlist engine for DankCrawl: GUI-free, standard library only.

Flow: sign_in() (Authorization Code + PKCE, no client secret) -> find() maps
tracks to Spotify tracks -> create_playlist() builds the playlist.

API notes (checked against the February 2026 Web API migration guide,
https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide):
  * POST /v1/me/playlists replaces POST /users/{id}/playlists.
  * POST /v1/playlists/{id}/items replaces .../tracks (max 100 URIs per call).
  * GET /v1/search: limit is now at most 10 (default 5); we ask for 10.
  * GET /v1/me no longer returns email/country/product; we only use display_name/id.
  * Development-mode apps: owner needs Premium, only a few allowlisted users
    (5 for new apps). Other users get HTTP 403 -> NotAllowlisted.
Never log or put tokens in messages: error text is built only from status
codes and Spotify's own error message fields.
"""
from __future__ import annotations

import base64
import csv
import difflib
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass, field

AUTH_URL = 'https://accounts.spotify.com/authorize'
TOKEN_URL = 'https://accounts.spotify.com/api/token'
API = 'https://api.spotify.com/v1'
SCOPES = 'playlist-modify-private playlist-modify-public'
# The exact redirect URI(s) must be registered in the developer dashboard.
# Extra ports are only tried if the owner registered them too.
DEFAULT_PORTS = [8765]
AUTH_TIMEOUT_SEC = 180
SEARCH_INTERVAL_SEC = 0.15
BATCH = 100
MATCHED_MIN = 0.82
UNCERTAIN_MIN = 0.55


class SpotifyError(Exception):
    pass


class NeedsClientId(SpotifyError):
    pass


class NotAllowlisted(SpotifyError):
    pass


class AuthCancelled(SpotifyError):
    pass


@dataclass
class Query:
    artist: str | None
    title: str | None
    album: str | None = None
    duration_sec: float | None = None
    ref: str = ''


@dataclass
class Candidate:
    uri: str
    id: str
    name: str
    artists: list
    album: str
    duration_sec: float
    score: float
    url: str


@dataclass
class Match:
    query: Query
    status: str  # 'matched' | 'uncertain' | 'missing'
    best: Candidate | None = None
    candidates: list = field(default_factory=list)
    chosen: Candidate | None = None


# ---------------------------------------------------------------- PKCE

def make_verifier() -> str:
    return secrets.token_urlsafe(64)  # 86 chars, within RFC 7636's 43-128


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode('ascii')).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')


# ---------------------------------------------------------------- paths / client id

def token_path() -> str:
    appdata = os.environ.get('APPDATA')
    if os.name == 'nt' and appdata:
        return os.path.join(appdata, 'DankCrawl', 'spotify.json')
    return os.path.join(os.path.expanduser('~'), '.dankcrawl', 'spotify.json')


def app_dir() -> str:
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def client_id_file() -> str:
    return os.path.join(app_dir(), 'spotify_client.json')


def resolve_client_id(explicit: str | None = None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    env = os.environ.get('DANKCRAWL_SPOTIFY_CLIENT_ID', '').strip()
    if env:
        return env
    try:
        with open(client_id_file(), encoding='utf-8-sig') as f:
            cid = str(json.load(f).get('client_id', '')).strip()
        if cid:
            return cid
    except (OSError, ValueError, AttributeError):
        pass
    raise NeedsClientId('No Spotify Client ID found. Put it in ' + client_id_file())


# ---------------------------------------------------------------- default transport

def default_transport(method, url, headers, body, timeout=30):
    """transport(method, url, headers, body_bytes|None, timeout) -> (status, headers, body_bytes).
    Raises OSError on network failure."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except urllib.error.URLError as e:
        raise OSError(str(e.reason)) from None


# ---------------------------------------------------------------- callback server

_PAGE = ('<!doctype html><meta charset="utf-8"><title>DankCrawl</title>'
         '<body style="background:#0b0b10;color:#e8e8f0;font-family:Segoe UI,sans-serif;'
         'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
         '<div style="text-align:center"><h1 style="color:%s">%s</h1><p>%s</p></div></body>')


class _Server(http.server.HTTPServer):
    allow_reuse_address = False  # on Windows reuse would let two apps share a port


class CallbackServer:
    """One-shot listener on 127.0.0.1 for the OAuth redirect."""

    def __init__(self, state: str, ports=None):
        self.state = state
        self.result = None  # {'code': ...} or {'error': ...}
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):  # keep the console (and any token in the URL) quiet
                pass

            def _send(self, code, title, text, color):
                body = (_PAGE % (color, title, text)).encode('utf-8')
                self.send_response(code)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                if u.path != '/callback':
                    self._send(404, 'Not found', 'Nothing here.', '#ff6b6b')
                    return
                q = urllib.parse.parse_qs(u.query)
                got = (q.get('state') or [''])[0]
                if not secrets.compare_digest(got.encode(), outer.state.encode()):
                    self._send(400, 'Rejected', 'This sign-in link did not match. Go back to DankCrawl and try again.', '#ff6b6b')
                    return
                if q.get('error'):
                    outer.result = {'error': q['error'][0]}
                    self._send(200, 'Sign-in cancelled', 'You can close this tab.', '#ffb347')
                elif q.get('code'):
                    outer.result = {'code': q['code'][0]}
                    self._send(200, 'Signed in', 'You can close this tab and go back to DankCrawl.', '#7CFC9A')
                else:
                    self._send(400, 'Rejected', 'Missing code.', '#ff6b6b')

        last = None
        self.httpd = None
        for p in (ports or DEFAULT_PORTS):
            try:
                self.httpd = _Server(('127.0.0.1', p), Handler)
                break
            except OSError as e:
                last = e
        if self.httpd is None:
            raise SpotifyError('Could not open local port(s) %s for the Spotify sign-in (%s). '
                               'Close whatever is using it and try again.' % (list(ports or DEFAULT_PORTS), last))
        self.httpd.timeout = 0.2
        self.port = self.httpd.server_address[1]

    @property
    def redirect_uri(self) -> str:
        return 'http://127.0.0.1:%d/callback' % self.port

    def wait(self, timeout, stop=None):
        deadline = time.monotonic() + timeout
        try:
            while self.result is None:
                if stop is not None and stop.is_set():
                    raise AuthCancelled('Sign-in cancelled.')
                if time.monotonic() > deadline:
                    raise AuthCancelled('Sign-in timed out after %d seconds.' % timeout)
                self.httpd.handle_request()
        finally:
            self.close()
        return self.result

    def close(self):
        try:
            self.httpd.server_close()
        except Exception:
            pass


# ---------------------------------------------------------------- text matching

_NOISE_BRACKET = re.compile(
    r'[\(\[\{][^\)\]\}]*\b(official|video|audio|lyrics?|lyric video|hd|hq|4k|remaster(ed)?|mono|stereo|'
    r'music video|visuali[sz]er|explicit|clean|bonus track|deluxe|version|\d{4})\b[^\)\]\}]*[\)\]\}]', re.I)
_NOISE_SUFFIX = re.compile(r'\s[-–—]\s*(\d{4}\s+)?(digital\s+)?(remaster(ed)?|mono|stereo)(\s+version)?(\s+\d{4})?\s*$', re.I)
_FEAT = re.compile(r'[\(\[]\s*(feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]|\s(feat\.?|ft\.?|featuring)\s.*$', re.I)
_VERSION_WORDS = ('live', 'remix', 'instrumental', 'karaoke', 'cover', 'tribute')


def _fold(s: str) -> str:
    out = []
    for ch in unicodedata.normalize('NFC', s or ''):
        d = unicodedata.normalize('NFKD', ch)
        if d and d[0].isascii():  # strip accents only from Latin letters
            out.append(d[0])
        else:
            out.append(ch)
    return ''.join(out)


def norm(s: str | None) -> str:
    s = _fold(s or '').casefold().replace('&', ' and ')
    s = ''.join(c if c.isalnum() else ' ' for c in s)
    return ' '.join(s.split())


def clean_title(title: str, keep_feat: bool = False) -> str:
    t = title or ''
    for _ in range(3):
        t = _NOISE_BRACKET.sub(' ', t)
    t = _NOISE_SUFFIX.sub('', t)
    if not keep_feat:
        t = _FEAT.sub(' ', t)
    return ' '.join(t.split())


def _tokens(s: str) -> set:
    return set(norm(s).split())


def title_similarity(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    seq = difflib.SequenceMatcher(None, na, nb).ratio()
    ta, tb = set(na.split()), set(nb.split())
    tok = len(ta & tb) / max(len(ta), len(tb))
    return 0.6 * seq + 0.4 * tok


def _split_artists(s: str) -> list:
    parts = re.split(r'\s*(?:,|;|/|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*', s or '', flags=re.I)
    return [p for p in (norm(p) for p in parts) if p]


def artist_overlap(q_artist: str, cand_artists: list) -> bool:
    qs = _split_artists(q_artist)
    whole = norm(q_artist)
    if whole and whole not in qs:
        qs.append(whole)
    cs = [norm(a) for a in cand_artists if norm(a)]
    for q in qs:
        for c in cs:
            if q == c:
                return True
            tq, tc = set(q.split()), set(c.split())
            if tq and tc and (tq <= tc or tc <= tq) and min(len(tq), len(tc)) >= 1 and len(q) > 2 and len(c) > 2:
                return True
            if difflib.SequenceMatcher(None, q, c).ratio() >= 0.88:
                return True
    return False


def score_candidate(q: Query, name: str, artists: list, album: str, duration_sec: float):
    """Return (score in [0,1], artist_ok)."""
    qtitle = clean_title(q.title or '')
    title = title_similarity(qtitle, clean_title(name))
    if q.artist:
        artist_ok = artist_overlap(q.artist, artists)
        artist = 1.0 if artist_ok else 0.0
    else:
        artist_ok, artist = True, 0.6
    score = 0.65 * title + 0.25 * artist
    if q.duration_sec and duration_sec:
        diff = abs(q.duration_sec - duration_sec)
        if diff <= 3:
            score += 0.10
        elif diff <= 0.10 * q.duration_sec:
            score += 0.05
        elif diff > 0.30 * q.duration_sec:
            score -= 0.10
    qwords = _tokens((q.title or '') + ' ' + (q.album or ''))
    cwords = _tokens(name + ' ' + (album or ''))
    for w in _VERSION_WORDS:
        if w in cwords and w not in qwords:
            score -= 0.25
    if q.album and album and norm(q.album) == norm(album):
        score += 0.03
    return max(0.0, min(1.0, score)), artist_ok


def build_searches(q: Query) -> list:
    """Search strings, strictest first."""
    title = clean_title(q.title or '')
    full = clean_title(q.title or '', keep_feat=True)
    out = []
    if title and q.artist:
        out.append('track:"%s" artist:"%s"' % (title.replace('"', ' '), q.artist.replace('"', ' ')))
        if full != title:
            out.append('track:"%s" artist:"%s"' % (full.replace('"', ' '), q.artist.replace('"', ' ')))
        out.append('%s %s' % (q.artist, title))
    elif title:
        out.append(title)
    elif q.artist and q.album:
        out.append('%s %s' % (q.artist, q.album))
    return out


# ---------------------------------------------------------------- the engine

class SpotifyLink:
    def __init__(self, client_id=None, transport=None, open_browser=webbrowser.open, now=time.time,
                 sleep=time.sleep, ports=None, token_file=None):
        self._explicit_id = client_id
        self._transport = transport or default_transport
        self._open = open_browser
        self._now = now
        self._sleep = sleep
        self._ports = list(ports) if ports else list(DEFAULT_PORTS)
        self._token_file = token_file
        self._tokens = None
        self._cache = {}
        self._last_search = None
        self.display_name = None

    # -- client id / token storage
    def _cid(self) -> str:
        return resolve_client_id(self._explicit_id)

    def _path(self) -> str:
        return self._token_file or token_path()

    def _load(self):
        try:
            cid = self._cid()
        except NeedsClientId:
            return None
        if self._tokens is None:
            try:
                with open(self._path(), encoding='utf-8') as f:
                    self._tokens = json.load(f)
            except (OSError, ValueError):
                self._tokens = None
        t = self._tokens
        if not isinstance(t, dict) or not t.get('refresh_token'):
            return None
        if t.get('client_id') != cid:  # tokens belong to another Spotify app
            self.sign_out()
            return None
        return t

    def _save(self, t):
        self._tokens = t
        path = self._path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(t, f)
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, path)
        except OSError:
            pass  # still works for this session, just won't persist

    def is_signed_in(self) -> bool:
        return self._load() is not None

    def sign_out(self) -> None:
        self._tokens = None
        self.display_name = None
        try:
            os.remove(self._path())
        except OSError:
            pass

    # -- token endpoint
    def _token_request(self, form: dict) -> dict:
        body = urllib.parse.urlencode(form).encode()
        hdr = {'Content-Type': 'application/x-www-form-urlencoded'}
        status, _h, data = self._call('POST', TOKEN_URL, hdr, body)
        try:
            j = json.loads(data.decode('utf-8') or '{}')
        except ValueError:
            j = {}
        if status != 200:
            err = j.get('error', '')
            if err == 'invalid_grant':
                raise SpotifyError('Spotify sign-in expired or was rejected. Please sign in again.')
            raise SpotifyError('Spotify sign-in failed (HTTP %d %s %s).' % (
                status, err, j.get('error_description', '')))
        return j

    def _store_token_response(self, j: dict, old_refresh=None):
        t = {'client_id': self._cid(),
             'access_token': j['access_token'],
             'refresh_token': j.get('refresh_token') or old_refresh,
             'expires_at': self._now() + int(j.get('expires_in', 3600))}
        self._save(t)

    def _refresh(self):
        t = self._load()
        if not t:
            raise SpotifyError('Not signed in to Spotify.')
        try:
            j = self._token_request({'grant_type': 'refresh_token',
                                     'refresh_token': t['refresh_token'], 'client_id': self._cid()})
        except SpotifyError:
            self.sign_out()
            raise
        self._store_token_response(j, t['refresh_token'])

    def _access_token(self) -> str:
        t = self._load()
        if not t:
            raise SpotifyError('Not signed in to Spotify.')
        if not t.get('access_token') or self._now() >= t.get('expires_at', 0) - 30:
            self._refresh()
            t = self._tokens
        return t['access_token']

    # -- low-level HTTP with retries
    def _call(self, method, url, headers, body):
        last = None
        for attempt in range(4):
            try:
                return self._transport(method, url, headers, body, 30)
            except OSError as e:
                last = e
                self._sleep(0.5 * (2 ** attempt))
        raise SpotifyError('Could not reach Spotify (%s). Check the internet connection.' % type(last).__name__)

    def _api(self, method, path, params=None, payload=None):
        url = API + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        body = json.dumps(payload).encode() if payload is not None else None
        refreshed = False
        retries5 = 0
        retries429 = 0
        while True:
            hdr = {'Authorization': 'Bearer ' + self._access_token(), 'Accept': 'application/json'}
            if body is not None:
                hdr['Content-Type'] = 'application/json'
            status, h, data = self._call(method, url, hdr, body)
            if status == 401 and not refreshed:
                refreshed = True
                self._refresh()
                continue
            if status == 429 and retries429 < 5:
                retries429 += 1
                low = {k.lower(): v for k, v in h.items()}
                try:
                    wait = float(low.get('retry-after', 1))
                except ValueError:
                    wait = 1.0
                if wait > 120:
                    raise SpotifyError('Spotify asked us to wait %d seconds; try again later.' % wait)
                self._sleep(wait + 0.1)
                continue
            if status >= 500 and retries5 < 3:
                retries5 += 1
                self._sleep(1.0 * retries5)
                continue
            try:
                j = json.loads(data.decode('utf-8')) if data else {}
            except ValueError:
                j = {}
            if 200 <= status < 300:
                return j
            msg = ''
            e = j.get('error') if isinstance(j, dict) else None
            if isinstance(e, dict):
                msg = str(e.get('message', ''))
            elif e:
                msg = str(e)
            if status == 403 and ('not registered' in msg.lower() or 'allowlist' in msg.lower()
                                  or 'user may not be' in msg.lower()):
                raise NotAllowlisted(
                    "This Spotify account isn't on the app's allowed-users list yet. Ask the owner of "
                    "DankCrawl to add your Spotify account email in the Spotify developer dashboard "
                    "(User Management), then try again.")
            if status == 401:
                raise SpotifyError('Spotify rejected the sign-in. Please sign in again.')
            if status == 429:
                raise SpotifyError('Spotify is rate-limiting us; try again in a minute.')
            raise SpotifyError('Spotify error HTTP %d%s' % (status, ': ' + msg if msg else ''))

    # -- sign in
    def sign_in(self, stop=None, status=None) -> str:
        say = status or (lambda m: None)
        cid = self._cid()
        verifier = make_verifier()
        state = secrets.token_urlsafe(24)
        server = CallbackServer(state, self._ports)
        redirect = server.redirect_uri
        url = AUTH_URL + '?' + urllib.parse.urlencode({
            'client_id': cid, 'response_type': 'code', 'redirect_uri': redirect,
            'scope': SCOPES, 'state': state,
            'code_challenge_method': 'S256', 'code_challenge': pkce_challenge(verifier)})
        try:
            say('Opening your browser to sign in to Spotify...')
            try:
                self._open(url)
            except Exception:
                pass
            say('Waiting for you to approve in the browser...')
            res = server.wait(AUTH_TIMEOUT_SEC, stop)
        finally:
            server.close()
        if 'error' in res:
            raise AuthCancelled('Spotify sign-in was not approved (%s).' % res['error'])
        say('Finishing sign-in...')
        j = self._token_request({'grant_type': 'authorization_code', 'code': res['code'],
                                 'redirect_uri': redirect, 'client_id': cid, 'code_verifier': verifier})
        self._store_token_response(j)
        me = self._api('GET', '/me')
        self.display_name = me.get('display_name') or me.get('id') or 'Spotify user'
        return self.display_name

    # -- matching
    def _search(self, qstr: str) -> list:
        if qstr in self._cache:
            return self._cache[qstr]
        if self._last_search is not None:
            self._sleep(SEARCH_INTERVAL_SEC)
        self._last_search = True
        j = self._api('GET', '/search', {'q': qstr, 'type': 'track', 'limit': 10})
        items = ((j.get('tracks') or {}).get('items')) or []
        self._cache[qstr] = [i for i in items if isinstance(i, dict) and i.get('uri') and i.get('id')]
        return self._cache[qstr]

    def _match_one(self, q: Query) -> Match:
        found = {}
        searches = build_searches(q)
        for s in searches:
            for it in self._search(s):
                if it['id'] in found:
                    continue
                artists = [a.get('name', '') for a in it.get('artists', [])]
                album = (it.get('album') or {}).get('name', '')
                dur = (it.get('duration_ms') or 0) / 1000.0
                sc, ok = score_candidate(q, it.get('name', ''), artists, album, dur)
                found[it['id']] = (Candidate(
                    uri=it['uri'], id=it['id'], name=it.get('name', ''), artists=artists, album=album,
                    duration_sec=dur, score=round(sc, 4),
                    url=(it.get('external_urls') or {}).get('spotify', 'https://open.spotify.com/track/' + it['id'])), ok)
            top = max(found.values(), key=lambda v: v[0].score, default=None)
            if top and top[0].score >= MATCHED_MIN and top[1]:
                break  # good enough, skip looser searches
        ranked = sorted(found.values(), key=lambda v: v[0].score, reverse=True)
        if not ranked or ranked[0][0].score < UNCERTAIN_MIN:
            return Match(q, 'missing')
        best, ok = ranked[0]
        cands = [c for c, _ in ranked[:3]]
        if best.score >= MATCHED_MIN and ok:
            return Match(q, 'matched', best, cands, best)
        return Match(q, 'uncertain', best, cands, None)

    def find(self, queries: list, progress=None, stop=None) -> list:
        """Returns matches for the queries processed; if stopped early, only those completed."""
        out = []
        for i, q in enumerate(queries):
            if stop is not None and stop.is_set():
                break
            if progress:
                progress(i, len(queries), q)
            out.append(self._match_one(q))
        if progress and not (stop is not None and stop.is_set()):
            progress(len(queries), len(queries), None)
        return out

    # -- playlist
    def create_playlist(self, name, matches, description='', public=False, progress=None, stop=None) -> dict:
        uris, seen, skipped = [], set(), 0
        for m in matches:
            c = m.chosen
            if c is None or c.uri in seen:
                skipped += 1
                continue
            seen.add(c.uri)
            uris.append(c.uri)
        if not uris:
            raise SpotifyError('Nothing to add: no track has a Spotify match chosen.')
        pl = self._api('POST', '/me/playlists', payload={
            'name': name or 'DankCrawl playlist', 'description': description, 'public': bool(public)})
        added = 0
        stopped = False
        for i in range(0, len(uris), BATCH):
            if stop is not None and stop.is_set():
                stopped = True
                break
            batch = uris[i:i + BATCH]
            self._api('POST', '/playlists/%s/items' % pl['id'], payload={'uris': batch})
            added += len(batch)
            if progress:
                progress(added, len(uris))
        return {'id': pl['id'], 'added': added, 'skipped': skipped, 'stopped': stopped,
                'url': (pl.get('external_urls') or {}).get('spotify', 'https://open.spotify.com/playlist/' + pl['id'])}


# ---------------------------------------------------------------- helpers for the GUI

def save_missing(matches, path):
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['status', 'artist', 'title', 'album', 'duration_sec', 'ref', 'best_guess', 'best_url'])
        for m in matches:
            if m.status == 'missing' or (m.status == 'uncertain' and m.chosen is None):
                q, b = m.query, m.best
                w.writerow([m.status, q.artist or '', q.title or '', q.album or '',
                            '' if q.duration_sec is None else round(q.duration_sec),
                            q.ref, ('%s - %s' % (', '.join(b.artists), b.name)) if b else '', b.url if b else ''])


def setup_instructions(client_id_file_path: str) -> str:
    return '\n'.join([
        'One-time Spotify setup (about 5 minutes, free; the app owner needs Spotify Premium):',
        '1. Open https://developer.spotify.com/dashboard and log in with the owner Spotify account.',
        '2. Click "Create app". App name: DankCrawl. Description: anything.',
        '3. Redirect URI: type exactly  http://127.0.0.1:8765/callback  and click Add (it must match exactly).',
        '4. Tick the "Web API" checkbox, accept the terms, and Save.',
        '5. Open the app\'s Settings and copy the Client ID (not the secret; DankCrawl does not need it).',
        '6. Create a text file at:\n   %s\n   containing:  {"client_id": "PASTE_CLIENT_ID_HERE"}' % client_id_file_path,
        '7. Under User Management, add each friend who will use it: their full name and the email '
        'of their Spotify account (development-mode apps allow only a handful of users, currently 5 '
        'for new apps).',
        '8. Restart DankCrawl and press the Spotify button; each person signs in with their own account.',
    ])
