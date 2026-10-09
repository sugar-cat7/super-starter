import start from '@tanstack/react-start/server-entry';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') return Response.json({ ok: true, storage: 'service-binding' });
    if (pathname.startsWith('/api/') || pathname.startsWith('/extensions/')) {
      if (request.method !== 'GET' && env.WRITE_MODE !== 'allow')
        return Response.json(
          {
            error: { code: 'writes_disabled', message: 'Writes are disabled in this environment.' },
            requestId: crypto.randomUUID(),
          },
          { status: 403 },
        );
      return env.API.fetch(request);
    }
    return start.fetch(request);
  },
} satisfies ExportedHandler<Env>;
