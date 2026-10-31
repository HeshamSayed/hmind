// Auto-verify: when a turn claims completion without running anything, run the
// project's own test or build command and put the result in front of the model.
// Opt-in per project (`/hmind verify on`) or globally (`autoVerify`).
// Works on macOS, Linux and Windows: paths follow the project root's separator
// and commands are spelled for the platform.

import type { EngineInterface } from 'claude-code'

import { isWindowsPath, joinPath, pythonFor, wrapperFor } from './platform'

const PLACEHOLDER = /no test specified/i

/** The three file-system reads detection needs; the engine's `$.fs` in a session, a fake in tests. */
export type VerifyFs = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<readonly { name: string }[]>
}

async function has(fs: VerifyFs, root: string, name: string): Promise<boolean> {
  return fs.exists(joinPath(root, name)).catch(() => false)
}

async function anyNamed(fs: VerifyFs, root: string, test: (name: string) => boolean): Promise<boolean> {
  const entries = await fs.list(root).catch(() => [])
  return entries.some(e => test(e.name))
}

/** The command that verifies this project, from its manifests; undefined when none is recognised. */
export async function detectWith(fs: VerifyFs, root: string): Promise<string | undefined> {
  const win = isWindowsPath(root)

  if (await has(fs, root, 'package.json')) {
    try {
      const pkg = JSON.parse(await fs.read(joinPath(root, 'package.json'))) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const pm = (await has(fs, root, 'pnpm-lock.yaml')) ? 'pnpm' : (await has(fs, root, 'yarn.lock')) ? 'yarn' : (await has(fs, root, 'bun.lockb')) || (await has(fs, root, 'bun.lock')) ? 'bun' : 'npm'
      if (scripts.test && !PLACEHOLDER.test(scripts.test)) return `${pm} test`
      if (scripts.typecheck) return `${pm} run typecheck`
      if (scripts.build) return `${pm} run build`
    } catch {
      /* unreadable manifest: try the others */
    }
  }
  if ((await has(fs, root, 'pytest.ini')) || (await has(fs, root, 'tests')) || (await has(fs, root, 'test')) || (await has(fs, root, 'conftest.py'))) {
    return `${pythonFor(win)} -m pytest -q -x --no-header -p no:cacheprovider`
  }
  if (await has(fs, root, 'Cargo.toml')) return 'cargo test -q'
  if (await has(fs, root, 'go.mod')) return 'go test ./...'
  if (await has(fs, root, 'pubspec.yaml')) return 'flutter test'
  if (await has(fs, root, 'mix.exs')) return 'mix test'
  if ((await has(fs, root, 'build.gradle')) || (await has(fs, root, 'build.gradle.kts'))) {
    const wrapped = (await has(fs, root, 'gradlew')) || (await has(fs, root, 'gradlew.bat'))
    return `${wrapped ? wrapperFor(win, 'gradlew', 'gradlew.bat') : 'gradle'} test -q`
  }
  if (await has(fs, root, 'pom.xml')) {
    const wrapped = (await has(fs, root, 'mvnw')) || (await has(fs, root, 'mvnw.cmd'))
    return `${wrapped ? wrapperFor(win, 'mvnw', 'mvnw.cmd') : 'mvn'} -q test`
  }
  if (await anyNamed(fs, root, n => /\.(sln|csproj|fsproj)$/i.test(n))) return 'dotnet test'
  if (await has(fs, root, 'Makefile')) {
    const mk = await fs.read(joinPath(root, 'Makefile')).catch(() => '')
    if (/^test:/m.test(mk)) return 'make test'
    if (/^check:/m.test(mk)) return 'make check'
  }
  if ((await has(fs, root, 'Gemfile')) && (await has(fs, root, 'spec'))) return 'bundle exec rspec'
  if (await has(fs, root, 'composer.json')) {
    if ((await has(fs, root, 'phpunit.xml')) || (await has(fs, root, 'phpunit.xml.dist'))) return win ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit'
  }
  return undefined
}

/** `detectWith` over the session's own file system. */
export function detectVerifyCommand($: EngineInterface, root: string): Promise<string | undefined> {
  return detectWith({ exists: p => $.fs.exists(p), read: p => $.fs.read(p), list: p => $.fs.list(p) }, root)
}

export type VerifyResult = { ok: boolean; text: string; denied?: string }

/** Run the command through the session's own Bash tool (permissions and hooks included). */
export async function runVerify($: EngineInterface, command: string): Promise<VerifyResult> {
  const ran = await $.tool.call({ tool: 'Bash', command, timeout: 300000, description: 'Hmind verification run' })
  if (ran.deny !== undefined) return { ok: false, text: '', denied: ran.deny }
  const text = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '').slice(0, 20000)
  return { ok: ran.isError === undefined, text }
}
