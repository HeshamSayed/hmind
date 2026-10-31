// Platform helpers. The hooks module has no Node, so the platform is read off
// the session's paths: a drive letter or backslashes mean Windows.

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || (p.includes('\\') && !p.includes('/'))

/** Join a root and a relative name with the root's own separator. */
export function joinPath(root: string, name: string): string {
  const sep = isWindowsPath(root) ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  return `${base}${sep}${name.replace(/^[\\/]+/, '')}`
}

/** The interpreter spelling that exists on this platform. */
export const pythonFor = (isWin: boolean): string => (isWin ? 'python' : 'python3')

/** A project-local wrapper script, spelled for the platform. */
export const wrapperFor = (isWin: boolean, unixName: string, winName: string): string => (isWin ? winName : `./${unixName}`)
