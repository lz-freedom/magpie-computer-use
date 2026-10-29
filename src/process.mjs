import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 256 * 1024;

/** 运行外部命令并收集输出；非零退出或超时都以错误返回，并附带 stderr 尾部便于诊断。 */
export function run(command, args = [], { cwd, env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve({ code, stdout, stderr });
      const detail = (stderr || stdout).slice(-4000);
      const reason = timedOut ? `${command} 超时。` : `${command} 退出：${code ?? signal}`;
      reject(Object.assign(new Error(detail ? `${reason}\n${detail}` : reason), { code, stdout, stderr }));
    });
  });
}
