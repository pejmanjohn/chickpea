/** A minimal text PDF that PDF.js extracts, one string per page. */
export function makeTextPdf(pages: string[]): Uint8Array {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let index = 0; index < pages.length; index += 1) {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    const operators = pages[index]!.split('\n').map((line) => {
      const escaped = line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
      return `(${escaped}) Tj 0 -14 Td`;
    }).join(' ');
    const stream = `BT /F1 12 Tf 72 720 Td ${operators} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}\nendstream`,
    );
  }

  let body = '%PDF-1.4\n%1234\n';
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(body).byteLength);
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(body).byteLength;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
