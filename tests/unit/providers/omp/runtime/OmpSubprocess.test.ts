import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import { OmpSubprocess, resolveOmpProcessSpec } from '@/providers/omp/runtime/OmpSubprocess';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** Byte-for-byte copy of a bun-global `omp.cmd` install locator. */
const BUN_GLOBAL_COMMAND_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\bun.exe" (',
  '  SET "_prog=%dp0%\\bun.exe"',
  ') ELSE (',
  '  SET "_prog=bun"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*',
  '',
].join('\r\n');

/** Byte-for-byte copy of a bun-global `omp.ps1` install locator. */
const BUN_GLOBAL_POWERSHELL_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '}',
  '$ret=0',
  'if (Test-Path "$basedir/bun$exe") {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/bun$exe"  "$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" $args',
  '  } else {',
  '    & "$basedir/bun$exe"  "$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '} else {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "bun$exe"  "$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" $args',
  '  } else {',
  '    & "bun$exe"  "$basedir/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '}',
  'exit $ret',
  '',
].join('\n');

/** Mutable view of the child-process fields the tests drive; @types/node declares these readonly. */
type MockChildProcess = Omit<ChildProcessWithoutNullStreams, 'exitCode' | 'killed'> & {
  exitCode: number | null;
  killed: boolean;
};

function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as unknown as MockChildProcess;
  Object.assign(proc, {
    exitCode: null,
    killed: false,
    pid: 12345,
    signalCode: null,
    stderr: new Readable({ read() {} }),
    stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout: new Readable({ read() {} }),
  });
  proc.kill = jest.fn((signal?: NodeJS.Signals | number) => {
    proc.killed = signal === 'SIGKILL';
    return true;
  });
  return proc;
}

async function writeOmpPackage(packageRoot: string): Promise<string> {
  const cliPath = path.join(packageRoot, 'dist', 'cli.js');
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, '#!/usr/bin/env bun\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    bin: { omp: 'dist/cli.js' },
    name: '@oh-my-pi/pi-coding-agent',
  }));
  return cliPath;
}

async function writeFile(filePath: string, contents: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

describe('OmpSubprocess', () => {
  const originalPlatform = process.platform;
  let proc: MockChildProcess;
  let launchPrefix: string;
  let launchCliPath: string;
  let launchBunPath: string;
  let launchCommand: string;
  let powerShellCommand: string;
  let absoluteCommand: string;
  let unownedCommand: string;
  let unknownCommand: string;
  let malformedCommands: string[];
  let directCommand: string;
  let bunShimCommand: string;
  let utf8ShimCommand: string;
  let pathBunPath: string;
  let isolatedCommand: string;

  beforeAll(async () => {
    launchPrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-windows-launch-'));
    launchCliPath = await writeOmpPackage(
      path.join(launchPrefix, 'node_modules', '@oh-my-pi', 'pi-coding-agent'),
    );
    launchBunPath = path.join(launchPrefix, 'bun.exe');
    launchCommand = path.join(launchPrefix, 'omp.cmd');
    powerShellCommand = path.join(launchPrefix, 'omp.ps1');
    await fs.writeFile(launchBunPath, '');
    await fs.writeFile(launchCommand, BUN_GLOBAL_COMMAND_SHIM);
    await fs.writeFile(powerShellCommand, BUN_GLOBAL_POWERSHELL_SHIM);

    const relativeCliPath = path.join(
      'node_modules',
      '@oh-my-pi',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    absoluteCommand = path.join(launchPrefix, 'absolute-bin', 'omp.cmd');
    await writeFile(
      absoluteCommand,
      `@ECHO off\r\nbun "${launchCliPath}" %*\r\n`,
    );

    const unownedCliPath = path.join(launchPrefix, 'unowned', 'cli.js');
    unownedCommand = path.join(launchPrefix, 'unowned-bin', 'omp.cmd');
    await writeFile(unownedCliPath, '#!/usr/bin/env bun\n');
    await writeFile(unownedCommand, [
      '@ECHO off',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%~dp0\\${path.join('..', 'unowned', 'cli.js')}" %*`,
      '',
    ].join('\r\n'));

    unknownCommand = path.join(launchPrefix, 'unknown-bin', 'omp.cmd');
    await writeFile(unknownCommand, '@ECHO off\r\nunknown-wrapper %*\r\n');

    const malformedTarget = `"%~dp0\\${relativeCliPath}" %*`;
    malformedCommands = await Promise.all([
      (target: string) => `REM ${target}`,
      (target: string) => `unknown-wrapper & bun ${target}`,
      (target: string) => `call ${target}`,
    ].map(async (buildContents, index) => {
      const command = path.join(launchPrefix, 'malformed-bin', String(index), 'omp.cmd');
      await writeFile(command, `${buildContents(malformedTarget)}\r\n`);
      return command;
    }));

    directCommand = path.join(launchPrefix, 'release-bin', 'omp-windows-x64.exe');
    await writeFile(directCommand, '');

    const bunHome = path.join(launchPrefix, 'bun-home');
    await writeOmpPackage(
      path.join(bunHome, 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent'),
    );
    bunShimCommand = path.join(bunHome, 'bin', 'omp.exe');
    await writeFile(bunShimCommand, '');
    await writeFile(
      path.join(bunHome, 'bin', 'omp.bunx'),
      Buffer.from(
        'install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"\u0000bun 1.3.14',
        'utf16le',
      ),
    );
    pathBunPath = path.join(bunHome, 'tools', 'bun.exe');
    await writeFile(pathBunPath, '');

    utf8ShimCommand = path.join(bunHome, 'utf8-bin', 'omp.exe');
    await writeFile(utf8ShimCommand, '');
    await writeFile(
      path.join(bunHome, 'utf8-bin', 'omp.bunx'),
      `install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"bun 1.3.14`,
    );

    isolatedCommand = path.join(launchPrefix, 'isolated-bin', 'omp.cmd');
    await writeOmpPackage(
      path.join(launchPrefix, 'isolated-bin', 'node_modules', '@oh-my-pi', 'pi-coding-agent'),
    );
    await writeFile(isolatedCommand, BUN_GLOBAL_COMMAND_SHIM);
  });

  afterAll(async () => {
    await fs.rm(launchPrefix, { force: true, recursive: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.useRealTimers();
  });

  it('spawns the OMP RPC process with the launch spec args, cwd, stdio, and enhanced PATH', () => {
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: '/opt/omp/bin/omp',
      cwd: '/vault',
      env: { PATH: '/usr/bin' },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/omp/bin/omp', ['--mode', 'rpc-ui'], expect.objectContaining({
      cwd: '/vault',
      stdio: 'pipe',
      windowsHide: true,
      env: expect.objectContaining({
        PATH: expect.stringContaining('/usr/bin'),
      }),
    }));
  });

  it('launches the OMP package entry through bun for Windows cmd shims', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new OmpSubprocess({
      args: [
        '--mode',
        'rpc-ui',
        '--system-prompt',
        'First line\nUse R&D policy',
        '--session',
        'D:\\文档\\omp Sessions\\session.jsonl',
      ],
      command: launchCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/bun(?:\.exe)?$/i),
      [
        launchCliPath,
        '--mode',
        'rpc-ui',
        '--system-prompt',
        'First line\nUse R&D policy',
        '--session',
        'D:\\文档\\omp Sessions\\session.jsonl',
      ],
      expect.objectContaining({
        cwd: 'C:\\Vault',
        windowsHide: true,
      }),
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      process.env.ComSpec || process.env.comspec || 'cmd.exe',
      expect.anything(),
      expect.anything(),
    );
  });

  it('launches the OMP package entry through bun for Windows PowerShell shims', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      command: powerShellCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/bun(?:\.exe)?$/i),
      [launchCliPath, '--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('launches the OMP package entry through bun for a Windows shim with an absolute target', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: absoluteCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/bun(?:\.exe)?$/i),
      [launchCliPath, '--mode', 'rpc-ui'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('resolves a Windows bun shim through its bunx sidecar and the bun on PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const spec = resolveOmpProcessSpec({
      args: ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      command: bunShimCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    }, path.dirname(pathBunPath));

    expect(spec).toEqual({
      args: [
        path.join(launchPrefix, 'bun-home', 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'),
        '--mode',
        'rpc-ui',
        '--system-prompt',
        'First line\nSecond line',
      ],
      command: pathBunPath,
      killProcessTree: true,
    });
  });

  it('resolves a UTF-8 bunx sidecar recorded without a UTF-16 encoding', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const spec = resolveOmpProcessSpec({
      args: ['--mode', 'rpc-ui'],
      command: utf8ShimCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    }, path.dirname(pathBunPath));

    expect(spec).toEqual({
      args: [
        path.join(launchPrefix, 'bun-home', 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'),
        '--mode',
        'rpc-ui',
      ],
      command: pathBunPath,
      killProcessTree: true,
    });
  });

  it('spawns a native Windows omp executable directly without a launcher lookup', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      command: directCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });

    subprocess.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      directCommand,
      ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('fails closed when a Windows omp shim targets an unowned script', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new OmpSubprocess({
      args: ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      command: unownedCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    })).toThrow('could not be resolved to its bundled dist/cli.js entry point');
  });

  it('does not replace an unknown Windows shim with a resolvable package', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new OmpSubprocess({
      args: ['--mode', 'rpc-ui', '--system-prompt', 'First line\nSecond line'],
      command: unknownCommand,
      cwd: 'C:\\Vault',
      env: {
        PATH: process.env.PATH,
        PI_PACKAGE_DIR: path.dirname(launchCliPath),
      },
    })).toThrow('could not be resolved to its bundled dist/cli.js entry point');
  });

  it.each([
    ['commented', 0],
    ['prefixed', 1],
    ['malformed', 2],
  ])('rejects a %s owned-entry reference in an unsupported shim layout', (
    _layout,
    commandIndex,
  ) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: malformedCommands[commandIndex],
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    })).toThrow('could not be resolved to its bundled dist/cli.js entry point');
  });

  it('fails closed with an actionable error when bun cannot be located', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => resolveOmpProcessSpec({
      args: ['--mode', 'rpc-ui'],
      command: isolatedCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    }, path.join(launchPrefix, 'empty-bin'))).toThrow('OMP requires bun');
  });

  it('kills the process tree when shutting down a bun-launched Windows OMP process', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: launchCommand,
      cwd: 'C:\\Vault',
      env: { PATH: process.env.PATH },
    });
    subprocess.start();

    const shutdown = subprocess.shutdown();

    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '12345', '/t', '/f'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(proc.kill).not.toHaveBeenCalled();

    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    await shutdown;
  });

  it('keeps a bounded stderr snapshot for runtime errors', () => {
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: 'omp',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    proc.stderr.emit('data', 'a'.repeat(9_000));

    expect(subprocess.getStderrSnapshot()).toHaveLength(8_000);
  });

  it('notifies close listeners and escalates shutdown after timeout', async () => {
    jest.useFakeTimers();
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: 'omp',
      cwd: '/vault',
      env: {},
    });
    const onClose = jest.fn();
    subprocess.onClose(onClose);
    subprocess.start();

    const shutdown = subprocess.shutdown();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    jest.advanceTimersByTime(3_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    proc.exitCode = 1;
    proc.emit('exit', 1, 'SIGKILL');
    await shutdown;

    expect(onClose).toHaveBeenCalledWith(expect.any(Error));
    expect(onClose.mock.calls[0][0].message).toBe('OMP subprocess exited (signal SIGKILL)');
  });

  it('settles after a final deadline when no exit follows SIGKILL', async () => {
    jest.useFakeTimers();
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: 'omp',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    const shutdown = subprocess.shutdown();
    jest.advanceTimersByTime(6_000);

    await expect(shutdown).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('shares one shutdown sequence across repeated calls', async () => {
    const subprocess = new OmpSubprocess({
      args: ['--mode', 'rpc-ui'],
      command: 'omp',
      cwd: '/vault',
      env: {},
    });
    subprocess.start();

    const first = subprocess.shutdown();
    const second = subprocess.shutdown();
    expect(proc.kill).toHaveBeenCalledTimes(1);

    proc.exitCode = 0;
    proc.emit('exit', 0, 'SIGTERM');
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});
