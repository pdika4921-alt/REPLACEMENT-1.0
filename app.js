const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); 
const session = require('express-session');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

// === AUTO-CREATE DATABASE & AKUN ADMIN, TEKNISI, WH ===
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT)`);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', 'admin123', 'admin')`);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('teknisi', '123', 'teknisi')`);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('warehouse', '123', 'wh')`);
    db.run(`CREATE TABLE IF NOT EXISTS nama_teknisi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nik TEXT,
        nama TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bast_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kode_unik TEXT UNIQUE, status TEXT,
        tanggal TEXT, loksto TEXT, teknisi_nama TEXT, teknisi_nik TEXT, wh_nama TEXT,
        perangkat_json TEXT, eviden_json TEXT, ttd_teknisi TEXT, ttd_wh TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// TAMBAHKAN INI: Untuk menambahkan kolom alasan_tolak jika belum ada
db.run("ALTER TABLE bast_data ADD COLUMN alasan_tolak TEXT", (err) => {
    // Abaikan error jika kolom sudah ada
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

// ================= ROUTE LOGIN =================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (user) {
            req.session.loggedIn = true; req.session.role = user.role; req.session.username = user.username;
            if (user.role === 'admin') res.redirect('/admin/dashboard');
            else if (user.role === 'teknisi') res.redirect('/teknisi/dashboard');
            else res.redirect('/wh/dashboard');
        } else {
            res.render('login', { error: 'Username atau Password salah!' });
        }
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ================= ROUTE ADMIN =================
app.get('/admin/dashboard', checkRole('admin'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        db.all("SELECT * FROM users WHERE role = 'teknisi'", (err, teknisiList) => {
            db.all("SELECT * FROM nama_teknisi ORDER BY nama ASC", (err, namaTeknisiList) => {
                let groupedRekap = {};
                let snMaster = {};
                
                rows.forEach(row => {
                    if (row.perangkat_json) {
                        try {
                            let items = JSON.parse(row.perangkat_json);
                            items.forEach(item => {
                                let penyetor = row.teknisi_nama || 'Tanpa Nama';
                                if (!groupedRekap[penyetor]) groupedRekap[penyetor] = [];
                                groupedRekap[penyetor].push({
                                    kode_unik: row.kode_unik, tanggal: row.tanggal, loksto: row.loksto,
                                    penerima: row.wh_nama || '-', sn_lama: item.snlama, sn_baru: item.snbaru,
                                    no_inet: item.noinet, kondisi: item.kondisi, status: row.status
                                });
                                if (item.snlama && snMaster[item.snlama] !== 'COMPLETED') {
                                    snMaster[item.snlama] = row.status;
                                }
                            });
                        } catch(e){}
                    }
                });

                // === KODE BARU: Siapkan rejectedData untuk dikirim ke Admin ===
                const rejectedData = rows.filter(r => r.status === 'REJECTED');
                rejectedData.forEach(row => {
                    try {
                        row.jumlah_perangkat = JSON.parse(row.perangkat_json || '[]').length;
                    } catch(e) { row.jumlah_perangkat = 0; }
                });
                // ==============================================================

                res.render('admin/dashboard', { 
                    bastData: rows, 
                    teknisiList, 
                    groupedRekap, 
                    snMaster,
                    namaTeknisiList,
                    rejectedData: rejectedData, // <--- Menambahkan data yang ditolak ke EJS
                    username: req.session.username 
                });
            });
        });
    });
});

// Admin Tambah User Teknisi
app.post('/admin/user/add', checkRole('admin'), (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, 'teknisi')", [username, password], (err) => {
        if (err) return res.send("<script>alert('Username sudah terdaftar!'); window.location='/admin/dashboard';</script>");
        res.redirect('/admin/dashboard');
    });
});

// Admin Hapus User Teknisi
app.get('/admin/user/delete/:id', checkRole('admin'), (req, res) => {
    db.run("DELETE FROM users WHERE id = ? AND role = 'teknisi'", [req.params.id], () => {
        res.redirect('/admin/dashboard');
    });
});

// Admin Tambah Nama Teknisi di Dropdown
app.post('/admin/teknisi/add', checkRole('admin'), (req, res) => {
    const { nik, nama } = req.body;
    db.run("INSERT INTO nama_teknisi (nik, nama) VALUES (?, ?)", [nik, nama.toUpperCase()], (err) => {
        res.redirect('/admin/dashboard');
    });
});

// Admin Hapus Nama Teknisi dari Dropdown
app.get('/admin/teknisi/delete/:id', checkRole('admin'), (req, res) => {
    db.run("DELETE FROM nama_teknisi WHERE id = ?", [req.params.id], () => {
        res.redirect('/admin/dashboard');
    });
});

// ================= ROUTE TEKNISI =================
app.get('/teknisi/dashboard', checkRole('teknisi'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => res.render('teknisi/dashboard', { data: rows }));
});

app.get('/teknisi/input', checkRole('teknisi'), (req, res) => {
    db.all("SELECT * FROM nama_teknisi ORDER BY nama ASC", (err, namaTeknisiList) => {
        res.render('teknisi/input_bast', { namaTeknisiList });
    });
});

app.post('/teknisi/submit', upload.array('eviden', 10), (req, res) => { 
    try {
        const data = req.body;
        const randomStr = crypto.randomBytes(3).toString('hex').toUpperCase();
        const kodeUnik = `BAST-${randomStr}`;

        const ttdPath = `uploads/ttd/ttd_teknisi_${kodeUnik}.png`;
        if (data.ttdPemberiBase64) {
            fs.writeFileSync(ttdPath, data.ttdPemberiBase64.replace(/^data:image\/png;base64,/, ""), 'base64');
        }

        let perangkatArray = [];
        if (Array.isArray(data.snlama)) {
            for(let i=0; i<data.snlama.length; i++) {
                perangkatArray.push({ snlama: data.snlama[i], snbaru: data.snbaru[i], noinet: data.noinet[i], kondisi: data.kondisi[i] });
            }
        } else if (data.snlama) {
            perangkatArray.push({ snlama: data.snlama, snbaru: data.snbaru, noinet: data.noinet, kondisi: data.kondisi });
        }

        let evidenArray = req.files ? req.files.map(file => file.path) : [];
        let nik = "", nama = "";
        if(data.teknisi_select) {
            const teknisiSplit = data.teknisi_select.split(' | ');
            nik = teknisiSplit[0]; nama = teknisiSplit[1];
        }

        const sql = `INSERT INTO bast_data (kode_unik, status, tanggal, loksto, teknisi_nama, teknisi_nik, perangkat_json, eviden_json, ttd_teknisi) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [kodeUnik, data.tanggal, data.loksto, nama, nik, JSON.stringify(perangkatArray), JSON.stringify(evidenArray), ttdPath], function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, kodeUnik: kodeUnik });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ================= ROUTE WAREHOUSE =================

// GET Dashboard WH — tampilkan PENDING, COMPLETED, dan REJECTED
app.get('/wh/dashboard', checkRole('wh'), (req, res) => {
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send(err.message);
        
        // Hitung jumlah perangkat per BAST
        rows.forEach(row => {
            try {
                row.jumlah_perangkat = JSON.parse(row.perangkat_json || '[]').length;
            } catch(e) { row.jumlah_perangkat = 0; }
        });

        // Pisahkan data berdasarkan status
        const pendingRows = rows.filter(r => r.status === 'PENDING');
        const completedRows = rows.filter(r => r.status === 'COMPLETED');
        const rejectedRows = rows.filter(r => r.status === 'REJECTED'); // Tambahan status ditolak

        res.render('wh/dashboard', {
            pendingData: pendingRows,
            completedData: completedRows,
            rejectedData: rejectedRows, // Kirim ke EJS
            username: req.session.username
        });
    });
});

// GET Halaman TTD
app.get('/wh/sign/:kode', checkRole('wh'), (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row || row.status !== 'PENDING') return res.redirect('/wh/dashboard');
        row.perangkat = JSON.parse(row.perangkat_json || '[]');
        row.eviden = JSON.parse(row.eviden_json || '[]');
        res.render('wh/sign_bast', { data: row, username: req.session.username });
    });
});

// POST Submit TTD WH (Approve)
app.post('/wh/submit', checkRole('wh'), (req, res) => {
    const { kode_unik, wh_nama, ttdPenerimaBase64 } = req.body;
    const ttdPath = `uploads/ttd/ttd_wh_${kode_unik}.png`;
    if (ttdPenerimaBase64) {
        fs.writeFileSync(ttdPath, ttdPenerimaBase64.replace(/^data:image\/png;base64,/, ""), 'base64');
    }
    db.run(
        `UPDATE bast_data SET wh_nama = ?, ttd_wh = ?, status = 'COMPLETED' WHERE kode_unik = ?`,
        [wh_nama, ttdPath, kode_unik],
        function(err) { res.redirect('/bast/cetak/' + kode_unik); }
    );
});

// POST Tolak (Reject) BAST oleh WH (Hanya ubah status, TIDAK dihapus)
app.post('/wh/reject/:kodeUnik', checkRole('wh'), (req, res) => {
    const { kodeUnik } = req.params;
    const { alasan } = req.body; 

    db.run(
        "UPDATE bast_data SET status = 'REJECTED', alasan_tolak = ? WHERE kode_unik = ?", 
        [alasan, kodeUnik], 
        function(err) {
            if (err) console.error('Gagal update reject BAST:', err.message);
            res.redirect('/wh/dashboard');
        }
    );
});

// ================= ROUTE CETAK PDF =================
app.get('/bast/cetak/:kode', isAuth, (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row) return res.send("Data tidak ditemukan");
        row.perangkat = JSON.parse(row.perangkat_json || '[]');
        row.eviden = JSON.parse(row.eviden_json || '[]');
        res.render('cetak_bast', { data: row }); 
    });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const xlsx = require('xlsx');

// ================= ROUTE EXPORT EXCEL REKAP ONT =================
app.get('/admin/export/rekap-ont', isAuth, (req, res) => {
    // Ambil data BAST dari database
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send("Database error");
        
        let exportData = [];
        
        // Looping setiap baris BAST
        rows.forEach(row => {
            let perangkat = [];
            try { 
                perangkat = JSON.parse(row.perangkat_json || '[]'); 
            } catch(e) {}
            
            // Ekstrak data ONT saja ke dalam Excel
            perangkat.forEach(p => {
                exportData.push({
                    "Nama Teknisi": row.teknisi_nama || '-',
                    "Tanggal BAST": row.tanggal || '-',
                    "Lokasi STO": row.loksto || '-',
                    "Kode BAST": row.kode_unik || '-',
                    "SN Lama (Rusak)": p.snlama || '-',
                    "SN Baru (Pengganti)": p.snbaru || '-',
                    "No Internet": p.noinet || '-',
                    "Kondisi": p.kondisi || '-',
                    "Status WH": row.status || '-'
                });
            });
        });

        // Buat file Excel
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        
        // Rapikan lebar kolom Excel
        ws['!cols'] = [
            { wch: 25 }, // Teknisi
            { wch: 15 }, // Tanggal
            { wch: 10 }, // STO
            { wch: 15 }, // Kode BAST
            { wch: 25 }, // SN Lama
            { wch: 25 }, // SN Baru
            { wch: 20 }, // No Inet
            { wch: 15 }, // Kondisi
            { wch: 15 }  // Status
        ];

        xlsx.utils.book_append_sheet(wb, ws, "Rekap_ONT_Teknisi");
        
        // Kirim response file Excel untuk didownload
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Rekap_ONT_Per_Teknisi.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

app.listen(3000, () => console.log('Server berjalan di http://localhost:3000'));