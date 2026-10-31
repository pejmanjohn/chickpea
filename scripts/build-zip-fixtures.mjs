#!/usr/bin/env node
// Writes tests/fixtures/zip/*.zip: one small kit of synthetic files archived
// by real tools, so the zip reader is tested against what people send rather
// than only against tests/helpers/zip.ts. macOS only (zip, ditto, python3).
// Prints each archive's SHA-256 for allowedBinaryFiles in
// scripts/lib/source-export-policy.mjs, which must be updated after a run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests', 'fixtures', 'zip');
const FIXED_TIME = new Date('2026-01-01T00:00:00Z');
const TOOL_ENV = { ...process.env, TZ: 'UTC' };

const KIT = {
  'kit/notes.md': '# Synthetic plan\n\nThis file is synthetic test content.\n',
  'kit/data/table.csv': 'region,units\nnorth,12\nsouth,7\n',
  'kit/report.pdf': textPdf('Synthetic report: 42 units'),
  'kit/logo.png': png(2, 2),
  'kit/.DS_Store': Buffer.concat([Buffer.from('\0\0\0\u0001Bud1'), Buffer.alloc(24)]),
};

const PYTHON_WRITER = `
import os, sys, zipfile
out = sys.argv[1]
names = ['kit/notes.md', 'kit/data/table.csv', 'kit/report.pdf', 'kit/logo.png']
def write(name, compression, comment=b'', entries=names):
    with zipfile.ZipFile(os.path.join(out, name), 'w', compression) as archive:
        archive.comment = comment
        for entry in entries:
            info = zipfile.ZipInfo(entry, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = compression
            with open(entry, 'rb') as source:
                archive.writestr(info, source.read())
write('python-stored.zip', zipfile.ZIP_STORED)
write('python-deflated.zip', zipfile.ZIP_DEFLATED)
write('python-comment.zip', zipfile.ZIP_DEFLATED, comment=b'Synthetic archive comment.')
write('python-empty.zip', zipfile.ZIP_DEFLATED, entries=[])
`;

const work = mkdtempSync(join(tmpdir(), 'chickpea-zip-fixtures-'));
try {
  const source = join(work, 'source');
  for (const [path, content] of Object.entries(KIT)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  // An extended attribute makes ditto write an AppleDouble file under __MACOSX/, as Finder does.
  execFileSync('/usr/bin/xattr', ['-w', 'com.example.synthetic', 'fixture', join(source, 'kit/notes.md')]);
  for (const path of [...Object.keys(KIT), 'kit/data', 'kit']) utimesSync(join(source, path), FIXED_TIME, FIXED_TIME);

  mkdirSync(OUT, { recursive: true });
  const run = (command, args) => execFileSync(command, args, { cwd: source, env: TOOL_ENV, stdio: 'inherit' });
  const output = (name) => {
    const path = join(OUT, name);
    rmSync(path, { force: true });
    return path;
  };
  run('/usr/bin/zip', ['-r', '-q', output('zip-r.zip'), 'kit']);
  run('/usr/bin/zip', ['-r', '-q', '-P', 'synthetic', output('zip-encrypted.zip'), 'kit']);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'kit', output('ditto.zip')]);
  run('python3', ['-I', '-c', PYTHON_WRITER, OUT]);

  for (const name of ['ditto.zip', 'python-comment.zip', 'python-deflated.zip', 'python-empty.zip', 'python-stored.zip', 'zip-encrypted.zip', 'zip-r.zip']) {
    const hash = createHash('sha256').update(readFileSync(join(OUT, name))).digest('hex');
    console.log(`  [exportPath('tests', 'fixtures', 'zip', '${name}'), '${hash}'],`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

function textPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
