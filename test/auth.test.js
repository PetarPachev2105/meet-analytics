import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';

import { waitForAuthCode, getAuth } from '../src/auth.js';

// Simulates the browser being redirected back by Google.
function flow(query) {
  return waitForAuthCode({
    timeoutMs: 2000,
    buildAuthUrl: async (redirectUri) => ({ url: redirectUri, state: 'S1', codeVerifier: 'V1' }),
    onUrl: (redirectUri) => {
      http.get(`${redirectUri}/?${query}`, (res) => res.resume());
    },
  });
}

test('loopback login returns the code on a valid redirect', async () => {
  const r = await flow('state=S1&code=4%2FabcDEF');
  assert.equal(r.code, '4/abcDEF');
  assert.equal(r.codeVerifier, 'V1');
  assert.match(r.redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('loopback login explains access_denied (user not in Test users)', async () => {
  await assert.rejects(flow('error=access_denied&state=S1'), /Test users/);
});

test('loopback login rejects a mismatched state', async () => {
  await assert.rejects(flow('state=EVIL&code=x'), /state mismatch/);
});

// Regression: the client must come from googleapis' own auth library, otherwise
// the Authorization header is silently dropped ("Request is missing required authentication credential").
test('client from token.json actually sends the Authorization header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-auth-'));
  await fs.writeFile(
    path.join(dir, 'token.json'),
    JSON.stringify({ type: 'authorized_user', client_id: 'id', client_secret: 's', refresh_token: 'r' }),
  );
  const auth = await getAuth(dir);
  auth.setCredentials({ ...auth.credentials, access_token: 'ya29.test', expiry_date: Date.now() + 3600e3 });

  let header;
  const server = http.createServer((req, res) => {
    header = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end('{"conferenceRecords":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const meet = google.meet({ version: 'v2', auth, rootUrl: `http://127.0.0.1:${server.address().port}/` });
    await meet.conferenceRecords.list({});
  } finally {
    server.close();
  }
  assert.equal(header, 'Bearer ya29.test');
});
