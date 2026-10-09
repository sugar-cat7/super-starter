import { expect, it } from 'vitest';
import { compressAsset } from '../src/assets.ts';

it('compresses actual public bytes once and preserves cache metadata with negotiated variants', async () => {
  const text = 'body { color: black; }'.repeat(100);
  const response = compressAsset(
    new Request('https://example.test/assets/styles.css', {
      headers: { 'accept-encoding': 'br, gzip;q=0.8' },
    }),
    new Response(text, {
      headers: {
        'content-type': 'text/css',
        'content-length': String(text.length),
        'cache-control': 'public, max-age=3600',
        etag: '"asset-version"',
        vary: 'Origin',
      },
    }),
  );
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.has('content-length')).toBe(false);
  expect(response.headers.get('etag')).toBe('W/"asset-version"');
  expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  const compressed = await response.arrayBuffer();
  expect(compressed.byteLength).toBeLessThan(text.length);
  expect(
    await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text(),
  ).toBe(text);
});

it('honors identity, gzip refusal, HEAD, ranges, no-transform and existing encoding', async () => {
  for (const accept of ['', 'br', 'gzip;q=0', 'gzip;q=invalid']) {
    const response = compressAsset(
      new Request('https://example.test/assets/x.js', { headers: { 'accept-encoding': accept } }),
      new Response('original', { headers: { 'content-type': 'text/javascript' } }),
    );
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe('original');
  }
  for (const [method, headers, responseHeaders] of [
    ['HEAD', {}, {}],
    ['GET', { range: 'bytes=0-1' }, {}],
    ['GET', {}, { 'cache-control': 'public, no-transform' }],
    ['GET', {}, { 'content-encoding': 'br' }],
  ] as const) {
    const original = new Response('original', {
      headers: { 'content-type': 'text/css', ...responseHeaders },
    });
    expect(
      compressAsset(
        new Request('https://example.test/assets/x.css', {
          method,
          headers: { 'accept-encoding': 'gzip', ...headers },
        }),
        original,
      ),
    ).toBe(original);
  }
});
