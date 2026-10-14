// 테스트용 서버 두 개를 띄운다 (운영 DB 없이):
//   가짜 Supabase REST (supabase/tests/fake_postgrest.mjs: PGlite 에 실제 SQL 001~007 적용) + WONY RHYTHM 서버(FastAPI)
// 로그인 필수 정책이라 브라우저 테스트도 WONY PHONE 과 같은 방식의 1회용 입장권으로 로그인해서 쓴다.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PYTHON = process.env.PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe');

function start(cmd, args, opts, readyText) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const onData = d => {
      log += d;
      if (log.includes(readyText)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(new Error(`${cmd} exited ${code}\n${log}`)));
    setTimeout(() => reject(new Error(`${cmd} not ready\n${log}`)), 60000);
  });
}

/**
 * @param {{appPort: number, pgPort: number, members: Array<{id, nickname, isPublic?}>, phoneUrl?: string}} opts
 * @returns {Promise<{BASE, PHONE_URL, ticket(member): string, dbState(): Promise<object>, setDbFailing(on): Promise, stop(): void}>}
 */
export async function startServers({ appPort, pgPort, members, phoneUrl = 'https://phone.example/phone' }) {
  const link = 'test-link-' + randomBytes(24).toString('hex');
  const dbSecret = 'test-db-' + randomBytes(24).toString('hex');
  const pg = await start('node', ['fake_postgrest.mjs', '--port', String(pgPort), '--secret', dbSecret, '--members', JSON.stringify(members)],
    { cwd: path.join(ROOT, 'supabase', 'tests') }, 'fake postgrest ready');
  const app = await start(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', String(appPort)], {
    cwd: ROOT,
    env: { ...process.env, RHYTHM_LINK_SECRET: link, RHYTHM_DB_SECRET: dbSecret, SUPABASE_URL: `http://127.0.0.1:${pgPort}`,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', WONY_PHONE_URL: phoneUrl, WONY_AUTH_SECRET: '' },
  }, 'Application startup complete');
  const pgBase = `http://127.0.0.1:${pgPort}`;
  return {
    BASE: `http://127.0.0.1:${appPort}`,
    PHONE_URL: phoneUrl,
    /** WONY PHONE server/rhythmLink.ts 와 같은 방식으로 서명한 60초 1회용 입장권 */
    ticket(member) {
      const payload = { sub: member.id, role: 'user', name: member.nickname, aud: 'wony-rhythm', exp: Math.floor(Date.now() / 1000) + 60, nonce: randomBytes(16).toString('hex') };
      const body = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      return `${body}.${createHmac('sha256', link).update(body).digest('base64url')}`;
    },
    dbState: async () => (await fetch(`${pgBase}/_test/state`)).json(),
    setDbFailing: on => fetch(`${pgBase}/_test/fail`, { method: 'POST', body: JSON.stringify({ on }) }),
    stop() {
      app.kill();
      pg.kill();
    },
  };
}
