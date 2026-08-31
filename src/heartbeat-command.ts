import { execFile, type ExecFileException } from 'node:child_process'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const HEARTBEAT_LOCAL_COMMAND = 'heartbeat_local_command'

const COMMAND_TIMEOUT_MS = 8_000
const COMMAND_MAX_BUFFER = 64 * 1024
const COMMAND_MAX_LENGTH = 300
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

export interface AuthorizedHeartbeatCommand {
  file: string
  args: string[]
  command: string
}

/**
 * One heartbeat-only command surface. It never invokes a shell and accepts only
 * exact read-only inspection forms, so a knowledge document cannot smuggle in
 * operators, scripts, environment changes or arbitrary executables.
 */
export function heartbeatLocalCommandTool(cwd: string): ToolDefinition {
  return {
    name: HEARTBEAT_LOCAL_COMMAND,
    description: [
      'Run one tightly controlled read-only local inspection command when a user-managed knowledge document explicitly requires that command as evidence.',
      'Use this instead of guessing a local version from workspace files. The command runs without a shell, in the current partner workspace, with an 8 second timeout and bounded output.',
      'Supported forms: dsh/node/npm/pnpm/yarn/python/python3/docker/podman/git version; npm or pnpm view/info <package> version|dist-tags.latest; npm list -g <package> --depth=0 --json; and a small set of read-only git status/describe/rev-parse/log commands.',
      'Pipes, redirects, command substitution, scripts, arbitrary programs and unsupported arguments are rejected. If rejected or failed, report that the local fact was not verified; do not silently replace it with a file search.',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Exact command from the knowledge procedure, without surrounding Markdown or sentence punctuation.' },
      },
      required: ['command'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    presentCall: () => ({ card: 'generic', title: '核验本地状态' }),
    timeoutMs: COMMAND_TIMEOUT_MS + 1_000,
    isConcurrencySafe: () => true,
    async execute(value, exec) {
      const input = record(value)
      if (typeof input.command !== 'string') throw new Error('command must be a string')
      const authorized = authorizeHeartbeatCommand(input.command)
      const result = await runAuthorizedCommand(authorized, cwd, exec.signal)
      return [
        `Command: ${authorized.command}`,
        `Exit code: ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n')
    },
  }
}

export function authorizeHeartbeatCommand(command: string): AuthorizedHeartbeatCommand {
  const normalized = command.normalize('NFKC').trim()
  if (!normalized || normalized.length > COMMAND_MAX_LENGTH) throw new Error(`command must contain 1-${COMMAND_MAX_LENGTH} characters`)
  if (/[\r\n\0]/u.test(normalized)) throw new Error('multiline commands are not allowed')
  const tokens = tokenizeCommand(normalized)
  if (tokens.length === 0 || tokens.length > 8) throw new Error('command has an unsupported number of arguments')
  const [file, ...args] = tokens as [string, ...string[]]
  if (allowedVersionCommand(file, args) || allowedRegistryCommand(file, args) || allowedGlobalPackageQuery(file, args) || allowedGitCommand(file, args)) {
    return { file, args, command: tokens.map(quoteDisplayToken).join(' ') }
  }
  throw new Error(`command is not in the heartbeat read-only allowlist: ${file}`)
}

function allowedVersionCommand(file: string, args: string[]): boolean {
  const versionArgs: Record<string, readonly string[]> = {
    dsh: ['-V', '--version'],
    node: ['-v', '--version'],
    npm: ['-v', '--version'],
    pnpm: ['-v', '--version'],
    yarn: ['-v', '--version'],
    python: ['-V', '--version'],
    python3: ['-V', '--version'],
    docker: ['-v', '--version'],
    podman: ['-v', '--version'],
    git: ['--version'],
  }
  return args.length === 1 && versionArgs[file]?.includes(args[0] ?? '') === true
}

function allowedRegistryCommand(file: string, args: string[]): boolean {
  if (file !== 'npm' && file !== 'pnpm') return false
  if (args.length !== 3 || (args[0] !== 'view' && args[0] !== 'info')) return false
  return PACKAGE_NAME.test(args[1] ?? '') && (args[2] === 'version' || args[2] === 'dist-tags.latest')
}

function allowedGlobalPackageQuery(file: string, args: string[]): boolean {
  if (file !== 'npm' || args.length !== 5) return false
  return args[0] === 'list' && args[1] === '-g' && PACKAGE_NAME.test(args[2] ?? '') && args[3] === '--depth=0' && args[4] === '--json'
}

function allowedGitCommand(file: string, args: string[]): boolean {
  if (file !== 'git') return false
  const joined = args.join('\0')
  return new Set([
    'status\0--short\0--branch',
    'describe\0--tags\0--always',
    'describe\0--tags\0--always\0--dirty',
    'rev-parse\0HEAD',
    'rev-parse\0--short\0HEAD',
    'branch\0--show-current',
    'log\0-1\0--format=%H',
    'log\0-1\0--format=%h',
  ]).has(joined)
}

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaping = false
  let started = false
  for (const character of value) {
    if (escaping) {
      current += character
      escaping = false
      started = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaping = true
      started = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if ('|&;<>`$(){}'.includes(character)) throw new Error(`shell metacharacter is not allowed: ${character}`)
    current += character
    started = true
  }
  if (quote !== undefined || escaping) throw new Error('command contains an unfinished quote or escape')
  if (started) tokens.push(current)
  return tokens
}

function runAuthorizedCommand(command: AuthorizedHeartbeatCommand, cwd: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, {
      cwd,
      signal,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: commandEnvironment(),
    }, (error, stdout, stderr) => {
      const output = { stdout: cleanOutput(stdout), stderr: cleanOutput(stderr), exitCode: exitCode(error) }
      if (error !== null) {
        const detail = output.stderr || output.stdout || error.message
        reject(new Error(`read-only command failed (exit ${output.exitCode}): ${detail}`))
        return
      }
      resolve(output)
    })
  })
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const inherited = [
    'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_registry',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const name of inherited) if (process.env[name] !== undefined) env[name] = process.env[name]
  return {
    ...env,
    CI: '1', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_COLOR: 'false',
  }
}

function cleanOutput(value: string): string {
  const cleaned = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '').trim()
  return cleaned.length <= 16_000 ? cleaned : `${cleaned.slice(0, 15_999)}…`
}

function exitCode(error: ExecFileException | null): number {
  if (error === null) return 0
  const code = error.code
  return typeof code === 'number' ? code : code === 'ETIMEDOUT' ? 124 : 1
}

function quoteDisplayToken(value: string): string {
  return /^[a-zA-Z0-9@%_./:=+-]+$/u.test(value) ? value : JSON.stringify(value)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('arguments must be an object')
  return value as Record<string, unknown>
}
