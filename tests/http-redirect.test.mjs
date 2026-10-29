import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, probe } from '../core/http.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('cross-origin redirects do not forward Referer or credentials', async t => {
  let received;
  const target = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { 'content-length': '2' });
    res.end('ok');
  });
  const targetPort = await listen(target);
  t.after(() => close(target));

  const source = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/destination` });
    res.end();
  });
  const sourcePort = await listen(source);
  t.after(() => close(source));

  const response = await request(`http://127.0.0.1:${sourcePort}/start`, {
    headers: {
      referer: 'https://private.example/account?session=do-not-forward',
      cookie: 'session=do-not-forward',
      authorization: 'Bearer do-not-forward',
      origin: 'https://private.example',
      'user-agent': 'AwesomeDownloader/test'
    }
  });
  response.resume();

  assert.equal(response.statusCode, 200);
  assert.ok(received, 'redirect target should receive the request');
  assert.equal(received.referer, undefined);
  assert.equal(received.cookie, undefined);
  assert.equal(received.authorization, undefined);
  assert.equal(received.origin, undefined);
  assert.equal(received['user-agent'], 'AwesomeDownloader/test');
});

test('303 redirect switches non-HEAD method to GET while preserving HEAD', async t => {
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    if (req.url === '/redirect') {
      res.writeHead(303, { location: '/final' });
      return res.end();
    }
    res.writeHead(200, { 'content-length': '2' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
  });
  const port = await listen(server);
  t.after(() => close(server));

  const postRes = await request(`http://127.0.0.1:${port}/redirect`, { method: 'POST' });
  postRes.resume();
  const headRes = await request(`http://127.0.0.1:${port}/redirect`, { method: 'HEAD' });
  headRes.resume();

  assert.deepEqual(methods, ['POST /redirect', 'GET /final', 'HEAD /redirect', 'HEAD /final']);
});

test('response stream times out when server stalls mid-body after headers', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': '100' });
    res.write('partial');
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); return close(server); });

  const response = await request(`http://127.0.0.1:${port}/stall`, { timeoutMs: 80 });
  await assert.rejects(
    async () => { for await (const _chunk of response) { /* consume */ } },
    /Connection timed out\./
  );
});

test('probe treats unknown total length in Content-Range (bytes 0-0/*) as null rather than 1', async t => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    res.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/*', 'content-length': '1' });
    res.end('x');
  });
  const port = await listen(server);
  t.after(() => close(server));

  const info = await probe(`http://127.0.0.1:${port}/stream.bin`, {}, new AbortController().signal);
  assert.equal(info.total, null);
  assert.equal(info.ranges, true);
});
