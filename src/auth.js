import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';

export const SCOPES = ['https://www.googleapis.com/auth/meetings.space.readonly'];

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Returns an authorized OAuth2 client built with googleapis' own google-auth-library,
 * so the Authorization header is always attached to Meet API requests.
 * First run opens the browser for consent and stores a refresh token in token.json.
 */
export async function getAuth(baseDir, { log = console.error } = {}) {
  const credPath = path.join(baseDir, 'credentials.json');
  const tokenPath = path.join(baseDir, 'token.json');

  try {
    const saved = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
    return google.auth.fromJSON(saved);
  } catch {
    // no saved token yet -> interactive login below
  }

  let keys;
  try {
    keys = JSON.parse(await fs.readFile(credPath, 'utf8'));
  } catch {
    throw new Error(
      `Липсва или е невалиден ${credPath}. Свали OAuth клиента (тип "Desktop app") от Google Cloud Console и го запиши под това име.`,
    );
  }
  const key = keys.installed ?? keys.web;
  if (!key?.client_id) throw new Error('credentials.json не съдържа OAuth клиент (очаквам ключ "installed").');

  const client = await interactiveLogin(key, { log });

  if (!client.credentials.refresh_token) {
    throw new Error('Google не върна refresh token. Махни достъпа на приложението от myaccount.google.com/permissions и опитай пак.');
  }
  await fs.writeFile(
    tokenPath,
    JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }),
  );
  return client;
}

export async function forgetToken(baseDir) {
  await fs.rm(path.join(baseDir, 'token.json'), { force: true });
}

/** Loopback OAuth flow for "Desktop app" clients, with PKCE and a state check. */
async function interactiveLogin(key, { log }) {
  const { code, redirectUri, codeVerifier } = await waitForAuthCode({
    buildAuthUrl: async (redirectUri) => {
      const client = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      const state = crypto.randomBytes(16).toString('hex');
      const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // always return a refresh token
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return { url, state, codeVerifier };
    },
    onUrl: (url) => {
      log(`\nОтвори този линк, ако браузърът не се отвори сам:\n${url}\n`);
      openBrowser(url);
    },
  });

  const client = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);
  const { tokens } = await client.getToken({ code, codeVerifier });
  client.setCredentials(tokens);
  log('Входът е успешен.');
  return client;
}

/**
 * Starts a one-shot server on 127.0.0.1 and resolves with the authorization code
 * Google redirects back with. Exported for tests.
 */
export async function waitForAuthCode({ buildAuthUrl, onUrl, timeoutMs = LOGIN_TIMEOUT_MS }) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  try {
    const { url, state, codeVerifier } = await buildAuthUrl(redirectUri);

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Входът не завърши за 5 минути.')), timeoutMs);
      const finish = (res, ok, html, value) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><p style="font:16px system-ui">${html}</p>`);
        clearTimeout(timer);
        ok ? resolve(value) : reject(value);
      };

      server.on('request', (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const error = u.searchParams.get('error');
        if (error) {
          const hint =
            error === 'access_denied'
              ? 'Достъпът е отказан. Провери, че този Gmail е в Test users на приложението и че влизаш точно с него.'
              : `Google върна грешка: ${error}`;
          finish(res, false, hint, new Error(hint));
          return;
        }
        if (u.searchParams.get('state') !== state) {
          finish(res, false, 'Невалиден отговор (state не съвпада).', new Error('OAuth state mismatch'));
          return;
        }
        const code = u.searchParams.get('code');
        if (!code) {
          finish(res, false, 'Липсва код за достъп.', new Error('No authorization code'));
          return;
        }
        finish(res, true, 'Готово, можеш да затвориш този таб и да се върнеш в терминала.', code);
      });

      onUrl(url);
    });

    return { code, redirectUri, codeVerifier };
  } finally {
    server.close();
  }
}

function openBrowser(url) {
  // rundll32 avoids cmd.exe treating "&" in the URL as a command separator.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // the URL is printed anyway
    child.unref();
  } catch {
    // ignore
  }
}
