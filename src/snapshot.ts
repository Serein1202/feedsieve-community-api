// 社区名单快照：纯静态产物，直接从 R2 读取，不依赖 D1 / 定时生成。
// R2 布局（bucket 内）：
//   snapshots/latest.json              -> manifest（含 files[].sha256）
//   snapshots/{version}/official.json -> 机器可读名单
//   snapshots/{version}/blocklist.yaml -> 人类可读黑名单
// 上传由 scripts/publish.sh 完成；本文件只负责按路径取回内容。

export const SNAPSHOT_PACK = 'official.json';
export const PUBLIC_BLOCKLIST_PACK = 'blocklist.yaml';

const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/;

export async function getLatestSnapshot(
  env: Cloudflare.Env,
): Promise<{ manifest: string } | null> {
  const object = await env.DATA.get('snapshots/latest.json');
  if (!object) return null;
  return { manifest: await object.text() };
}

export async function getSnapshotFile(
  env: Cloudflare.Env,
  version: string,
  path: string,
): Promise<string | null> {
  if (!VERSION_RE.test(version)) return null;
  if (path !== SNAPSHOT_PACK && path !== PUBLIC_BLOCKLIST_PACK) return null;
  const object = await env.DATA.get(`snapshots/${version}/${path}`);
  return object ? await object.text() : null;
}

export async function getLatestSnapshotFile(
  env: Cloudflare.Env,
  pack: typeof SNAPSHOT_PACK | typeof PUBLIC_BLOCKLIST_PACK,
): Promise<string | null> {
  const latest = await getLatestSnapshot(env);
  if (!latest) return null;
  let manifest: { snapshot_version?: string };
  try {
    manifest = JSON.parse(latest.manifest) as { snapshot_version?: string };
  } catch {
    return null;
  }
  const version = manifest.snapshot_version;
  if (typeof version !== 'string') return null;
  return getSnapshotFile(env, version, pack);
}
