// 清理构建产物目录（含可能因递归事故产生的超长路径）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const targets = ['out', 'staging'].map((d) => path.join(HERE, d))

for (const t of targets) {
  if (!fs.existsSync(t)) { console.log(`跳过（不存在）${t}`); continue }
  try {
    fs.rmSync(t, { recursive: true, force: true, maxRetries: 3 })
    console.log(`已删除 ${t}`)
  } catch (e) {
    console.log(`Node 删除失败（${e.code}），改用系统命令：${t}`)
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'rd', '/s', '/q', t], { stdio: 'pipe', encoding: 'utf8' })
      : spawnSync('rm', ['-rf', t], { stdio: 'pipe', encoding: 'utf8' })
    console.log(fs.existsSync(t) ? `仍然失败：${r.stderr || r.stdout}` : `已删除 ${t}`)
  }
}
