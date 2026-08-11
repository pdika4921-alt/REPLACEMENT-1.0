const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const W = 595.28;
const H = 841.89;
const M = 56.7;

function gambarAda(file) {
  return file && fs.existsSync(file);
}

function basename(s) {
  return path.basename(String(s || ''));
}

function resolveUpload(uploadBase, rel, nama) {
  return path.join(uploadBase, rel, basename(nama));
}

function cekHalaman(doc, y, butuh) {
  if (y + butuh > H - M) {
    doc.addPage();
    return M;
  }
  return y;
}

function garisGanda(doc, x, y, w) {
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(1.1).stroke('#000');
  doc.moveTo(x, y + 3).lineTo(x + w, y + 3).lineWidth(0.6).stroke('#000');
  doc.lineWidth(1);
}

function gambarTabel(doc, x, y, cols, rows) {
  const pad = 4;
  const headerH = 24;
  const rowH = 20;
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  let cy = y;

  doc.rect(x, cy, totalW, headerH).fill('#f2f2f2').stroke('#000');
  let hx = x;
  doc.fillColor('#000').font('Times-Bold').fontSize(9);
  cols.forEach((c, i) => {
    doc.text(String(c.label), hx + pad, cy + 7, { width: c.w - pad * 2, align: c.align || 'center' });
    hx += c.w;
    if (i < cols.length - 1) {
      doc.moveTo(hx, cy).lineTo(hx, cy + headerH).stroke('#000');
    }
  });
  cy += headerH;

  rows.forEach((r) => {
    cy = cekHalaman(doc, cy, rowH + 4);
    let rx = x;
    doc.font('Times-Roman').fontSize(8.5).fillColor('#000');
    cols.forEach((c, i) => {
      const v = r[i] == null ? '' : String(r[i]);
      doc.text(v, rx + pad, cy + 6, { width: c.w - pad * 2, align: i === 0 ? 'center' : (c.align || 'left') });
      rx += c.w;
    });
    doc.moveTo(x, cy).lineTo(x + totalW, cy).stroke('#000');
    rx = x;
    for (let i = 0; i < cols.length - 1; i++) {
      rx += cols[i].w;
      doc.moveTo(rx, cy).lineTo(rx, cy + rowH).stroke('#000');
    }
    cy += rowH;
  });
  doc.rect(x, cy, totalW, 0.6).stroke('#000');
  return cy + 8;
}

function buatPdfBast(row, opts) {
  return new Promise((resolve, reject) => {
    try {
      const uploadBase = opts.uploadBase;
      const logoPath = opts.logoPath || path.join(process.cwd(), 'public', 'logo-telkom.png');
      const doc = new PDFDocument({
        size: 'A4',
        margin: M,
        info: { Title: 'BAST ' + (row.kode_unik || ''), Author: 'Sistem BAST' }
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let perangkat = [];
      let eviden = [];
      try { perangkat = JSON.parse(row.perangkat_json || '[]'); } catch (e) {}
      try { eviden = JSON.parse(row.eviden_json || '[]'); } catch (e) {}

      const CW = W - M * 2;

      let y = M;
      if (gambarAda(logoPath)) {
        try { doc.image(logoPath, M, y - 8, { height: 46 }); } catch (e) {}
      }

      doc.font('Times-Bold').fontSize(14).fillColor('#000');
      doc.text('BERITA ACARA SERAH TERIMA (BAST)', M, M, { width: CW, align: 'center' });
      doc.text('PERANGKAT REPLACEMENT ONT', M, doc.y + 2, { width: CW, align: 'center' });
      y = doc.y + 12;
      garisGanda(doc, M, y, CW);
      y += 16;

      doc.font('Times-Roman').fontSize(11);
      doc.text('Nomor: ' + (row.kode_unik || '-'), M, y, { width: CW, align: 'center' });
      y = doc.y + 12;

      const intro = 'Pada hari ini, tanggal ' + (row.tanggal || '-') + ' bertempat di Lokasi ' +
        (row.loksto || '-') + ' telah dilakukan serah terima perangkat antara:';
      y = cekHalaman(doc, y, 60);
      doc.font('Times-Roman').fontSize(11);
      doc.text(intro, M, y, { width: CW, align: 'left' });
      y = doc.y + 12;

      doc.font('Times-Bold').fontSize(11);
      doc.text('1. Pihak Pertama (Pemberi):', M, y, { width: CW });
      y = doc.y + 4;
      doc.font('Times-Roman').fontSize(10);
      const p1 = [
        ['Nama (NIK)', ': ' + (row.teknisi_nama || '-') + ' (' + (row.teknisi_nik || '-') + ')'],
        ['Jabatan', ': Teknisi'],
        ['Instansi/Perusahaan', ': PT. TELKOM AKSES']
      ];
      p1.forEach((p) => {
        y = cekHalaman(doc, y, 18);
        doc.text('\u2022 ' + p[0] + '  ' + p[1], M + 18, y, { width: CW - 18 });
        y = doc.y + 2;
      });
      y += 8;

      doc.font('Times-Bold').fontSize(11);
      doc.text('2. Pihak Kedua (Penerima):', M, y, { width: CW });
      y = doc.y + 4;
      doc.font('Times-Roman').fontSize(10);
      const p2 = [
        ['Nama', ': ' + (row.wh_nama || '-')],
        ['Alamat/Instansi', ': PT. TELKOM AKSES']
      ];
      p2.forEach((p) => {
        y = cekHalaman(doc, y, 18);
        doc.text('\u2022 ' + p[0] + '  ' + p[1], M + 18, y, { width: CW - 18 });
        y = doc.y + 2;
      });
      y += 10;

      doc.font('Times-Bold').fontSize(11);
      doc.text('DETAIL BARANG:', M, y, { width: CW });
      y = doc.y + 2;
      doc.font('Times-Roman').fontSize(10);
      doc.text('Pihak Pertama menyerahkan perangkat kepada Pihak Kedua dengan rincian sebagai berikut:', M, y, { width: CW });
      y = doc.y + 8;

      const cols = [
        { label: 'No', w: 26 },
        { label: 'Nama Barang', w: 70 },
        { label: 'Merk & SN ONT lama', w: 100 },
        { label: 'Tipe Pekerjaan', w: 72 },
        { label: 'SN ONT Baru', w: 90 },
        { label: 'No Internet', w: 62 },
        { label: 'Kondisi', w: 62 }
      ];
      const rows = perangkat.map((it, i) => [
        i + 1, 'ONT', it.snlama || '-', 'REPLACE', it.snbaru || '-', it.noinet || '-', it.kondisi || '-'
      ]);
      y = cekHalaman(doc, y, headerTinggi(cols) + rows.length * 20 + 30);
      y = gambarTabel(doc, M, y, cols, rows.length ? rows : [[1, 'ONT', '-', 'REPLACE', '-', '-', '-']]);

      doc.font('Times-Bold').fontSize(11);
      doc.text('PERNYATAAN:', M, y, { width: CW });
      y = doc.y + 4;
      doc.font('Times-Roman').fontSize(10);
      const pernyataan = [
        '1. Pihak Kedua menyatakan telah menerima perangkat tersebut dalam keadaan lengkap dan berfungsi dengan baik.',
        '2. Pihak Kedua bertanggung jawab penuh atas keamanan dan pemeliharaan perangkat selama masa penyimpanan di WH area.',
        '3. Apabila terjadi kerusakan atau kehilangan akibat kelalaian Pihak Kedua, maka akan dikenakan sanksi/biaya penggantian sesuai ketentuan yang berlaku.'
      ];
      pernyataan.forEach((t) => {
        y = cekHalaman(doc, y, 20);
        doc.text(t, M + 12, y, { width: CW - 12 });
        y = doc.y + 4;
      });
      y += 6;
      doc.font('Times-Roman').fontSize(11);
      doc.text('Demikian Berita Acara ini dibuat untuk dipergunakan sebagaimana mestinya.', M, y, { width: CW });
      y = doc.y + 40;

      y = cekHalaman(doc, y, 150);
      const boxW = CW / 2;
      const ttdT = resolveUpload(uploadBase, 'ttd', row.ttd_teknisi);
      const ttdW = resolveUpload(uploadBase, 'ttd', row.ttd_wh);
      doc.font('Times-Roman').fontSize(10);
      doc.text('Pihak Pertama (Pemberi)', M, y, { width: boxW, align: 'center' });
      let iy = y + 16;
      if (gambarAda(ttdT)) {
        try { doc.image(ttdT, M + 15, iy, { fit: [boxW - 30, 70] }); iy += 75; } catch (e) { iy += 70; }
      } else {
        iy += 70;
      }
      doc.text('_' + (row.teknisi_nama || '-') + '_', M, iy, { width: boxW, align: 'center' });

      doc.text('Pihak Kedua (Penerima)', M + boxW, y, { width: boxW, align: 'center' });
      let iy2 = y + 16;
      if (gambarAda(ttdW)) {
        try { doc.image(ttdW, M + boxW + 15, iy2, { fit: [boxW - 30, 70] }); iy2 += 75; } catch (e) { iy2 += 70; }
      } else {
        iy2 += 70;
      }
      doc.text('_' + (row.wh_nama || '-') + '_', M + boxW, iy2, { width: boxW, align: 'center' });

      if (eviden.length) {
        doc.addPage();
        let py = M;
        doc.font('Times-Bold').fontSize(12);
        doc.text('LAMPIRAN EVIDEN FOTO LAPANGAN - BAST NOMOR: ' + (row.kode_unik || '-'), M, py, { width: CW, align: 'center' });
        py = doc.y + 10;
        const imgW = (CW - 12) / 2;
        eviden.forEach((f, i) => {
          const fp = resolveUpload(uploadBase, 'eviden', f);
          py = cekHalaman(doc, py, 170);
          const col = i % 2;
          const rowN = Math.floor(i / 2);
          const x = M + col * (imgW + 12);
          const yy = py + rowN * 160;
          if (gambarAda(fp)) {
            try {
              doc.image(fp, x, yy, { fit: [imgW, 140] });
            } catch (e) {}
          } else {
            doc.text('Foto ' + (i + 1) + ' (file tidak ditemukan)', x, yy, { width: imgW, align: 'center' });
          }
        });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function headerTinggi(cols) {
  return 24;
}

module.exports = { buatPdfBast };
