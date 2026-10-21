// -----------------------------------------------------------------------------
// The only place that talks to the network: one HTTP request to a speaker on
// the LAN, with a deadline covering the whole exchange (connection, headers
// and body), a size cap, no redirect, no keep-alive and no User-Agent of any
// application. The tests inject another transport, or run a fake speaker on
// the loopback interface.
//
// Resolves { status, text } for a 2xx answer; throws a KefError otherwise.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { LIMITS, TIMINGS } from '../constants.js';

export class KefError extends Error {
  /**
   * `code`: timeout, network, refused, http, too_large, redirect, bad_answer,
   * aborted. `maybeSent`: the request may have reached the speaker (it may
   * have acted on it). `unreachable`: nothing answered at all.
   */
  constructor(code, message, { status, maybeSent = false } = {}) {
    super(message);
    this.name = 'KefError';
    this.code = code;
    this.status = status;
    this.maybeSent = maybeSent;
    this.unreachable = code === 'timeout' || code === 'network' || code === 'refused';
  }
}

/**
 * `host`, `port`, `path` (with its query string). `body` (a string) makes it
 * a POST of JSON. `signal` cancels it (KefError 'aborted').
 */
export function httpRequest({
  host,
  port = 80,
  path,
  body,
  timeout = TIMINGS.requestTimeout,
  maxBytes = LIMITS.answerBytes,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let request;
    let timer;
    const onAbort = () => fail(new KefError('aborted', 'cancelled', { maybeSent: written }));
    const done = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (!settled) {
        done();
        request?.destroy();
        reject(err);
      }
    };
    const networkError = (err) =>
      err?.code === 'ECONNREFUSED'
        ? new KefError('refused', 'connection refused')
        : new KefError('network', err?.code ? `network error (${err.code})` : 'network error', {
            // A reset after the request left: the speaker may have acted on it.
            maybeSent: written,
          });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () =>
        fail(
          new KefError('timeout', `no answer within ${(timeout / 1000).toFixed(1)} s`, {
            maybeSent: written,
          }),
        ),
      Math.max(1, timeout),
    );
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    try {
      request = http.request({
        hostname: host,
        port,
        path,
        method: payload ? 'POST' : 'GET',
        agent: false,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      });
    } catch (err) {
      fail(new KefError('network', `invalid request (${err.code ?? 'error'})`));
      return;
    }
    request.on('response', (response) => {
      // An answer arrived: the request reached the speaker, which may have
      // acted on it whatever comes next (`maybeSent`).
      const status = response.statusCode ?? 0;
      const tooLarge = () =>
        new KefError('too_large', `answer over ${Math.round(maxBytes / 1024)} KB`, {
          status,
          maybeSent: true,
        });
      if (status >= 300 && status < 400) {
        response.resume();
        fail(
          new KefError('redirect', `HTTP ${status} redirect refused`, { status, maybeSent: true }),
        );
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        fail(new KefError('http', `HTTP ${status}`, { status, maybeSent: true }));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        fail(tooLarge());
        return;
      }
      // The pieces are kept as they come and joined once at the end: linear.
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (!settled) {
          done();
          resolve({ status, text: Buffer.concat(chunks, total).toString('utf8') });
        }
      });
      response.on('error', (err) => fail(networkError(err)));
      response.on('close', () => {
        if (!response.complete) {
          fail(new KefError('network', 'connection closed', { maybeSent: true }));
        }
      });
    });
    request.on('error', (err) => fail(networkError(err)));
    request.end(payload, () => {
      written = true;
    });
  });
}
