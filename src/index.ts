import { cors } from 'hono/cors';
import { Hono } from 'hono';
import {
  getLatestSnapshot,
  getLatestSnapshotFile,
  getSnapshotFile,
  PUBLIC_BLOCKLIST_PACK,
  SNAPSHOT_PACK,
} from './snapshot';

// 自托管精简版：只保留「读」端点（名单快照 + 关键词词库）。
// 移除了管理员后台、举报/抢救/贡献统计、D1 与定时快照生成 —— 单人使用不需要。
export function createApp() {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.use('*', cors());

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'feedsieve-community-api',
      time: new Date().toISOString(),
    }),
  );

  // 公开政策：阈值不藏在后端黑箱里
  app.get('/v1/policy', (c) =>
    c.json({
      formula: 'block_votes - false_positive_votes',
      min_net_votes: 3,
      daily_report_limit: 50,
    }),
  );

  // 快照消费端点：manifest 短缓存，版本化文件按不可变缓存
  app.get('/v1/snapshots/latest', async (c) => {
    const latest = await getLatestSnapshot(c.env);
    if (!latest) return c.json({ error: 'no_snapshot' }, 404);
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(latest.manifest, 200, { 'content-type': 'application/json' });
  });

  app.get('/v1/snapshots/:version/:path', async (c) => {
    const path = c.req.param('path');
    const body = await getSnapshotFile(c.env, c.req.param('version'), path);
    if (!body) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(body, 200, {
      'content-type':
        path === PUBLIC_BLOCKLIST_PACK ? 'text/yaml; charset=utf-8' : 'application/json',
    });
  });

  app.get('/v1/blocklist/latest.yaml', async (c) => {
    const body = await getLatestSnapshotFile(c.env, PUBLIC_BLOCKLIST_PACK);
    if (!body) return c.json({ error: 'no_snapshot' }, 404);
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(body, 200, { 'content-type': 'text/yaml; charset=utf-8' });
  });

  app.get('/v1/blocklist/latest.json', async (c) => {
    const body = await getLatestSnapshotFile(c.env, SNAPSHOT_PACK);
    if (!body) return c.json({ error: 'no_snapshot' }, 404);
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(body, 200, { 'content-type': 'application/json' });
  });

  // 关键词包：同样从 R2 读取（key: keyword-packs/latest.json 与 keyword-packs/{version}/official.json）
  app.get('/v1/keyword-packs/latest', async (c) => {
    const object = await c.env.DATA.get('keyword-packs/latest.json');
    if (!object) return c.json({ error: 'keyword_packs_unavailable' }, 503);
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(await object.text(), 200, { 'content-type': 'application/json' });
  });

  app.get('/v1/keyword-packs/:version/:path', async (c) => {
    const version = c.req.param('version');
    const path = c.req.param('path');
    if (!/^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(version) || path !== 'official.json') {
      return c.json({ error: 'not_found' }, 404);
    }
    const object = await c.env.DATA.get(`keyword-packs/${version}/${path}`);
    if (!object) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(await object.text(), 200, { 'content-type': 'application/json' });
  });

  app.get('*', (c) => c.json({ error: 'not_found' }, 404));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((error, c) => {
    console.error('[community-api]', error);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

export default {
  fetch(request, env) {
    return createApp().fetch(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
