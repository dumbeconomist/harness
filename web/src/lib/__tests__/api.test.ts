import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../api';

const cfg = { baseUrl: 'http://x:1', token: 'tok' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  it('sends bearer auth and query params', async () => {
    const f = vi.fn().mockResolvedValue(json([]));
    await createApi(cfg, f).listTasks('doing');
    expect(f).toHaveBeenCalledWith(
      'http://x:1/api/tasks?status=doing',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });

  it('posts JSON bodies', async () => {
    const f = vi.fn().mockResolvedValue(json({ id: '1' }));
    await createApi(cfg, f).createTask({ title: 'milk' });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"milk"}');
  });

  it('health does not send auth', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, version: '1', hermes: { reachable: false } }));
    await createApi(cfg, f).health();
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it('maps error envelopes to ApiError', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { code: 'conflict', message: 'already undone' } }, 409));
    await expect(createApi(cfg, f).undo('j1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'conflict',
      message: 'already undone',
    });
  });

  it('wraps network failures', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const err = await createApi(cfg, f).listTasks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });

  it('handles 204 and encodes ids; decision includes note only when given', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockImplementation(async () => json({}));
    const api = createApi(cfg, f);
    await expect(api.deleteTask('a/b')).resolves.toBeUndefined();
    expect(f.mock.calls[0]![0]).toBe('http://x:1/api/tasks/a%2Fb');
    await api.decide('9', 'deny');
    expect((f.mock.calls[1]![1] as RequestInit).body).toBe('{"decision":"deny"}');
    await api.decide('9', 'approve', 'ok');
    expect((f.mock.calls[2]![1] as RequestInit).body).toBe('{"decision":"approve","note":"ok"}');
  });
});
