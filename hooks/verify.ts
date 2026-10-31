// Auto-verify: when a turn claims completion without running anything, run the
// project's own test or build command and put the result in front of the model.
// Opt-in per project (`/hmind verify on`) or globally (`autoVerify`).

import type { EngineInterface } from 'claude-code'

const PLACEHOLDER = /no test specified/i

async function has($: EngineInterface, root: string, name: string): Promise<boolean> {
  return $.fs.exists(`${root}/${name}`).catch(() => false)
}

/** The command that verifies this project, from its manifests; undefined when none is recognised. */
export async function detectVerifyCommand($: EngineInterface, root: string): Promise<string | undefined> {
  if (await has($, root, 'package.json')) {
    try {
      const pkg = JSON.parse(await $.fs.read(`${root}/package.json`)) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const pm = (await has($, root, 'pnpm-lock.yaml')) ? 'pnpm' : (await has($, root, 'yarn.lock')) ? 'yarn' : (await has($, root, 'bun.lockb')) || (await has($, root, 'bun.lock')) ? 'bun' : 'npm'
      if (scripts.test && !PLACEHOLDER.test(scripts.test)) return `${pm} test`
      if (scripts.typecheck) return `${pm} run typecheck`
      if (scripts.build) return `${pm} run build`
    } catch {
      /* unreadable manifest: try the others */
    }
  }
  if ((await has($, root, 'pytest.ini')) || (await has($, root, 'pyproject.toml')) || (await has($, root, 'tests')) || (await has($, root, 'test'))) {
    if ((await has($, root, 'pytest.ini')) || (await has($, root, 'tests')) || (await has($, root, 'test'))) return 'python3 -m pytest -q -x --no-header -p no:cacheprovider'
  }
  if (await has($, root, 'Cargo.toml')) return 'cargo test -q'
  if (await has($, root, 'go.mod')) return 'go test ./...'
  if (await has($, root, 'pubspec.yaml')) return 'flutter test'
  if (await has($, root, 'mix.exs')) return 'mix test'
  if (await has($, root, 'Makefile')) {
    const mk = await $.fs.read(`${root}/Makefile`).catch(() => '')
    if (/^test:/m.test(mk)) return 'make test'
    if (/^check:/m.test(mk)) return 'make check'
  }
  if ((await has($, root, 'Gemfile')) && (await has($, root, 'spec'))) return 'bundle exec rspec'
  return undefined
}

export type VerifyResult = { ok: boolean; text: string; denied?: string }

/** Run the command through the session's own Bash tool (permissions and hooks included). */
export async function runVerify($: EngineInterface, command: string): Promise<VerifyResult> {
  const ran = await $.tool.call({ tool: 'Bash', command, timeout: 300000, description: 'Hmind verification run' })
  if (ran.deny !== undefined) return { ok: false, text: '', denied: ran.deny }
  const text = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '').slice(0, 20000)
  return { ok: ran.isError === undefined, text }
}
