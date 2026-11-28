// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { isIP } from 'node:net';

const TOKEN_PATH = '/protocol/openid-connect/token';
const REQUEST_PATH = '/api/auth/token';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const AUTH_CODE_FIELDS = new Set(['grant_type', 'code', 'code_verifier', 'redirect_uri', 'client_id']);
const REFRESH_FIELDS = new Set(['grant_type', 'refresh_token', 'client_id']);
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

function json(status, body, headers) {
  return [
    status,
    body,
    {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  ];
}

function fail(status, error, headers) {
  return json(status, { error }, headers);
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal) === 6) return literal === '::1';
  return isIP(literal) === 4 && literal.startsWith('127.');
}

function parseHttpUrl(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty URL`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a valid URL`);
  }

  if (url.username || url.password) {
    throw new TypeError(`${name} must not contain credentials`);
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new TypeError(`${name} must use HTTPS or loopback HTTP`);
  }

  return url;
}

function mediaType(value) {
  if (typeof value !== 'string') return '';
  const separator = value.indexOf(';');
  return (separator === -1 ? value : value.slice(0, separator)).trim().toLowerCase();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function readBoundedBody(req, maxBytes) {
  if (typeof req[Symbol.asyncIterator] !== 'function') {
    throw Object.assign(new Error('invalid_body'), { code: 'INVALID_BODY' });
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    if (chunk === undefined || chunk === null) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw Object.assign(new Error('body_too_large'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readBoundedResponse(res, maxBytes) {
  if (res && res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;

    for await (const chunk of res.body) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        throw Object.assign(new Error('response_too_large'), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  if (res && typeof res.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw Object.assign(new Error('response_too_large'), { code: 'RESPONSE_TOO_LARGE' });
    }
    return text;
  }

  return '';
}

function mapTokenResponse(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const { access_token, token_type, expires_in, refresh_expires_in, refresh_token, id_token, scope } = value;

  if (!isNonEmptyString(access_token) || !isNonEmptyString(token_type) || token_type.toLowerCase() !== 'bearer') {
    return null;
  }

  const tokens = {
    access_token,
    token_type: 'Bearer',
  };

  const seconds = raw => {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
    return undefined;
  };

  const expiresIn = seconds(expires_in);
  if (expiresIn !== undefined) tokens.expires_in = expiresIn;

  const refreshExpiresIn = seconds(refresh_expires_in);
  if (refreshExpiresIn !== undefined) tokens.refresh_expires_in = refreshExpiresIn;

  if (isNonEmptyString(refresh_token)) tokens.refresh_token = refresh_token;
  if (isNonEmptyString(id_token)) tokens.id_token = id_token;
  if (isNonEmptyString(scope)) tokens.scope = scope;

  return tokens;
}

export function createTokenRedemption(config = {}) {
  const { origin, redirectUri, issuer } = config;
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  const fetcher = config.fetcher ?? globalThis.fetch;

  const issuerUrl = parseHttpUrl(issuer, 'issuer');
  if (issuerUrl.search || issuerUrl.hash) {
    throw new TypeError('issuer must not contain a query or fragment');
  }

  const originUrl = parseHttpUrl(origin, 'origin');
  if (originUrl.origin !== origin) {
    throw new TypeError('origin must be an exact origin');
  }

  const redirectUrl = parseHttpUrl(redirectUri, 'redirectUri');
  if (redirectUrl.origin !== originUrl.origin) {
    throw new TypeError('redirectUri must have the same origin as origin');
  }
  if (redirectUrl.search || redirectUrl.hash) {
    throw new TypeError('redirectUri must not contain a query or fragment');
  }

  if (!isNonEmptyString(clientId)) throw new TypeError('clientId must be a non-empty string');
  if (!isNonEmptyString(clientSecret)) throw new TypeError('clientSecret must be a non-empty string');
  if (typeof fetcher !== 'function') throw new TypeError('fetcher must be a function');

  const timeoutMs = config.timeoutMs ?? 5000;
  const maxBodyBytes = config.maxBodyBytes ?? 8192;
  const maxResponseBytes = config.maxResponseBytes ?? 65536;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 30000');
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536) {
    throw new TypeError('maxBodyBytes must be an integer between 1 and 65536');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1048576) {
    throw new TypeError('maxResponseBytes must be an integer between 1 and 1048576');
  }

  const issuerBase = issuerUrl.href.replace(/\/+$/, '');
  const endpoint = `${issuerBase}${TOKEN_PATH}`;
  const basicAuth = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    'utf8',
  ).toString('base64');

  return async function redeemToken(req) {
    if (!req || req.url !== REQUEST_PATH) {
      return fail(404, 'not_found');
    }

    if (req.method !== 'POST') {
      return fail(405, 'method_not_allowed', { allow: 'POST' });
    }

    const headers = req.headers ?? {};

    if (headers.origin !== origin) {
      return fail(403, 'forbidden');
    }

    if (mediaType(headers['content-type']) !== FORM_TYPE) {
      return fail(415, 'unsupported_media_type');
    }

    const declaredLength = headers['content-length'];
    if (declaredLength !== undefined) {
      if (Array.isArray(declaredLength) || !/^\d+$/.test(String(declaredLength))) {
        return fail(400, 'invalid_request');
      }
      if (Number(declaredLength) > maxBodyBytes) {
        return fail(413, 'payload_too_large');
      }
    }

    let raw;
    try {
      raw = await readBoundedBody(req, maxBodyBytes);
    } catch (error) {
      if (error && error.code === 'BODY_TOO_LARGE') {
        return fail(413, 'payload_too_large');
      }
      return fail(400, 'invalid_request');
    }

    const params = new URLSearchParams(raw);
    const fields = new Map();

    for (const [key, value] of params) {
      if (key.length === 0 || fields.has(key)) {
        return fail(400, 'invalid_request');
      }
      fields.set(key, value);
    }

    const grantType = fields.get('grant_type');
    if (!isNonEmptyString(grantType)) {
      return fail(400, 'invalid_request');
    }

    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return fail(400, 'unsupported_grant_type');
    }

    const allowed = grantType === 'authorization_code' ? AUTH_CODE_FIELDS : REFRESH_FIELDS;
    for (const key of fields.keys()) {
      if (!allowed.has(key)) {
        return fail(400, 'invalid_request');
      }
    }

    if (fields.has('client_id') && fields.get('client_id') !== clientId) {
      return fail(400, 'invalid_client');
    }

    const upstream = new URLSearchParams();
    upstream.set('grant_type', grantType);

    if (grantType === 'authorization_code') {
      const code = fields.get('code');
      const verifier = fields.get('code_verifier');
      const redirectValue = fields.get('redirect_uri');

      if (!isNonEmptyString(code) || !isNonEmptyString(verifier) || !isNonEmptyString(redirectValue)) {
        return fail(400, 'invalid_request');
      }
      if (code.length > 4096 || !PKCE_VERIFIER.test(verifier) || redirectValue !== redirectUri) {
        return fail(400, 'invalid_request');
      }

      upstream.set('code', code);
      upstream.set('code_verifier', verifier);
      upstream.set('redirect_uri', redirectValue);
    } else {
      const refreshToken = fields.get('refresh_token');
      if (!isNonEmptyString(refreshToken) || refreshToken.length > 8192) {
        return fail(400, 'invalid_request');
      }

      upstream.set('refresh_token', refreshToken);
    }

    let res;
    try {
      res = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          'content-type': FORM_TYPE,
          accept: 'application/json',
          authorization: `Basic ${basicAuth}`,
        },
        body: upstream.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail(502, 'upstream_unavailable');
    }

    if (!res || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) {
      return fail(502, 'upstream_error');
    }

    let text;
    try {
      text = await readBoundedResponse(res, maxResponseBytes);
    } catch {
      return fail(502, 'upstream_error');
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return fail(502, 'upstream_error');
    }

    const tokens = mapTokenResponse(payload);
    if (tokens === null) {
      return fail(502, 'upstream_error');
    }

    return json(200, tokens);
  };
}
