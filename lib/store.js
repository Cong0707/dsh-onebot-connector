/**
 * 状态存储 —— 只存 OneBot 连接信息，**不存任何 QQ 账号密码**。
 *
 * 位置：~/.dsh/plugins-data/onebot-connector/state.json（0600）
 * 不放进插件包目录，不进 git。
 */
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function dataDir() {
  return join(homedir(), '.dsh', 'plugins-data', 'onebot-connector');
}
export function stateFile() {
  return join(dataDir(), 'state.json');
}

async function ensureDir() {
  const d = dataDir();
  if (!existsSync(d)) await mkdir(d, { recursive: true, mode: 0o700 });
  try { await chmod(d, 0o700); } catch { /* Windows */ }
  return d;
}

export async function readState() {
  try {
    const raw = await readFile(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

const ALLOWED = new Set(['baseUrl', 'accessToken', 'passiveGroups', 'targetSession']);

export async function writeState(patch) {
  await ensureDir();
  const current = await readState();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!ALLOWED.has(k)) continue;
    if (v === null || v === undefined || v === '') delete next[k];
    else next[k] = v;
  }
  const tmp = stateFile() + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { await chmod(tmp, 0o600); } catch { /* ignore */ }
  await rename(tmp, stateFile());
  try { await chmod(stateFile(), 0o600); } catch { /* ignore */ }
  return next;
}

/** token 不回显，只告诉有没有。 */
export function publicState(s) {
  const st = s || {};
  return {
    baseUrl: st.baseUrl || '',
    hasToken: Boolean(st.accessToken),
    passiveGroups: st.passiveGroups || '',
    targetSession: st.targetSession || '',
  };
}
