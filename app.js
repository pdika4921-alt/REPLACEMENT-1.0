const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); 
const session = require('express-session');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

// === AUTO-CREATE DATABASE ===
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        nama_lengkap TEXT,
        nik TEXT,
        sto TEXT
    )`);

    db.run(`ALTER TABLE users ADD COLUMN nama_lengkap TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN nik TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN sto TEXT`, () => {}); 
    db.run(`ALTER TABLE bast_data ADD COLUMN alasan_tolak TEXT`, () => {});

    db.run(`INSERT OR IGNORE INTO users (username, password, role, nama_lengkap, nik, sto)
            VALUES ('admin', 'admin123', 'admin', 'Administrator', '00000000', 'ALL')`);
    db.run(`INSERT OR IGNORE INTO users (username, password, role, nama_lengkap, nik, sto)
            VALUES ('teknisi', '123', 'teknisi', 'Teknisi Demo', '99999999', 'SUKMAJAYA')`);
    
    db.run(`CREATE TABLE IF NOT EXISTS bast_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kode_unik TEXT UNIQUE, status TEXT,
        tanggal TEXT, loksto TEXT, teknisi_nama TEXT, teknisi_nik TEXT, wh_nama TEXT,
        perangkat_json TEXT, eviden_json TEXT, ttd_teknisi TEXT, ttd_wh TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.json({ limit: '200mb' })); 

app.use(session({ secret: 'telkom_secret', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));

const dirs = ['uploads/eviden', 'uploads/ttd', 'uploads/dokumen_bast'];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, 'uploads/eviden/'),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }) 
});

const checkRole = (role) => (req, res, next) => {
    if (req.session.loggedIn && req.session.role === role) next();
    else res.redirect('/login');
};
const isAuth = (req, res, next) => {
    if (req.session.loggedIn) next();
    else res.redirect('/login');
};

// ===== DEBUG ROUTE — hapus di production =====
app.get('/debug/sto', (req, res) => {
    db.all("SELECT id, username, nama_lengkap, nik, sto, role FROM users", (err, rows) => {
        if (err) return res.json({ error: err.message });
        res.json(rows);
    });
});

// DEBUG: cek isi perangkat_json semua bast_data
app.get('/debug/bast', (req, res) => {
    db.all("SELECT kode_unik, teknisi_nama, status, perangkat_json FROM bast_data ORDER BY id DESC LIMIT 20", (err, rows) => {
        if (err) return res.json({ error: err.message });
        rows.forEach(r => {
            try { r.perangkat_parsed = JSON.parse(r.perangkat_json); } catch(e) { r.perangkat_parsed = 'PARSE ERROR: ' + e.message; }
        });
        res.json(rows);
    });
});

// ================= ROUTE LOGIN =================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (user) {
            req.session.loggedIn     = true;
            req.session.role         = user.role;
            req.session.username     = user.username;
            req.session.nama_lengkap = user.nama_lengkap || user.username;
            req.session.nik          = user.nik || '';

            if (user.role === 'admin')        res.redirect('/admin/dashboard');
            else if (user.role === 'teknisi') res.redirect('/teknisi/dashboard');
            else                              res.redirect('/wh/dashboard');
        } else {
            res.render('login', { error: 'Username atau Password salah!' });
        }
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ================= ROUTE ADMIN =================
app.get('/admin/dashboard', checkRole('admin'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        db.all("SELECT * FROM users WHERE role = 'teknisi' ORDER BY nama_lengkap ASC", (err, teknisiList) => {
            db.all("SELECT * FROM users WHERE role = 'wh' ORDER BY nama_lengkap ASC", (errWh, whList) => {

                let groupedRekap = {};
                let snMaster = {};

                rows.forEach(row => {
                    let items = [];
                    try { items = JSON.parse(row.perangkat_json || '[]'); } catch(e) {}

                    // =====================================================================
                    // FIX: Jika perangkat_json kosong [], tetap tampilkan baris di rekap
                    // supaya admin tahu ada BAST yang masuk tapi perangkat belum terisi
                    // =====================================================================
                    const penyetor = row.teknisi_nama || 'Tanpa Nama';
                    if (!groupedRekap[penyetor]) groupedRekap[penyetor] = [];

                    if (items.length > 0) {
                        items.forEach(item => {
                            groupedRekap[penyetor].push({
                                kode_unik : row.kode_unik,
                                tanggal   : row.tanggal,
                                loksto    : row.loksto,
                                penerima  : row.wh_nama || '-',
                                sn_lama   : item.snlama  || '-',
                                sn_baru   : item.snbaru  || '-',
                                no_inet   : item.noinet  || '-',
                                kondisi   : item.kondisi || '-',
                                status    : row.status
                            });
                            // snMaster untuk VLOOKUP Rekon
                            if (item.snlama && snMaster[item.snlama] !== 'COMPLETED') {
                                snMaster[item.snlama] = row.status;
                            }
                        });
                    } else {
                        // BAST ada tapi perangkat kosong — tetap tampil agar terdeteksi
                        groupedRekap[penyetor].push({
                            kode_unik : row.kode_unik,
                            tanggal   : row.tanggal,
                            loksto    : row.loksto,
                            penerima  : row.wh_nama || '-',
                            sn_lama   : '⚠ Belum diisi',
                            sn_baru   : '⚠ Belum diisi',
                            no_inet   : '-',
                            kondisi   : '-',
                            status    : row.status
                        });
                    }
                });

                const rejectedData = rows.filter(r => r.status === 'REJECTED');
                rejectedData.forEach(row => {
                    try { row.jumlah_perangkat = JSON.parse(row.perangkat_json || '[]').length; }
                    catch(e) { row.jumlah_perangkat = 0; }
                });

                res.render('admin/dashboard', {
                    bastData     : rows,
                    teknisiList,
                    groupedRekap,
                    snMaster,
                    rejectedData,
                    whList       : whList || [],
                    username     : req.session.username
                });
            });
        });
    });
});

app.post('/admin/user/add', checkRole('admin'), (req, res) => {
    const { username, password, role, nama_lengkap, nik, sto } = req.body;
    const safeRole = (role === 'wh') ? 'wh' : 'teknisi';
    db.run(
        "INSERT INTO users (username, password, role, nama_lengkap, nik, sto) VALUES (?, ?, ?, ?, ?, ?)",
        [username, password, safeRole, nama_lengkap || '', nik || '', sto || ''],
        (err) => {
            if (err) return res.send("<script>alert('Username atau NIK sudah terdaftar!'); window.location='/admin/dashboard';</script>");
            res.redirect('/admin/dashboard');
        }
    );
});

app.get('/admin/user/delete/:id', checkRole('admin'), (req, res) => {
    db.run("DELETE FROM users WHERE id = ? AND role IN ('teknisi','wh')", [req.params.id], () => {
        res.redirect('/admin/dashboard');
    });
});

// ================= ROUTE TEKNISI =================
app.get('/teknisi/dashboard', checkRole('teknisi'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        res.render('teknisi/dashboard', { data: rows });
    });
});

app.get('/teknisi/input', checkRole('teknisi'), (req, res) => {
    db.all(`
        SELECT 
            COALESCE(NULLIF(TRIM(nik), ''), username) AS nik, 
            COALESCE(NULLIF(TRIM(nama_lengkap), ''), username) AS nama 
        FROM users 
        WHERE role = 'teknisi' 
        ORDER BY nama ASC
    `, (err, namaTeknisiList) => {

        db.all(`
            SELECT UPPER(TRIM(sto)) as sto 
            FROM users 
            WHERE sto IS NOT NULL 
            AND TRIM(sto) != ''
            AND UPPER(TRIM(sto)) != 'ALL'
            GROUP BY UPPER(TRIM(sto))
            ORDER BY sto ASC
        `, (errSto, stoRows) => {
            res.render('teknisi/input_bast', { 
                namaTeknisiList : namaTeknisiList || [], 
                stoList         : stoRows || []
            });
        });
    });
});

// =====================================================================
// FIX UTAMA: Route POST /teknisi/submit
// Root penyebab data perangkat kosong:
//   Form HTML mengirim field bernama "snlama[]", "snbaru[]", dll.
//   express.urlencoded mem-parse ini menjadi req.body['snlama[]'] (dengan tanda kurung).
//   Kode lama sudah handle ini dengan benar, TAPI jika form input_bast.ejs
//   memakai name="snlama" (tanpa []) maka hanya satu nilai yang masuk sebagai string.
//   Fix ini menangani KEDUA kemungkinan nama field.
// =====================================================================
app.post('/teknisi/submit', upload.array('eviden', 10), (req, res) => { 
    try {
        const data = req.body;

        // Log untuk debug — bisa dihapus setelah konfirmasi berjalan
        console.log('=== TEKNISI SUBMIT - req.body keys ===');
        console.log(Object.keys(data));
        console.log('snlama[]  :', data['snlama[]']);
        console.log('snlama    :', data['snlama']);
        console.log('snbaru[]  :', data['snbaru[]']);
        console.log('noinet[]  :', data['noinet[]']);
        console.log('kondisi[] :', data['kondisi[]']);

        const randomStr = crypto.randomBytes(3).toString('hex').toUpperCase();
        const kodeUnik  = `BAST-${randomStr}`;

        // Simpan TTD teknisi
        const ttdPath = `uploads/ttd/ttd_teknisi_${kodeUnik}.png`;
        if (data.ttdPemberiBase64) {
            fs.writeFileSync(
                ttdPath,
                data.ttdPemberiBase64.replace(/^data:image\/png;base64,/, ""),
                'base64'
            );
        }

        // ================================================================
        // PERBAIKAN: Coba ambil field dengan nama bracket dulu,
        // fallback ke nama tanpa bracket (untuk kompatibilitas dua jenis form)
        // ================================================================
        const toArray = (val) => {
            if (!val) return [];
            return Array.isArray(val) ? val : [val];
        };

        const snlamaArr  = toArray(data['snlama[]']  || data['snlama']);
        const snbaruArr  = toArray(data['snbaru[]']  || data['snbaru']);
        const noinetArr  = toArray(data['noinet[]']  || data['noinet']);
        const kondisiArr = toArray(data['kondisi[]'] || data['kondisi']);

        console.log('=== Array setelah parse ===');
        console.log('snlama :', snlamaArr);
        console.log('snbaru :', snbaruArr);
        console.log('noinet :', noinetArr);

        let perangkatArray = [];
        for (let i = 0; i < snlamaArr.length; i++) {
            // Skip baris yang benar-benar kosong
            if (!snlamaArr[i] && !snbaruArr[i] && !noinetArr[i]) continue;
            perangkatArray.push({
                snlama  : snlamaArr[i]  || '',
                snbaru  : snbaruArr[i]  || '',
                noinet  : noinetArr[i]  || '',
                kondisi : kondisiArr[i] || 'Baik'
            });
        }

        console.log('=== perangkatArray final ===', JSON.stringify(perangkatArray));

        let evidenArray = req.files ? req.files.map(file => file.path) : [];

        // Parse teknisi dari select
        let nik = "", nama = "";
        if (data.teknisi_select) {
            const teknisiSplit = data.teknisi_select.split(' | ');
            nik  = teknisiSplit[0] || '';
            nama = teknisiSplit[1] || '';
        }

        const sql = `INSERT INTO bast_data 
            (kode_unik, status, tanggal, loksto, teknisi_nama, teknisi_nik, perangkat_json, eviden_json, ttd_teknisi) 
            VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`;

        db.run(sql, [
            kodeUnik,
            data.tanggal,
            data.loksto,
            nama,
            nik,
            JSON.stringify(perangkatArray),
            JSON.stringify(evidenArray),
            ttdPath
        ], function(err) {
            if (err) {
                console.error('DB insert error:', err.message);
                return res.status(500).json({ success: false, message: err.message });
            }
            console.log('BAST tersimpan:', kodeUnik, '| perangkat:', perangkatArray.length, 'item');
            res.json({ success: true, kodeUnik: kodeUnik });
        });

    } catch (error) {
        console.error('Submit error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ================= ROUTE WAREHOUSE =================
app.get('/wh/dashboard', checkRole('wh'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send(err.message);
        
        rows.forEach(row => {
            try { row.jumlah_perangkat = JSON.parse(row.perangkat_json || '[]').length; }
            catch(e) { row.jumlah_perangkat = 0; }
        });

        res.render('wh/dashboard', {
            pendingData   : rows.filter(r => r.status === 'PENDING'),
            completedData : rows.filter(r => r.status === 'COMPLETED'),
            rejectedData  : rows.filter(r => r.status === 'REJECTED'),
            username      : req.session.username
        });
    });
});

// =====================================================================
// FIX: Route WH sign — pastikan perangkat & eviden ter-parse dengan benar
// Tambah fallback jika perangkat_json null/rusak
// =====================================================================
app.get('/wh/sign/:kode', checkRole('wh'), (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row || row.status !== 'PENDING') return res.redirect('/wh/dashboard');

        // Parse perangkat — dengan logging untuk debug
        let perangkat = [];
        let eviden    = [];
        try {
            perangkat = JSON.parse(row.perangkat_json || '[]');
            console.log(`WH sign ${req.params.kode} - perangkat:`, JSON.stringify(perangkat));
        } catch(e) {
            console.error('Parse perangkat_json error:', e.message, '| raw:', row.perangkat_json);
        }
        try {
            eviden = JSON.parse(row.eviden_json || '[]');
        } catch(e) {
            console.error('Parse eviden_json error:', e.message);
        }

        row.perangkat = perangkat;
        row.eviden    = eviden;

        // Ambil nama & NIK WH dari session (sudah diset saat login)
        row.wh_nama_session = req.session.nama_lengkap || req.session.username;
        row.wh_nik_session  = req.session.nik || '-';

        res.render('wh/sign_bast', { 
            data     : row, 
            username : req.session.username
        });
    });
});

app.post('/wh/submit', checkRole('wh'), (req, res) => {
    const { kode_unik, ttdPenerimaBase64 } = req.body;
    const wh_nama = req.session.nama_lengkap;

    const ttdPath = `uploads/ttd/ttd_wh_${kode_unik}.png`;
    if (ttdPenerimaBase64) {
        fs.writeFileSync(
            ttdPath,
            ttdPenerimaBase64.replace(/^data:image\/png;base64,/, ""),
            'base64'
        );
    }
    db.run(
        `UPDATE bast_data SET wh_nama = ?, ttd_wh = ?, status = 'COMPLETED' WHERE kode_unik = ?`,
        [wh_nama, ttdPath, kode_unik],
        function(err) {
            if (err) console.error('WH submit error:', err.message);
            res.redirect('/bast/cetak/' + kode_unik);
        }
    );
});

app.post('/wh/reject/:kodeUnik', checkRole('wh'), (req, res) => {
    const { kodeUnik } = req.params;
    const { alasan }   = req.body; 
    db.run(
        "UPDATE bast_data SET status = 'REJECTED', alasan_tolak = ? WHERE kode_unik = ?", 
        [alasan, kodeUnik], 
        function(err) {
            if (err) console.error('Gagal reject BAST:', err.message);
            res.redirect('/wh/dashboard');
        }
    );
});

// ================= ROUTE CETAK PDF =================
app.get('/bast/cetak/:kode', isAuth, (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row) return res.send("Data tidak ditemukan");
        try { row.perangkat = JSON.parse(row.perangkat_json || '[]'); } catch(e) { row.perangkat = []; }
        try { row.eviden    = JSON.parse(row.eviden_json    || '[]'); } catch(e) { row.eviden    = []; }
        res.render('cetak_bast', { data: row }); 
    });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const xlsx = require('xlsx');

// ================= ROUTE EXPORT EXCEL =================
app.get('/admin/export/excel', isAuth, (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send("Database error");
        
        let exportData = [];
        rows.forEach(row => {
            let perangkat = [];
            try { perangkat = JSON.parse(row.perangkat_json || '[]'); } catch(e){}
            
            if (perangkat.length === 0) {
                exportData.push({
                    "Kode BAST"   : row.kode_unik,
                    "Tanggal"     : row.tanggal,
                    "Lokasi STO"  : row.loksto,
                    "Teknisi"     : row.teknisi_nama,
                    "Penerima WH" : row.wh_nama || '-',
                    "Status"      : row.status,
                    "SN Lama"     : "-",
                    "SN Baru"     : "-",
                    "No Internet" : "-",
                    "Kondisi"     : "-",
                    "Alasan Tolak": row.alasan_tolak || '-'
                });
            } else {
                perangkat.forEach(p => {
                    exportData.push({
                        "Kode BAST"   : row.kode_unik,
                        "Tanggal"     : row.tanggal,
                        "Lokasi STO"  : row.loksto,
                        "Teknisi"     : row.teknisi_nama,
                        "Penerima WH" : row.wh_nama || '-',
                        "Status"      : row.status,
                        "SN Lama"     : p.snlama  || '-',
                        "SN Baru"     : p.snbaru  || '-',
                        "No Internet" : p.noinet  || '-',
                        "Kondisi"     : p.kondisi || '-',
                        "Alasan Tolak": row.alasan_tolak || '-'
                    });
                });
            }
        });

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, "Data BAST");
        
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Laporan_BAST_Telkom.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

// ================= ROUTE REPORT MIGRASI NTE =================
const multerReport = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, 'uploads/'),
        filename:    (req, file, cb) => cb(null, 'report_' + Date.now() + path.extname(file.originalname))
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('spreadsheetml') || file.originalname.endsWith('.xlsx')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file .xlsx yang diizinkan'));
        }
    }
});

app.get('/admin/report', checkRole('admin'), (req, res) => {
    db.all("SELECT nik, nama_lengkap FROM users WHERE role = 'teknisi' AND nik IS NOT NULL AND nik != ''", (err, teknisiList) => {
        res.render('admin/report', {
            username    : req.session.username,
            teknisiList : teknisiList || []
        });
    });
});

app.post('/admin/report/proses', checkRole('admin'), multerReport.single('excelFile'), (req, res) => {
    if (!req.file) return res.json({ success: false, message: 'File tidak ditemukan' });
    
    try {
        const xlsxLib = require('xlsx');
        const wb      = xlsxLib.readFile(req.file.path);
        const ws      = wb.Sheets[wb.SheetNames[0]];
        const rawData = xlsxLib.utils.sheet_to_json(ws, { header: 1, defval: '' });
        
        if (rawData.length < 2) return res.json({ success: false, message: 'Data Excel kosong' });
        
        const headers = rawData[0];
        const colIndex = {};
        headers.forEach((h, i) => {
            if (h) colIndex[String(h).trim().toLowerCase()] = i;
        });
        
        db.all("SELECT nik, nama_lengkap FROM users WHERE role = 'teknisi'", (err, teknisiDB) => {
            const nikMap = {};
            teknisiDB.forEach(t => {
                if (t.nik) nikMap[String(t.nik).trim()] = t.nama_lengkap || t.nik;
            });
            
            db.all("SELECT perangkat_json FROM bast_data WHERE status IN ('COMPLETED', 'PENDING')", (err2, bastRows) => {
                const noinetSet = new Set();
                bastRows.forEach(row => {
                    try {
                        const items = JSON.parse(row.perangkat_json || '[]');
                        items.forEach(item => {
                            if (item.noinet) noinetSet.add(String(item.noinet).trim());
                        });
                    } catch(e) {}
                });
                
                const processedRows = [];
                const pivot         = {};
                
                for (let i = 1; i < rawData.length; i++) {
                    const row = rawData[i];
                    if (!row || row.every(c => c === '')) continue;
                    
                    const getCol = (name) => {
                        const idx = colIndex[name];
                        return idx !== undefined ? String(row[idx] || '').trim() : '';
                    };
                    
                    const serviceArea = getCol('service_area');
                    const idSto       = getCol('id_sto');
                    const status      = getCol('status').toLowerCase();
                    const nik         = getCol('nik');
                    const noInet      = getCol('no_inet');
                    
                    const namateknisi  = nik ? (nikMap[nik] || '') : '';
                    const statusKembali = noInet && noinetSet.has(noInet) ? 'SUDAH' : 'BELUM';
                    
                    const newRow = [...row];
                    newRow[51] = namateknisi;
                    newRow[52] = statusKembali;
                    processedRows.push(newRow);
                    
                    if (serviceArea && idSto) {
                        if (!pivot[serviceArea]) pivot[serviceArea] = {};
                        if (!pivot[serviceArea][idSto]) pivot[serviceArea][idSto] = { assign:0, close:0, kendala:0, open:0, total:0 };
                        const p = pivot[serviceArea][idSto];
                        p.total++;
                        if      (status === 'assign' || status === 'asign') p.assign++;
                        else if (status === 'close')   p.close++;
                        else if (status === 'kendala') p.kendala++;
                        else if (status === 'open')    p.open++;
                    }
                }
                
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                
                res.json({
                    success  : true,
                    headers  : headers,
                    rows     : processedRows,
                    pivot    : pivot,
                    summary  : {
                        total : processedRows.length,
                        sudah : processedRows.filter(r => r[52] === 'SUDAH').length,
                        belum : processedRows.filter(r => r[52] === 'BELUM').length
                    }
                });
            });
        });
        
    } catch(e) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch(e2) {}
        res.json({ success: false, message: 'Gagal baca Excel: ' + e.message });
    }
});

app.post('/admin/report/download', checkRole('admin'), (req, res) => {
    try {
        const xlsxLib = require('xlsx');
        const { headers, rows } = req.body;
        
        const wsData = [headers, ...rows];
        const wb = xlsxLib.utils.book_new();
        const ws = xlsxLib.utils.aoa_to_sheet(wsData);
        
        xlsxLib.utils.book_append_sheet(wb, ws, 'MIGRASI NTE');
        const buffer = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', `attachment; filename="Report_Migrasi_${new Date().toISOString().slice(0,10)}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch(e) {
        res.status(500).send('Gagal generate Excel: ' + e.message);
    }
});

app.listen(3000, () => console.log('Server berjalan di http://localhost:3000'));