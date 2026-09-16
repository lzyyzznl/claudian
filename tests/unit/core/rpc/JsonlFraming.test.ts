import { PassThrough } from 'node:stream';

import { subscribeJsonlLines, writeJsonlLine } from '@/core/rpc/JsonlFraming';

describe('JsonlFraming', () => {
  it('splits only on LF and strips CR', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribeJsonlLines(stream, line => lines.push(line));
    const separator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    stream.write(`{"a":1}\r\n{"b":"line${separator}separator${paragraphSeparator}still same record"}\n`);

    expect(lines).toEqual([
      '{"a":1}',
      `{"b":"line${separator}separator${paragraphSeparator}still same record"}`,
    ]);
  });

  it('emits trailing buffered records on end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribeJsonlLines(stream, line => lines.push(line));

    stream.write('{"a":1}');
    stream.end();
    await new Promise(resolve => setImmediate(resolve));

    expect(lines).toEqual(['{"a":1}']);
  });

  it('writes JSONL records', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', chunk => chunks.push(chunk.toString('utf8')));

    writeJsonlLine(output, { type: 'ping' });

    expect(chunks.join('')).toBe('{"type":"ping"}\n');
  });
});
