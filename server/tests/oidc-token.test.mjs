// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenRedemption } from '../oidc-token.mjs';

const ISSUER = 'https://auth.example.test/realms/junctura';
const ORIGIN = 'https://portal.example.test';
const REDIRECT_URI = 'https://portal.example.test/auth/callback';
const CLIENT_ID = 'backend-client';
const CLIENT_SECRET = 'backend-secret';
const PKCE_VERIFIER = 'A'.repeat(43);
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;

function form(fields) {
  return new URLSearchParams(fields).toString();
}

function request({
  method = 'POST',
  url = '/api/auth/token',
  origin = ORIGIN,
  contentType = 'application/x-www-form-urlencoded',
  body = '',
  headers = {},
} = {}) {
  const requestHeaders = {};
  if (origin !== undefined) requestHeaders.origin = origin;
  if (contentType !== undefined) requestHeaders['content-type'] = contentType;
  Object.assign(requestHeaders, headers);

  const chunks = body === '' ? [] : [Buffer.from(body)];

  return {
    method,
    url,
    headers: requestHeaders,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function tokenResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function captureFetcher(respond) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { fetcher, calls };
}

function makeRedeem(fetcher, overrides = {}) {
  return createTokenRedemption({
    issuer: ISSUER,
    origin: ORIGIN,
    redirectUri: REDIRECT_URI,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetcher,
    ...overrides,
  });
}

const AUTHORIZATION_CODE_BODY = {
  grant_type: 'authorization_code',
  code: 'authorization-code-1',
  code_verifier: PKCE_VERIFIER,
  redirect_uri: REDIRECT_URI,
};

const REFRESH_GRANT_BODY = {
  grant_type: 'refresh_token',
  refresh_token: 'refresh-token-1',
};

test('authorization_code grant maps only safe token output', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: 'refresh-1',
    refresh_expires_in: 1800,
    id_token: 'id-1',
    scope: 'openid profile',
    session_state: 'must-not-leak',
    'not-before-policy': 0,
  }));

  const [status, body, headers] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 200);
  assert.deepEqual(body, {
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 300,
    id_token: 'id-1',
    scope: 'openid profile',
  });
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(headers['content-type'], /^application\/json/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(
    calls[0].init.headers.authorization,
    `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
  );

  const sent = new URLSearchParams(calls[0].init.body);
  assert.deepEqual(Object.fromEntries(sent), AUTHORIZATION_CODE_BODY);
  assert.equal(sent.has('client_id'), false);
  assert.equal(sent.has('refresh_token'), false);
});

test('rejects refresh_token grants without calling upstream', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(REFRESH_GRANT_BODY) }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'unsupported_grant_type' });
  assert.equal(calls.length, 0);
});

test('rejects a different portal Origin without calling upstream', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({ origin: 'https://evil.example.test', body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden' });
  assert.equal(calls.length, 0);
});

test('rejects a missing Origin without calling upstream', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const req = request({ body: form(AUTHORIZATION_CODE_BODY) });
  delete req.headers.origin;
  const [status, body] = await makeRedeem(fetcher)(req);

  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden' });
  assert.equal(calls.length, 0);
});

test('allows an identical optional public client_id but never forwards it upstream', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({
    access_token: 'access-3',
    token_type: 'Bearer',
  }));

  const [status] = await makeRedeem(fetcher)(
    request({ body: form({ ...AUTHORIZATION_CODE_BODY, client_id: CLIENT_ID }) }),
  );

  assert.equal(status, 200);
  assert.equal(new URLSearchParams(calls[0].init.body).has('client_id'), false);
});

test('rejects a mismatched public client_id', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form({ ...AUTHORIZATION_CODE_BODY, client_id: 'someone-else' }) }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_client' });
  assert.equal(calls.length, 0);
});

test('rejects a redirect_uri that is not the exact configured value', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form({ ...AUTHORIZATION_CODE_BODY, redirect_uri: `${REDIRECT_URI}/extra` }) }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('rejects unsupported grant types', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form({ grant_type: 'password', username: 'a', password: 'b' }) }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'unsupported_grant_type' });
  assert.equal(calls.length, 0);
});

test('rejects missing grant_type', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(request({ body: form({ code: 'x' }) }));

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('rejects duplicate fields', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({
      body: form(AUTHORIZATION_CODE_BODY) + '&code=second-code',
    }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('rejects extra fields', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form({ ...AUTHORIZATION_CODE_BODY, scope: 'openid' }) }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('rejects missing PKCE verifier', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({
      body: form({
        grant_type: 'authorization_code',
        code: 'authorization-code-1',
        redirect_uri: REDIRECT_URI,
      }),
    }),
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('rejects non-POST methods', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body, headers] = await makeRedeem(fetcher)(
    request({ method: 'GET', body: '' }),
  );

  assert.equal(status, 405);
  assert.deepEqual(body, { error: 'method_not_allowed' });
  assert.equal(headers.allow, 'POST');
  assert.equal(calls.length, 0);
});

test('rejects paths with a query string or a different path', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const redeem = makeRedeem(fetcher);

  const [queryStatus] = await redeem(
    request({ url: '/api/auth/token?next=1', body: form(AUTHORIZATION_CODE_BODY) }),
  );
  const [otherStatus] = await redeem(
    request({ url: '/api/auth/other', body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(queryStatus, 404);
  assert.equal(otherStatus, 404);
  assert.equal(calls.length, 0);
});

test('rejects non-form content types', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({
      contentType: 'application/json',
      body: JSON.stringify(AUTHORIZATION_CODE_BODY),
    }),
  );

  assert.equal(status, 415);
  assert.deepEqual(body, { error: 'unsupported_media_type' });
  assert.equal(calls.length, 0);
});

test('rejects oversized declared request bodies before reading', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher)(
    request({
      body: form(AUTHORIZATION_CODE_BODY),
      headers: { 'content-length': '999999' },
    }),
  );

  assert.equal(status, 413);
  assert.deepEqual(body, { error: 'payload_too_large' });
  assert.equal(calls.length, 0);
});

test('rejects oversized streamed request bodies', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({}));
  const [status, body] = await makeRedeem(fetcher, { maxBodyBytes: 16 })(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 413);
  assert.deepEqual(body, { error: 'payload_too_large' });
  assert.equal(calls.length, 0);
});

test('maps upstream redirects to a generic upstream error without leaking Location', async () => {
  const { fetcher } = captureFetcher(() => new Response('', {
    status: 302,
    headers: { location: 'https://evil.example.test/token' },
  }));

  const [status, body, headers] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 502);
  assert.deepEqual(body, { error: 'upstream_error' });
  assert.equal(JSON.stringify(body).includes('evil.example.test'), false);
  assert.equal(headers.location, undefined);
});

test('treats a fetcher redirect rejection as upstream unavailable', async () => {
  const fetcher = async () => {
    throw new TypeError('unexpected redirect');
  };

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 502);
  assert.deepEqual(body, { error: 'upstream_unavailable' });
});

test('treats malformed upstream JSON as a generic upstream error', async () => {
  const { fetcher } = captureFetcher(() => new Response('{not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 502);
  assert.deepEqual(body, { error: 'upstream_error' });
});

test('treats upstream token payloads without an access token as invalid', async () => {
  const { fetcher } = captureFetcher(() => tokenResponse({
    token_type: 'Bearer',
    access_token: '',
  }));

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 502);
  assert.deepEqual(body, { error: 'upstream_error' });
});

test('accepts a loopback HTTP issuer for local development', async () => {
  const { fetcher, calls } = captureFetcher(() => tokenResponse({
    access_token: 'access-loopback',
    token_type: 'Bearer',
  }));

  const redeem = makeRedeem(fetcher, {
    issuer: 'http://127.0.0.1:8080/realms/development',
  });

  const [status] = await redeem(request({ body: form(AUTHORIZATION_CODE_BODY) }));

  assert.equal(status, 200);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/realms/development/protocol/openid-connect/token');
});

test('rejects plain HTTP issuers outside loopback', () => {
  assert.throws(
    () => makeRedeem(async () => tokenResponse({}), {
      issuer: 'http://auth.example.test/realms/junctura',
    }),
    /HTTPS or loopback HTTP/,
  );
});

test('rejects hostnames that merely start with the loopback prefix', () => {
  for (const issuer of [
    'http://127.evil.example.test/realms/junctura',
    'http://127.0.0.1.evil.example.test/realms/junctura',
  ]) {
    assert.throws(
      () => makeRedeem(async () => tokenResponse({}), { issuer }),
      /HTTPS or loopback HTTP/,
      issuer,
    );
  }
});

test('rejects a redirect URI on a different origin', () => {
  assert.throws(
    () => makeRedeem(async () => tokenResponse({}), {
      redirectUri: 'https://evil.example.test/auth/callback',
    }),
    /same origin/,
  );
});

test('rejects a redirect URI with a query or fragment', () => {
  for (const redirectUri of [`${REDIRECT_URI}?next=1`, `${REDIRECT_URI}#fragment`]) {
    assert.throws(
      () => makeRedeem(async () => tokenResponse({}), { redirectUri }),
      /query or fragment/,
      redirectUri,
    );
  }
});

test('returns access expiry and a valid Bearer token type without refresh fields', async () => {
  const { fetcher } = captureFetcher(() => tokenResponse({
    access_token: 'access-4',
    token_type: 'bearer',
    expires_in: 300,
    refresh_token: 'refresh-4',
    refresh_expires_in: 1800,
  }));

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 200);
  assert.deepEqual(body, {
    access_token: 'access-4',
    token_type: 'Bearer',
    expires_in: 300,
  });
});

test('rejects upstream token types that are not Bearer', async () => {
  const { fetcher } = captureFetcher(() => tokenResponse({
    access_token: 'access-5',
    token_type: 'DPoP',
  }));

  const [status, body] = await makeRedeem(fetcher)(
    request({ body: form(AUTHORIZATION_CODE_BODY) }),
  );

  assert.equal(status, 502);
  assert.deepEqual(body, { error: 'upstream_error' });
});
