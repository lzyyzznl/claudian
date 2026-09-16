import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { getEnhancedPath } from '@/utils/env';
import { parsePathEntries } from '@/utils/path';

const STDERR_BUFFER_LIMIT = 8_000;
const OMP_PACKAGE_NAME = '@oh-my-pi/pi-coding-agent';
const BUN_EXECUTABLE = 'bun.exe';
const BUN_SHIM_EXTENSION = '.bunx';

export interface OmpSubprocessLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type CloseListener = (error?: Error) => void;

export class OmpSubprocess {
  private closeError: Error | null = null;
  private readonly closeListeners = new Set<CloseListener>();
  private notifiedClose = false;
  private readonly process: ManagedStdioProcess;

  constructor(launchSpec: OmpSubprocessLaunchSpec) {
    const enhancedPath = getEnhancedPath(
      launchSpec.env.PATH,
      path.isAbsolute(launchSpec.command) ? launchSpec.command : undefined,
    );
    const processSpec = resolveOmpProcessSpec(launchSpec, enhancedPath);
    this.process = new ManagedStdioProcess({
      ...launchSpec,
      ...processSpec,
      env: {
        ...launchSpec.env,
        PATH: enhancedPath,
      },
      stderrBufferLimit: STDERR_BUFFER_LIMIT,
    });
    this.process.onError((error) => {
      this.closeError = error;
      this.notifyClose(error);
    });
    this.process.onExit(({ code, signal }) => {
      const reason = signal ? `signal ${signal}` : code === null ? 'unknown' : `code ${code}`;
      const exitError = this.closeError ?? (
        code === 0 && signal === null
          ? undefined
          : new Error(`OMP subprocess exited (${reason})`)
      );
      this.notifyClose(exitError);
    });
  }

  get stdin(): Writable {
    this.assertStarted();
    return this.process.stdin;
  }

  get stdout(): Readable {
    this.assertStarted();
    return this.process.stdout;
  }

  start(): void {
    this.process.start();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  getStderrSnapshot(): string {
    return this.process.getStderrSnapshot();
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  shutdown(): Promise<void> {
    return this.process.shutdown();
  }

  private assertStarted(): void {
    if (!this.process.isStarted()) {
      throw new Error('OMP subprocess is not started');
    }
  }

  private notifyClose(error?: Error): void {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error);
      } catch {
        // Close observers cannot interrupt provider cleanup.
      }
    }
    this.closeListeners.clear();
  }
}

/**
 * omp installs as a bun package, so its Windows launchers are installation locators rather than
 * executables: `.cmd`/`.ps1`/`.bunx` shims only record where `dist/cli.js` lives. Resolve that
 * entry point and launch it with bun and structured argv. Never route arguments through
 * `cmd.exe`; fail closed when the entry point or bun cannot be established.
 */
export function resolveOmpProcessSpec(
  launchSpec: OmpSubprocessLaunchSpec,
  enhancedPath: string,
): Pick<
  ConstructorParameters<typeof ManagedStdioProcess>[0],
  'args' | 'command' | 'killProcessTree'
> {
  const command = launchSpec.command.trim();
  if (process.platform !== 'win32') {
    return { args: launchSpec.args, command, killProcessTree: false };
  }

  if (isOmpWindowsLauncher(command)) {
    const entrypoint = readOmpLauncherEntrypoint(command);
    if (!entrypoint) {
      throw new Error(
        'The OMP Windows launcher could not be resolved to its bundled dist/cli.js entry point: '
        + `${command}. Reinstall omp through bun (bun install -g ${OMP_PACKAGE_NAME}) `
        + 'or configure a native omp executable.',
      );
    }

    const bunExecutable = findBunExecutable(path.dirname(command), enhancedPath);
    if (!bunExecutable) {
      throw new Error(
        'OMP requires bun, but no bun executable was found next to the omp launcher or on PATH. '
        + 'Install bun (https://bun.sh) or configure a native omp executable.',
      );
    }

    return {
      args: [entrypoint, ...launchSpec.args],
      command: bunExecutable,
      killProcessTree: true,
    };
  }

  return { args: launchSpec.args, command, killProcessTree: false };
}

function isOmpWindowsLauncher(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  if (extension === '.bat' || extension === '.cmd' || extension === '.ps1') return true;
  return extension === '.exe' && isFile(bunShimPath(command));
}

function readOmpLauncherEntrypoint(command: string): string | null {
  const extension = path.extname(command).toLowerCase();
  const candidates = extension === '.ps1'
    ? readPowerShellShimEntrypoints(command)
    : extension === '.exe'
    ? readBunShimEntrypoints(command)
    : readWindowsCommandShimEntrypoints(command);

  for (const candidate of candidates) {
    const entrypoint = findOwningOmpEntry(candidate);
    if (entrypoint) return entrypoint;
  }
  return null;
}

function readWindowsCommandShimEntrypoints(command: string): string[] {
  const contents = readTextFile(command);
  if (!contents) return [];

  const entrypoints: string[] = [];
  const shimDirectory = path.dirname(command);
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const relativeMatch = /"%(?:~dp0|dp0%)\\([^"\r\n]+?)"\s+%\*\s*$/iu.exec(line);
    if (relativeMatch?.[1] && isSupportedWindowsCommandShim(line.slice(0, relativeMatch.index))) {
      entrypoints.push(path.resolve(shimDirectory, toPlatformSeparators(relativeMatch[1])));
      continue;
    }

    const absoluteMatch = /"([^"\r\n]+)"\s+%\*\s*$/u.exec(line);
    if (
      absoluteMatch?.[1]
      && path.isAbsolute(absoluteMatch[1])
      && isSupportedWindowsCommandShim(line.slice(0, absoluteMatch.index))
    ) {
      entrypoints.push(path.normalize(absoluteMatch[1]));
    }
  }
  return entrypoints;
}

function readPowerShellShimEntrypoints(command: string): string[] {
  const contents = readTextFile(command);
  if (!contents) return [];

  const entrypoints: string[] = [];
  const shimDirectory = path.dirname(command);
  const invocation = /&\s+"[^"\r\n]*[\\/]?bun(?:\$exe)?"\s+"([^"\r\n]+)"\s+\$args\s*$/iu;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const match = invocation.exec(rawLine.trim());
    const target = match?.[1]?.trim();
    if (!target) continue;

    const relativeMatch = /^\$(?:basedir|\{basedir\})[\\/](.+)$/iu.exec(target);
    if (relativeMatch?.[1]) {
      entrypoints.push(path.resolve(shimDirectory, toPlatformSeparators(relativeMatch[1])));
    } else if (path.isAbsolute(target)) {
      entrypoints.push(path.normalize(target));
    }
  }
  return entrypoints;
}

function readBunShimEntrypoints(command: string): string[] {
  const sidecar = readBunxSidecar(bunShimPath(command));
  if (!sidecar) return [];

  const separatorIndex = sidecar.indexOf('"');
  const target = (separatorIndex >= 0 ? sidecar.slice(0, separatorIndex) : sidecar).trim();
  if (!target) return [];
  if (path.isAbsolute(target)) return [path.normalize(target)];

  const shimDirectory = path.dirname(command);
  const relative = toPlatformSeparators(target);
  return [
    path.resolve(shimDirectory, relative),
    path.resolve(path.dirname(shimDirectory), relative),
  ];
}

/**
 * bun records the launcher target in a `.bunx` sidecar, encoded as UTF-16LE behind the recorded
 * package entry; decode before reading so the path is not NUL-interleaved.
 */
function readBunxSidecar(filePath: string): string | null {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  return buffer.length >= 2 && buffer[1] === 0 && buffer[0] !== 0
    ? buffer.toString('utf16le')
    : buffer.toString('utf8');
}

function bunShimPath(command: string): string {
  const parsed = path.parse(command);
  return path.join(parsed.dir, `${parsed.name}${BUN_SHIM_EXTENSION}`);
}

function isSupportedWindowsCommandShim(value: string): boolean {
  const invocation = value.trim().replace(/^@/u, '').trim();
  if (/^bun(?:\.exe)?$/iu.test(invocation)) return true;
  if (/^"%(?:~dp0|dp0%)\\bun(?:\.exe)?"$/iu.test(invocation)) return true;
  return /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+(?:set\s+PATHEXT=[^&\r\n]+\s+&\s+)?"%_prog%"$/iu.test(invocation);
}

function findOwningOmpEntry(target: string): string | null {
  const resolvedTarget = path.resolve(target);
  const isWindows = process.platform === 'win32';
  const comparableTarget = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;
  let current = path.dirname(resolvedTarget);
  while (true) {
    const entryPath = readOmpPackageEntry(current);
    if (entryPath && (isWindows ? entryPath.toLowerCase() : entryPath) === comparableTarget) {
      return entryPath;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readOmpPackageEntry(packageRoot: string): string | null {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as {
      bin?: string | Record<string, unknown>;
      name?: unknown;
    };
    if (packageJson.name !== OMP_PACKAGE_NAME) return null;
    const relativeBin = typeof packageJson.bin === 'object'
      && packageJson.bin !== null
      && typeof packageJson.bin.omp === 'string'
      ? packageJson.bin.omp
      : null;
    if (!relativeBin) return null;

    const resolvedRoot = path.resolve(packageRoot);
    const resolvedBin = path.resolve(resolvedRoot, relativeBin);
    const relative = path.relative(resolvedRoot, resolvedBin);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return fs.statSync(resolvedBin).isFile() ? resolvedBin : null;
  } catch {
    return null;
  }
}

function findBunExecutable(launcherDirectory: string, enhancedPath: string): string | null {
  const adjacent = path.join(launcherDirectory, BUN_EXECUTABLE);
  if (isFile(adjacent)) return adjacent;

  for (const directory of parsePathEntries(enhancedPath)) {
    const candidate = path.join(directory, BUN_EXECUTABLE);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function toPlatformSeparators(value: string): string {
  return value.replace(/[\\/]/gu, path.sep);
}
