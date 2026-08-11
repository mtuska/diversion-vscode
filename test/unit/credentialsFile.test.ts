import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialsDir, readStoredToken } from '../../src/diversion/credentialsFile';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const made: string[] = [];

/** Build a fake `~/.diversion` with the shape `dv` actually writes. */
function makeHome(files: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-creds-'));
  made.push(home);
  const dir = path.join(home, 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return home;
}

const validFile = (expiry: string) => ({
  token: {
    access_token: 'header.payload.signature',
    token_type: 'Bearer',
    refresh_token: 'r'.repeat(40),
    expiry,
  },
  info: { email: 'a@b.co', sub: 'x' },
  source: 'oauth',
  update_time: 1780075070,
});

afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('credentialsDir', () => {
  it('sits under the diversion home', () => {
    expect(credentialsDir('/opt/dv')).toBe(path.join('/opt/dv', 'credentials'));
  });
});

describe('readStoredToken', () => {
  it('returns the access token and expiry from the sole entry', async () => {
    const home = makeHome({ 'dv.u.abc123': validFile('2026-08-11T13:00:00Z') });
    const tok = await readStoredToken({ diversionHome: home, now: NOW });
    expect(tok?.accessToken).toBe('header.payload.signature');
    expect(tok?.expiresAt).toBe(Date.parse('2026-08-11T13:00:00Z'));
  });

  it('reads a named user directly when several accounts are present', async () => {
    const home = makeHome({
      'dv.u.aaa': validFile('2026-08-11T13:00:00Z'),
      'dv.u.bbb': { token: { access_token: 'other.tok.en', expiry: '2026-08-11T13:00:00Z' } },
    });
    const tok = await readStoredToken({ diversionHome: home, userId: 'dv.u.bbb', now: NOW });
    expect(tok?.accessToken).toBe('other.tok.en');
  });

  // Silently acting as one of several accounts is not a call to make for the user.
  it('refuses to guess when multiple accounts exist and none was named', async () => {
    const home = makeHome({
      'dv.u.aaa': validFile('2026-08-11T13:00:00Z'),
      'dv.u.bbb': validFile('2026-08-11T13:00:00Z'),
    });
    expect(await readStoredToken({ diversionHome: home, now: NOW })).toBeUndefined();
  });

  it('rejects an expired token, and one inside the skew window', async () => {
    const stale = makeHome({ 'dv.u.a': validFile('2026-08-11T11:00:00Z') });
    expect(await readStoredToken({ diversionHome: stale, now: NOW })).toBeUndefined();

    const nearly = makeHome({ 'dv.u.a': validFile('2026-08-11T12:00:30Z') });
    expect(await readStoredToken({ diversionHome: nearly, now: NOW })).toBeUndefined();
  });

  // Better to try a token that may work than to refuse over a missing field.
  it('accepts a token whose expiry is absent or unparseable', async () => {
    const noExp = makeHome({ 'dv.u.a': { token: { access_token: 'a.b.c' } } });
    expect((await readStoredToken({ diversionHome: noExp, now: NOW }))?.expiresAt).toBeUndefined();

    const bad = makeHome({ 'dv.u.a': { token: { access_token: 'a.b.c', expiry: 'whenever' } } });
    expect((await readStoredToken({ diversionHome: bad, now: NOW }))?.accessToken).toBe('a.b.c');
  });

  it('returns undefined for every broken-store shape', async () => {
    expect(await readStoredToken({ diversionHome: '/nope/not/here', now: NOW })).toBeUndefined();
    expect(await readStoredToken({ diversionHome: makeHome({}), now: NOW })).toBeUndefined();
    expect(await readStoredToken({
      diversionHome: makeHome({ 'dv.u.a': 'not json' }), now: NOW,
    })).toBeUndefined();
    expect(await readStoredToken({
      diversionHome: makeHome({ 'dv.u.a': { token: { token_type: 'Bearer' } } }), now: NOW,
    })).toBeUndefined();
  });

  it('ignores dotfiles when deciding whether the store is unambiguous', async () => {
    const home = makeHome({ '.DS_Store': 'junk', 'dv.u.a': validFile('2026-08-11T13:00:00Z') });
    expect((await readStoredToken({ diversionHome: home, now: NOW }))?.accessToken)
      .toBe('header.payload.signature');
  });
});
