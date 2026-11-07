import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const ROLE_LINES_MAX_BYTES = 1024 * 1024
const ROLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])

export class RoleLinesError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

export function emptyRoleLines() {
  return { version: 1, enabled: false, updatedAt: 0, roles: {} }
}

function dictionary(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// Keep all role/line JSON metadata. Only the structural fields and usable text
// are prescribed here; importers can retain persona, references and provenance.
export function validateRoleLines(input, roleIds) {
  if (!dictionary(input) || input.version !== 1 || typeof input.enabled !== 'boolean'
      || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0 || !dictionary(input.roles)) {
    throw new RoleLinesError('invalid role lines config')
  }
  const entries = Object.entries(input.roles)
  if (entries.length > 200) throw new RoleLinesError('too many roles (maximum 200)')
  const roles = Object.create(null)
  for (const [id, role] of entries) {
    if (!ROLE_ID_RE.test(id) || RESERVED_IDS.has(id)) throw new RoleLinesError('invalid role id')
    if (roleIds && id !== 'default' && !roleIds.has(id)) throw new RoleLinesError('role not found: ' + id)
    if (!dictionary(role) || !Array.isArray(role.lines) || role.lines.length > 500) {
      throw new RoleLinesError('invalid lines for role: ' + id + ' (maximum 500)')
    }
    for (const line of role.lines) {
      if (!dictionary(line) || typeof line.text !== 'string' || !line.text.trim()
          || Array.from(line.text).length > 200) {
        throw new RoleLinesError('invalid line text for role: ' + id + ' (1–200 Unicode characters)')
      }
    }
    roles[id] = role
  }
  const config = { version: 1, enabled: input.enabled, updatedAt: input.updatedAt, roles }
  let body
  try { body = JSON.stringify(config) } catch (err) { throw new RoleLinesError('invalid JSON metadata') }
  if (Buffer.byteLength(body, 'utf8') > ROLE_LINES_MAX_BYTES) {
    throw new RoleLinesError('role lines file too large (maximum 1 MiB)', 413)
  }
  return JSON.parse(body)
}

export function readRoleLinesBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      chunks = []
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > ROLE_LINES_MAX_BYTES) {
        // Drain the request so the caller can still return a useful 413.
        fail(new RoleLinesError('role lines request too large (maximum 1 MiB)', 413))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new RoleLinesError('request aborted')))
  })
}

export function createRoleLinesStore(file, roleIds) {
  function read({ strict = false } = {}) {
    try {
      if (fs.statSync(file).size > ROLE_LINES_MAX_BYTES) throw new RoleLinesError('role lines file too large', 413)
      return validateRoleLines(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) {
      if (strict && err.code !== 'ENOENT') throw err
      return emptyRoleLines()
    }
  }

  function write(input, { validateRoleIds = true, touch = true } = {}) {
    const config = validateRoleLines(input, validateRoleIds && roleIds ? roleIds() : undefined)
    if (touch) config.updatedAt = Date.now()
    const body = JSON.stringify(config)
    if (Buffer.byteLength(body, 'utf8') > ROLE_LINES_MAX_BYTES) {
      throw new RoleLinesError('role lines file too large (maximum 1 MiB)', 413)
    }
    const temporary = file + '.' + randomUUID() + '.tmp'
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      try { fs.unlinkSync(temporary) } catch (err) {}
    }
    return config
  }

  function removeRole(id) {
    // A malformed/unreadable file must prevent deletion, never silently replace
    // the user's other role pools with a default empty document.
    const previous = read({ strict: true })
    if (!Object.hasOwn(previous.roles, id)) return null
    const next = { ...previous, roles: { ...previous.roles } }
    delete next.roles[id]
    write(next, { validateRoleIds: false })
    return previous
  }

  return { read, write, removeRole }
}
