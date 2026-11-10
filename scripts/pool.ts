import { spawn } from 'child_process';
import { cpus } from 'os';
const LIMIT = Math.max(1, Math.min(8, cpus().length));
let running = 0; const q: (() => void)[] = [];
const cache = new Map<string, Promise<any>>();
/** run scripts/run1.ts in a child process (bounded parallelism, memoised by arguments) */
export function run1(args: any): Promise<any> {
  const key = JSON.stringify(args);
  if (cache.has(key)) return cache.get(key)!;
  const p = new Promise<any>((res, rej) => {
    const go = () => {
      running++;
      const ch = spawn('node', ['--import', 'tsx', 'scripts/run1.ts', key], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; ch.stdout.on('data', d => out += d);
      ch.on('close', code => { running--; q.shift()?.(); if (code) rej(new Error('run1 failed ' + key)); else res(JSON.parse(out)); });
    };
    if (running < LIMIT) go(); else q.push(go);
  });
  cache.set(key, p); return p;
}
