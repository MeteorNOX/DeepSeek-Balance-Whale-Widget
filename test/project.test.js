import { describe, it, expect } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('项目元数据', () => {
  it('package.json 存在且为 DSH bundle 插件', async () => {
    const raw = await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    expect(pkg.name).toBe('dsh-whale-widget')
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('cordis.patch.yml 存在并声明插件挂载', async () => {
    const raw = await readFile(path.join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
    expect(raw).toContain('- insert:')
    expect(raw).toContain('id: dsh-whale-widget')
    expect(raw).toContain('name: dsh-whale-widget')
  })

  it('README.md 存在并指向安装说明', async () => {
    const raw = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8')
    expect(raw.length).toBeGreaterThan(100)
    expect(raw).toMatch(/安装|Install/i)
  })

  it('lib/index.js 存在且为 ESM', async () => {
    const st = await stat(path.join(REPO_ROOT, 'lib/index.js'))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBeGreaterThan(1024)
  })
})
