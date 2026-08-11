const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); 
const session = require('express-session');
const AdmZip = require('adm-zip');
const { buatPdfBast } = require('./buatPdfBast');

const app = express();

// ===== KEAMANAN PASSWORD (scrypt — tanpa dependency tambahan) =====
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// === PERSISTENT VOLUME (Railway) ===
const dbDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new sqlite3.Database(path.join(dbDir, 'database.sqlite'));

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
    db.run(`ALTER TABLE users ADD COLUMN service_area TEXT`, () => {});

    // Set kredensial admin: username 'admin_replacement', password 'branchbekasi2026'
    db.run(`UPDATE users SET username = 'admin_replacement' WHERE username = 'admin' AND role = 'admin'`, () => {});
    db.run(`UPDATE users SET password = ? WHERE username = 'admin_replacement'`, [hashPassword('branchbekasi2026')], () => {});
    db.run(`INSERT OR IGNORE INTO users (username, password, role, nama_lengkap, nik, sto)
            VALUES ('admin_replacement', ?, 'admin', 'Administrator', '00000000', 'ALL')`, [hashPassword('branchbekasi2026')], () => {});
    db.run(`INSERT OR IGNORE INTO users (username, password, role, nama_lengkap, nik, sto)
            VALUES ('teknisi', '123', 'teknisi', 'Teknisi Demo', '99999999', 'SUKMAJAYA')`, () => {});
    
    db.run(`CREATE TABLE IF NOT EXISTS bast_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kode_unik TEXT UNIQUE, status TEXT,
        tanggal TEXT, loksto TEXT, teknisi_nama TEXT, teknisi_nik TEXT, wh_nama TEXT,
        perangkat_json TEXT, eviden_json TEXT, ttd_teknisi TEXT, ttd_wh TEXT,
        alasan_tolak TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrasi defensif untuk database lama
    db.run(`ALTER TABLE bast_data ADD COLUMN alasan_tolak TEXT`, () => {});
    db.run(`ALTER TABLE bast_data ADD COLUMN approval_checklist TEXT`, () => {});
    db.run(`ALTER TABLE bast_data ADD COLUMN wh_nik TEXT`, () => {});
    db.run(`ALTER TABLE bast_data ADD COLUMN approved_at TEXT`, () => {});

    // Tabel audit log
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        waktu TEXT DEFAULT (datetime('now','localtime')),
        username TEXT,
        role TEXT,
        aksi TEXT,
        detail TEXT
    )`);

    // ===== Migrasi keamanan: hash semua password yang masih plaintext =====
    db.all("SELECT id, password FROM users", (errMig, rows) => {
        if (errMig || !rows) return;
        rows.forEach(r => {
            if (r.password && !String(r.password).startsWith('scrypt$')) {
                db.run("UPDATE users SET password = ? WHERE id = ?", [hashPassword(r.password), r.id]);
            }
        });
        console.log('[SECURITY] Migrasi password selesai.');
    });
});

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.json({ limit: '200mb' })); 

app.use(session({ secret: 'telkom_secret', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));

const uploadBase = path.join(dbDir, 'uploads');
const dirs = [
  path.join(uploadBase, 'eviden'),
  path.join(uploadBase, 'ttd'),
  path.join(uploadBase, 'dokumen_bast')
];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

// ✅ FIX 1 — multer upload eviden
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(uploadBase, 'eviden/')),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }) 
});

// ===== SESSION IDLE TIMEOUT (30 menit) =====
const IDLE_TIMEOUT = 30 * 60 * 1000;
function touchSession(req) {
    const now = Date.now();
    if (req.session && req.session.lastActive && (now - req.session.lastActive > IDLE_TIMEOUT)) {
        req.session.destroy();
        return false;
    }
    if (req.session) req.session.lastActive = now;
    return true;
}

// ===== AUDIT LOG =====
function logAudit(req, aksi, detail) {
    const username = (req && req.session && req.session.username) || 'anonymous';
    const role     = (req && req.session && req.session.role) || '-';
    db.run("INSERT INTO audit_log (username, role, aksi, detail) VALUES (?, ?, ?, ?)",
        [username, role, aksi, detail || ''], () => {});
}

const checkRole = (role) => (req, res, next) => {
    if (!touchSession(req)) return res.redirect('/login');
    if (req.session.loggedIn && req.session.role === role) next();
    else res.redirect('/login');
};
const isAuth = (req, res, next) => {
    if (!touchSession(req)) return res.redirect('/login');
    if (req.session.loggedIn) next();
    else res.redirect('/login');
};

// ===== KEAMANAN PASSWORD (scrypt) =====
function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return 'scrypt$' + salt + '$' + hash.toString('hex');
}

function verifyPassword(pw, stored) {
    if (!stored) return false;
    if (String(stored).startsWith('scrypt$')) {
        const parts = String(stored).split('$');
        if (parts.length !== 3) return false;
        const salt = parts[1];
        const expected = Buffer.from(parts[2], 'hex');
        const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
        const actual = Buffer.from(hash.toString('hex'), 'hex');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    // Legacy plaintext (dari DB lama) — verifikasi lalu segera di-hash di migrasi
    return stored === String(pw);
}

// ===== RATE LIMITER LOGIN (cegah brute-force) =====
const loginAttempts = {};
const RATE = { max: 5, lockMs: 5 * 60 * 1000 };
function isLocked(username, ip) {
    const a = loginAttempts[username + '|' + ip];
    if (!a) return false;
    if (a.lockedUntil && a.lockedUntil > Date.now()) return true;
    if (a.lockedUntil && a.lockedUntil <= Date.now()) { delete loginAttempts[username + '|' + ip]; return false; }
    return false;
}
function registerFail(username, ip) {
    const key = username + '|' + ip;
    const a = loginAttempts[key] || { count: 0, lockedUntil: 0 };
    a.count++;
    if (a.count >= RATE.max) { a.lockedUntil = Date.now() + RATE.lockMs; a.count = 0; }
    loginAttempts[key] = a;
}
function clearAttempts(username, ip) { delete loginAttempts[username + '|' + ip]; }

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
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if (isLocked(username, ip)) {
        logAudit(req, 'LOGIN_BLOKIR', username);
        return res.render('login', { error: 'Terlalu banyak percobaan. Akun diblokir sementara (5 menit).' });
    }
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && verifyPassword(password, user.password)) {
            clearAttempts(username, ip);
            req.session.loggedIn     = true;
            req.session.role         = user.role;
            req.session.username     = user.username;
            req.session.nama_lengkap = user.nama_lengkap || user.username;
            req.session.nik          = user.nik || '';
            req.session.sto          = user.sto || '';
            req.session.service_area = user.service_area || '';
            logAudit(req, 'LOGIN', username);

            if (user.role === 'admin')        res.redirect('/admin/dashboard');
            else if (user.role === 'teknisi') res.redirect('/teknisi/dashboard');
            else                              res.redirect('/wh/dashboard');
        } else {
            registerFail(username, ip);
            logAudit(req, 'LOGIN_GAGAL', username);
            res.render('login', { error: 'Username atau Password salah!' });
        }
    });
});

app.get('/logout', (req, res) => {
    logAudit(req, 'LOGOUT', '');
    req.session.destroy();
    res.redirect('/login');
});

// ================= UBAH PASSWORD (teknisi / WH / admin) =================
app.post('/change-password', isAuth, (req, res) => {
    const { old_password, new_password } = req.body;
    const username = req.session.username;

    if (!new_password || !String(new_password).trim()) {
        return res.json({ success: false, message: 'Password baru wajib diisi.' });
    }

    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err || !user) return res.json({ success: false, message: 'Akun tidak ditemukan.' });
        if (!verifyPassword(old_password || '', user.password)) {
            return res.json({ success: false, message: 'Password lama salah.' });
        }
        db.run("UPDATE users SET password = ? WHERE username = ?", [hashPassword(String(new_password)), username], (e) => {
            if (e) return res.json({ success: false, message: 'Gagal mengubah password.' });
            res.json({ success: true, message: 'Password berhasil diubah.' });
        });
    });
});

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

// Bulk Add Users
app.post('/admin/user/bulk-add', checkRole('admin'), async (req, res) => {
    const { users } = req.body; // Array of objects
    if (!users || !Array.isArray(users) || users.length === 0) {
        return res.json({ success: false, message: 'Data tidak valid atau kosong.' });
    }

    let successCount = 0;
    let failCount = 0;
    let errors = [];

    const processUsers = users.map(u => {
        return new Promise((resolve) => {
            const role = String(u.role || 'teknisi').toLowerCase().trim();
            const safeRole = (role === 'wh' || role === 'warehouse') ? 'wh' : 'teknisi';
            const hashedPw = hashPassword(String(u.password || '123456'));
            const username = String(u.nik || '').trim();

            if (!username) {
                failCount++;
                errors.push("NIK kosong");
                return resolve();
            }

            db.run(
                "INSERT INTO users (username, password, role, nama_lengkap, nik, sto, service_area) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [username, hashedPw, safeRole, u.nama_lengkap || '', username, u.sto || '', u.service_area || ''],
                (err) => {
                    if (err) {
                        failCount++;
                        errors.push(`${username}: ${err.message}`);
                    } else {
                        successCount++;
                    }
                    resolve();
                }
            );
        });
    });

    await Promise.all(processUsers);
    logAudit(req, 'BULK_ADD_USER', `Success: ${successCount}, Fail: ${failCount}`);
    res.json({ 
        success: true, 
        message: `${successCount} akun berhasil ditambahkan. ${failCount} gagal.`,
        errors: errors.slice(0, 10) // Tampilkan 10 error pertama saja
    });
});

app.post('/admin/user/add', checkRole('admin'), (req, res) => {
    const { username, password, role, nama_lengkap, nik, sto, service_area } = req.body;
    const safeRole = (role === 'wh') ? 'wh' : 'teknisi';
    const hashedPw = hashPassword(password || '');
    db.run(
        "INSERT INTO users (username, password, role, nama_lengkap, nik, sto, service_area) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [username, hashedPw, safeRole, nama_lengkap || '', nik || '', sto || '', service_area || ''],
        (err) => {
            if (err) return res.send("<script>alert('Username atau NIK sudah terdaftar!'); window.location='/admin/dashboard';</script>");
            logAudit(req, 'ADD_USER', username + ' (' + safeRole + ')');
            res.redirect('/admin/dashboard');
        }
    );
});

// Update akun teknisi/WH (nama, STO, service area)
app.post('/admin/user/update', checkRole('admin'), (req, res) => {
    const { id, nama_lengkap, sto, service_area } = req.body;
    if (!id) return res.json({ success: false, message: 'ID akun wajib diisi.' });
    db.run("UPDATE users SET nama_lengkap = ?, sto = ?, service_area = ? WHERE id = ? AND role IN ('teknisi','wh')",
        [nama_lengkap || '', sto || '', service_area || '', id], (e) => {
            if (e) return res.json({ success: false, message: e.message });
            logAudit(req, 'UPDATE_USER', 'id=' + id);
            res.json({ success: true, message: 'Akun berhasil diperbarui.' });
        });
});

// Reset password akun teknisi/WH oleh admin
app.post('/admin/user/reset', checkRole('admin'), (req, res) => {
    const { id, new_password } = req.body;
    if (!id || !new_password || String(new_password).length < 4) {
        return res.json({ success: false, message: 'Password minimal 4 karakter.' });
    }
    db.run("UPDATE users SET password = ? WHERE id = ? AND role IN ('teknisi','wh')",
        [hashPassword(String(new_password)), id], (e) => {
            if (e) return res.json({ success: false, message: e.message });
            logAudit(req, 'RESET_PW', 'id=' + id);
            res.json({ success: true, message: 'Password berhasil direset.' });
        });
});

// Backup database
app.get('/admin/backup', checkRole('admin'), (req, res) => {
    const file = path.join(dbDir, 'database.sqlite');
    if (!fs.existsSync(file)) return res.status(404).send('Database tidak ditemukan');
    logAudit(req, 'BACKUP', '');
    res.download(file, 'backup_database_' + new Date().toISOString().slice(0, 10) + '.sqlite');
});

app.get('/admin/user/delete/:id', checkRole('admin'), (req, res) => {
    db.get("SELECT username, role FROM users WHERE id = ?", [req.params.id], (e, u) => {
        db.run("DELETE FROM users WHERE id = ? AND role IN ('teknisi','wh')", [req.params.id], () => {
            logAudit(req, 'DELETE_USER', (u ? (u.username + ' (' + u.role + ')') : 'id=' + req.params.id));
            res.redirect('/admin/dashboard');
        });
    });
});

// Hapus massal akun teknisi/WH
app.post('/admin/user/bulk-delete', checkRole('admin'), (req, res) => {
    const ids = req.body.ids;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.json({ success: false, message: 'Tidak ada akun yang dipilih.' });
    }
    const numIds = ids.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id > 0);
    if (numIds.length === 0) {
        return res.json({ success: false, message: 'ID akun tidak valid.' });
    }
    const placeholders = numIds.map(() => '?').join(',');
    db.run(`DELETE FROM users WHERE id IN (${placeholders}) AND role IN ('teknisi','wh')`, numIds, function (e) {
        if (e) return res.json({ success: false, message: e.message });
        logAudit(req, 'BULK_DELETE_USER', 'id=' + numIds.join(','));
        res.json({ success: true, message: `${this.changes} akun berhasil dihapus.`, deleted: this.changes });
    });
});

// Hapus dokumen BAST oleh admin (termasuk file eviden & ttd terkait)
app.post('/admin/bast/delete/:kode', checkRole('admin'), (req, res) => {
    const kode = String(req.params.kode || '').trim();
    if (!kode) return res.json({ success: false, message: 'Kode BAST tidak valid.' });

    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [kode], (err0, row) => {
        if (err0) return res.json({ success: false, message: err0.message });
        if (!row) return res.json({ success: false, message: 'Dokumen tidak ditemukan.' });

        const cleanup = () => {
            const files = [];
            try { JSON.parse(row.eviden_json || '[]').forEach(f => files.push(f)); } catch (e) {}
            if (row.ttd_teknisi) files.push(row.ttd_teknisi);
            if (row.ttd_wh) files.push(row.ttd_wh);
            files.forEach(f => {
                try {
                    const p = path.join(uploadBase, String(f).replace(/^uploads[\\/]/, ''));
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                } catch (e) {}
            });
        };

        db.run("DELETE FROM bast_data WHERE kode_unik = ?", [kode], (e) => {
            if (e) return res.json({ success: false, message: e.message });
            cleanup();
            logAudit(req, 'DELETE_BAST', kode);
            res.json({ success: true, message: 'Dokumen ' + kode + ' berhasil dihapus.' });
        });
    });
});

// Log aktivitas (admin)
app.get('/admin/audit', checkRole('admin'), (req, res) => {
    db.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200", (err, logs) => {
        res.render('admin/audit', { logs: logs || [], username: req.session.username });
    });
});

// ================= ROUTE TEKNISI =================
app.get('/teknisi/dashboard', checkRole('teknisi'), (req, res) => {
    const nik = String(req.session.nik || req.session.username || '').trim();
    db.all("SELECT * FROM bast_data WHERE teknisi_nik = ? ORDER BY id DESC", [nik], (err, rows) => {
        res.render('teknisi/dashboard', {
            data        : rows || [],
            username    : req.session.username,
            nama_lengkap: req.session.nama_lengkap || req.session.username
        });
    });
});

app.get('/teknisi/input', checkRole('teknisi'), (req, res) => {
    const teknisi = {
        nik: String(req.session.nik || req.session.username || '').trim(),
        nama: req.session.nama_lengkap || req.session.username
    };
    const stoTeknisi = String(req.session.sto || '').trim().toUpperCase();
    const stoList = stoTeknisi && stoTeknisi !== 'ALL' ? [{ sto: stoTeknisi }] : [];
    res.render('teknisi/input_bast', { teknisi, stoList });
});

// Batalkan BAST yang masih PENDING (hanya milik teknisi tsb)
app.post('/teknisi/cancel/:kode', checkRole('teknisi'), (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row) return res.redirect('/teknisi/dashboard');
        const nik = (req.session.nik || '').trim().toUpperCase();
        const nama = (req.session.nama_lengkap || '').trim().toUpperCase();
        const rowNik = String(row.teknisi_nik || '').trim().toUpperCase();
        const rowNama = String(row.teknisi_nama || '').trim().toUpperCase();
        const owner = (!nik && !nama) || (rowNik === nik) || (rowNama === nama);
        if (row.status === 'PENDING' && owner) {
            db.run("DELETE FROM bast_data WHERE kode_unik = ?", [req.params.kode], () => {
                logAudit(req, 'CANCEL_BAST', req.params.kode);
                res.redirect('/teknisi/dashboard');
            });
        } else {
            res.redirect('/teknisi/dashboard');
        }
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
app.post('/teknisi/submit', checkRole('teknisi'), upload.array('eviden', 10), (req, res) => { 
    try {
        const data = req.body;
        const nik = String(req.session.nik || req.session.username || '').trim();
        const nama = req.session.nama_lengkap || req.session.username;
        const stoTeknisi = String(req.session.sto || '').trim().toUpperCase();

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
        // ✅ FIX 2 — di route /teknisi/submit
const ttdPath = path.join(uploadBase, 'ttd', `ttd_teknisi_${kodeUnik}.png`);
const ttdRelPath = path.join('uploads', 'ttd', `ttd_teknisi_${kodeUnik}.png`);
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

        let evidenArray = req.files ? req.files.map(file => path.join('uploads', 'eviden', path.basename(file.path))) : [];

        // ==== VALIDASI SERVER-SIDE =====
        if (!data.tanggal || !data.loksto) {
            return res.status(400).json({ success: false, message: 'Tanggal dan lokasi STO wajib diisi.' });
        }
        if (stoTeknisi && stoTeknisi !== 'ALL' && String(data.loksto || '').trim().toUpperCase() !== stoTeknisi) {
            return res.status(400).json({ success: false, message: 'Lokasi STO tidak sesuai dengan akun Anda.' });
        }
        if (perangkatArray.length === 0) {
            return res.status(400).json({ success: false, message: 'Minimal 1 perangkat wajib diisi.' });
        }
        if (perangkatArray.length > 10) {
            return res.status(400).json({ success: false, message: 'Maksimal 10 perangkat per BAST.' });
        }
        if (evidenArray.length > 10) {
            return res.status(400).json({ success: false, message: 'Maksimal 10 foto eviden.' });
        }
        // Cek SN duplikat
        const snSet = new Set();
        for (const p of perangkatArray) {
            const s = String(p.snlama || '').trim().toUpperCase();
            if (s && snSet.has(s)) {
                return res.status(400).json({ success: false, message: 'Ada SN Lama yang duplikat.' });
            }
            if (s) snSet.add(s);
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
            ttdRelPath
        ], function(err) {
            if (err) {
                console.error('DB insert error:', err.message);
                return res.status(500).json({ success: false, message: err.message });
            }
            console.log('BAST tersimpan:', kodeUnik, '| perangkat:', perangkatArray.length, 'item');
            logAudit(req, 'SUBMIT_BAST', kodeUnik + ' (' + perangkatArray.length + ' perangkat)');
            res.json({ success: true, kodeUnik: kodeUnik });
        });

    } catch (error) {
        console.error('Submit error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ================= ROUTE EDIT BAST TEKNISI =================
app.get('/teknisi/edit/:kode', checkRole('teknisi'), (req, res) => {
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [req.params.kode], (err, row) => {
        if (!row || row.status !== 'PENDING') return res.redirect('/teknisi/dashboard');
        const nik = (req.session.nik || '').trim().toUpperCase();
        const nama = (req.session.nama_lengkap || '').trim().toUpperCase();
        const rowNik = String(row.teknisi_nik || '').trim().toUpperCase();
        const rowNama = String(row.teknisi_nama || '').trim().toUpperCase();
        const owner = (!nik && !nama) || (rowNik === nik) || (rowNama === nama);
        if (!owner) return res.redirect('/teknisi/dashboard');
        let perangkat = [];
        let eviden = [];
        try { perangkat = JSON.parse(row.perangkat_json || '[]'); } catch (e) {}
        try { eviden = JSON.parse(row.eviden_json || '[]'); } catch (e) {}
        row.perangkat = perangkat;
        row.eviden = eviden;
        res.render('teknisi/edit_bast', {
            data        : row,
            username    : req.session.username,
            nama_lengkap: req.session.nama_lengkap || req.session.username
        });
    });
});

app.post('/teknisi/update/:kode', checkRole('teknisi'), upload.array('eviden', 10), (req, res) => {
    const kode = req.params.kode;
    const data = req.body;
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [kode], (err, row) => {
        if (!row || row.status !== 'PENDING') return res.status(400).json({ success: false, message: 'BAST tidak dapat diedit.' });
        const nik = (req.session.nik || '').trim().toUpperCase();
        const nama = (req.session.nama_lengkap || '').trim().toUpperCase();
        const rowNik = String(row.teknisi_nik || '').trim().toUpperCase();
        const rowNama = String(row.teknisi_nama || '').trim().toUpperCase();
        const owner = (!nik && !nama) || (rowNik === nik) || (rowNama === nama);
        if (!owner) return res.status(403).json({ success: false, message: 'Bukan pemilik BAST.' });

        const toArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
        const snlamaArr  = toArray(data['snlama[]']  || data['snlama']);
        const snbaruArr  = toArray(data['snbaru[]']  || data['snbaru']);
        const noinetArr  = toArray(data['noinet[]']  || data['noinet']);
        const kondisiArr = toArray(data['kondisi[]'] || data['kondisi']);

        let perangkatArray = [];
        for (let i = 0; i < snlamaArr.length; i++) {
            if (!snlamaArr[i] && !snbaruArr[i] && !noinetArr[i]) continue;
            perangkatArray.push({ snlama: snlamaArr[i] || '', snbaru: snbaruArr[i] || '', noinet: noinetArr[i] || '', kondisi: kondisiArr[i] || 'Baik' });
        }
        if (perangkatArray.length === 0) return res.status(400).json({ success: false, message: 'Minimal 1 perangkat wajib diisi.' });
        if (perangkatArray.length > 10) return res.status(400).json({ success: false, message: 'Maksimal 10 perangkat per BAST.' });

        const stoTeknisi = String(req.session.sto || '').trim().toUpperCase();
        if (stoTeknisi && stoTeknisi !== 'ALL' && String(data.loksto || '').trim().toUpperCase() !== stoTeknisi) {
            return res.status(400).json({ success: false, message: 'Lokasi STO tidak sesuai dengan akun Anda.' });
        }

        let newEviden;
        if (req.files && req.files.length > 0) {
            newEviden = req.files.map(f => path.join('uploads', 'eviden', path.basename(f.path)));
            if (newEviden.length > 10) return res.status(400).json({ success: false, message: 'Maksimal 10 foto eviden.' });
        } else {
            try { newEviden = JSON.parse(row.eviden_json || '[]'); } catch (e) { newEviden = []; }
        }
        if (!data.ttdPemberiBase64) return res.status(400).json({ success: false, message: 'Wajib tanda tangan ulang.' });

        const ttdPath = path.join(uploadBase, 'ttd', `ttd_teknisi_${kode}.png`);
        const ttdRelPath = path.join('uploads', 'ttd', `ttd_teknisi_${kode}.png`);
        try { fs.writeFileSync(ttdPath, data.ttdPemberiBase64.replace(/^data:image\/png;base64,/, ""), 'base64'); } catch (e) {}

        const tnik = String(req.session.nik || req.session.username || '').trim();
        const tnama = req.session.nama_lengkap || req.session.username;

        db.run(
            "UPDATE bast_data SET tanggal = ?, loksto = ?, teknisi_nama = ?, teknisi_nik = ?, perangkat_json = ?, eviden_json = ?, ttd_teknisi = ? WHERE kode_unik = ?",
            [data.tanggal, data.loksto, tnama, tnik, JSON.stringify(perangkatArray), JSON.stringify(newEviden), ttdRelPath, kode],
            (e) => {
                if (e) return res.status(500).json({ success: false, message: e.message });
                logAudit(req, 'UPDATE_BAST', kode);
                res.json({ success: true, message: 'BAST berhasil diperbarui.' });
            }
        );
    });
});

// ================= ROUTE WAREHOUSE =================
app.get('/wh/dashboard', checkRole('wh'), (req, res) => {
    const whSto = String(req.session.sto || '').trim().toUpperCase();
    const restricted = (whSto && whSto !== 'ALL') ? true : false;
    const q = restricted
        ? "SELECT * FROM bast_data WHERE UPPER(COALESCE(loksto,'')) = ? ORDER BY id DESC"
        : "SELECT * FROM bast_data ORDER BY id DESC";
    const params = restricted ? [whSto] : [];
    db.all(q, params, (err, rows) => {
        if (err) return res.status(500).send(err.message);
        
        rows.forEach(row => {
            try { row.jumlah_perangkat = JSON.parse(row.perangkat_json || '[]').length; }
            catch(e) { row.jumlah_perangkat = 0; }
        });

        const pending = rows.filter(r => r.status === 'PENDING')
            .sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')));

        res.render('wh/dashboard', {
            pendingData   : pending,
            completedData : rows.filter(r => r.status === 'COMPLETED'),
            rejectedData  : rows.filter(r => r.status === 'REJECTED'),
            username      : req.session.username,
            nama_lengkap  : req.session.nama_lengkap || req.session.username,
            whSto         : whSto || 'ALL'
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

        // Batasi akses sesuai STO milik WH
        const whSto = String(req.session.sto || '').trim().toUpperCase();
        if (whSto && whSto !== 'ALL' && String(row.loksto || '').trim().toUpperCase() !== whSto) {
            return res.redirect('/wh/dashboard');
        }

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
    const { kode_unik, ttdPenerimaBase64, checklist } = req.body;
    const wh_nama = req.session.nama_lengkap || req.session.username;
    const wh_nik  = String(req.session.nik || '').trim();

    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [kode_unik], (err, row) => {
        if (!row) return res.redirect('/wh/dashboard');

        // Wajib masih PENDING
        if (row.status !== 'PENDING') return res.redirect('/wh/dashboard');

        // Batasi akses sesuai STO milik WH
        const whSto = String(req.session.sto || '').trim().toUpperCase();
        if (whSto && whSto !== 'ALL' && String(row.loksto || '').trim().toUpperCase() !== whSto) {
            return res.redirect('/wh/dashboard');
        }

        // TTD wajib ada
        if (!ttdPenerimaBase64) {
            return res.render('wh/sign_bast', {
                data: Object.assign(row, { perangkat: parseJson(row.perangkat_json), eviden: parseJson(row.eviden_json), wh_nama_session: wh_nama, wh_nik_session: wh_nik }),
                username: req.session.username,
                error: 'Harap tanda tangani terlebih dahulu.'
            });
        }

        // Validasi checklist per ONT (verifikasi SN Lama)
        let checklistObj = {};
        if (checklist) {
            try { checklistObj = JSON.parse(checklist); } catch (e) { checklistObj = {}; }
        }
        let perangkat = [];
        try { perangkat = JSON.parse(row.perangkat_json || '[]'); } catch (e) { perangkat = []; }
        for (let i = 0; i < perangkat.length; i++) {
            const c = checklistObj[i] || {};
            if (perangkat[i].snlama && !c.snlama) {
                return res.redirect('/wh/sign/' + kode_unik);
            }
        }
        if (!perangkat.length) return res.redirect('/wh/sign/' + kode_unik);

        const ttdPath = path.join(uploadBase, 'ttd', `ttd_wh_${kode_unik}.png`);
        const ttdRelPath = path.join('uploads', 'ttd', `ttd_wh_${kode_unik}.png`);
        try {
            fs.writeFileSync(ttdPath, ttdPenerimaBase64.replace(/^data:image\/png;base64,/, ""), 'base64');
        } catch (e) {}

        const approvedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace('T', ' ');
        db.run(
            `UPDATE bast_data SET wh_nama = ?, wh_nik = ?, ttd_wh = ?, approval_checklist = ?, approved_at = ?, status = 'COMPLETED' WHERE kode_unik = ?`,
            [wh_nama, wh_nik, ttdRelPath, JSON.stringify(checklistObj), approvedAt, kode_unik],
            function(err) {
                if (err) console.error('WH submit error:', err.message);
                logAudit(req, 'APPROVE', kode_unik);
                res.redirect('/bast/cetak/' + kode_unik);
            }
        );
    });
});

function parseJson(s) {
    try { return JSON.parse(s || '[]'); } catch (e) { return []; }
}

app.post('/wh/reject/:kodeUnik', checkRole('wh'), (req, res) => {
    const { kodeUnik } = req.params;
    const { alasan }   = req.body;
    // Batasi akses sesuai STO milik WH
    const whSto = String(req.session.sto || '').trim().toUpperCase();
    db.get("SELECT * FROM bast_data WHERE kode_unik = ?", [kodeUnik], (err, row) => {
        if (!row) return res.redirect('/wh/dashboard');
        if (whSto && whSto !== 'ALL' && String(row.loksto || '').trim().toUpperCase() !== whSto) {
            return res.redirect('/wh/dashboard');
        }
        db.run(
            "UPDATE bast_data SET status = 'REJECTED', alasan_tolak = ? WHERE kode_unik = ?",
            [alasan, kodeUnik],
            function(err) {
                if (err) console.error('Gagal reject BAST:', err.message);
                logAudit(req, 'TOLAK', kodeUnik + ' | ' + (alasan || ''));
                res.redirect('/wh/dashboard');
            }
        );
    });
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

app.use('/uploads', express.static(uploadBase));

// ================= DOWNLOAD SEMUA PDF (ZIP) =================
app.get('/download/all-pdf', isAuth, (req, res) => {
    const role = req.session.role;
    if (role !== 'admin' && role !== 'wh') {
        return res.status(403).send('Akses ditolak.');
    }
    const whSto = String(req.session.sto || '').trim().toUpperCase();
    const restricted = (role === 'wh' && whSto && whSto !== 'ALL');
    const q = restricted
        ? "SELECT * FROM bast_data WHERE UPPER(COALESCE(loksto,'')) = ? ORDER BY id ASC"
        : "SELECT * FROM bast_data ORDER BY id ASC";
    const params = restricted ? [whSto] : [];

    db.all(q, params, async (err, rows) => {
        if (err) return res.status(500).send('Gagal mengambil data BAST.');
        if (!rows || rows.length === 0) {
            return res.status(404).send('Tidak ada BAST yang dapat diunduh.');
        }

        try {
            const logoPath = path.join(__dirname, 'public', 'logo-telkom.png');
            const zip = new AdmZip();
            for (const row of rows) {
                const pdfBuf = await buatPdfBast(row, { uploadBase, logoPath });
                const namaFile = String(row.kode_unik || 'BAST-' + row.id) + '.pdf';
                zip.addFile(namaFile, pdfBuf);
            }
            const zipBuf = zip.toBuffer();
            const namaZip = (role === 'wh' ? 'BAST_' + (whSto || 'WH') : 'BAST_SEMUA') + '_' + Date.now() + '.zip';
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="' + namaZip + '"');
            res.send(zipBuf);
        } catch (e) {
            console.error('Error generate ZIP PDF:', e);
            res.status(500).send('Gagal membuat file PDF: ' + e.message);
        }
    });
});
const xlsx = require('xlsx');

// ================= ROUTE EXPORT EXCEL =================
app.get('/admin/export/excel', isAuth, (req, res) => {
    const qSA     = (req.query.sa || '').trim().toUpperCase();
    const qDari   = (req.query.dari || '').trim();
    const qSampai = (req.query.sampai || '').trim();
    db.all("SELECT * FROM bast_data ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send("Database error");
        
        let exportData = [];
        rows.forEach(row => {
            if (qSA && String(row.loksto || '').trim().toUpperCase() !== qSA) return;
            if (qDari && String(row.tanggal || '') < qDari) return;
            if (qSampai && String(row.tanggal || '') > qSampai) return;
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

// =====================================================================
// DATA INPUT TEKNISI — filter per Service Area
// =====================================================================
const SERVICE_AREAS = ['CINERE', 'DEPOK & RAWAGENI', 'KALIABANG', 'KRANJI', 'PEKAYON', 'PONDOKGEDE', 'SUKMAJAYA', 'BEKASI'];

// Meta: jumlah BAST per Service Area (untuk badge pada chip filter)
app.get('/admin/data-teknisi/meta', checkRole('admin'), (req, res) => {
    db.all("SELECT nik, service_area FROM users WHERE role = 'teknisi'", (err, users) => {
        if (err) return res.json({ counts: {}, total: 0 });
        const nikBySA = {};
        const nikSet  = new Set();
        SERVICE_AREAS.forEach(sa => nikBySA[sa] = new Set());
        users.forEach(u => {
            const sa  = (u.service_area || '').trim().toUpperCase();
            const nik = (u.nik || '').trim().toUpperCase();
            if (SERVICE_AREAS.includes(sa) && nik) {
                nikBySA[sa].add(nik);
                nikSet.add(nik);
            }
        });
        const nikArr = [...nikSet];
        if (nikArr.length === 0) return res.json({ counts: {}, total: 0 });
        const placeholders = nikArr.map(() => '?').join(',');
        db.all(`SELECT UPPER(TRIM(teknisi_nik)) AS nik, COUNT(*) AS cnt FROM bast_data 
                WHERE teknisi_nik IS NOT NULL AND UPPER(TRIM(teknisi_nik)) IN (${placeholders})
                GROUP BY nik`, nikArr.map(n => n), (err2, rows) => {
            const cntMap = {};
            rows.forEach(r => cntMap[r.nik] = r.cnt);
            const counts = {};
            SERVICE_AREAS.forEach(sa => {
                let c = 0;
                nikBySA[sa].forEach(nik => c += (cntMap[nik] || 0));
                counts[sa] = c;
            });
            res.json({ counts, total: rows.reduce((s, r) => s + r.cnt, 0) });
        });
    });
});

// Detail input BAST teknisi untuk satu Service Area
app.get('/admin/data-teknisi', checkRole('admin'), (req, res) => {
    const sa = (req.query.sa || '').trim().toUpperCase();
    if (!SERVICE_AREAS.includes(sa)) return res.json({ success: false, message: 'Service Area tidak dikenal.' });

    db.all("SELECT * FROM users WHERE role = 'teknisi' AND UPPER(TRIM(service_area)) = ?", [sa], (err, teknisi) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const niks = teknisi.map(t => (t.nik || '').trim().toUpperCase()).filter(Boolean);
        if (niks.length === 0) return res.json({ success: true, sa, teknisi: [], total_bast: 0 });

        const placeholders = niks.map(() => '?').join(',');
        db.all(`SELECT * FROM bast_data WHERE teknisi_nik IS NOT NULL AND UPPER(TRIM(teknisi_nik)) IN (${placeholders})
                ORDER BY tanggal DESC, id DESC`, niks.map(n => n), (err2, rows) => {
            if (err2) return res.status(500).json({ success: false, message: err2.message });

            const groups = {};
            rows.forEach(r => {
                const nik = (r.teknisi_nik || '').trim().toUpperCase();
                if (!groups[nik]) groups[nik] = [];
                groups[nik].push(r);
            });

            const teknisiList = teknisi.map(t => {
                const nik = (t.nik || '').trim().toUpperCase();
                const recs = groups[nik] || [];
                let totalOnt = 0, totalFoto = 0;
                let sDone = 0, sWait = 0, sFail = 0;
                recs.forEach(r => {
                    try { totalOnt  += JSON.parse(r.perangkat_json || '[]').length; } catch(e) {}
                    try { totalFoto += JSON.parse(r.eviden_json    || '[]').length; } catch(e) {}
                    if (r.status === 'COMPLETED') sDone++;
                    else if (r.status === 'REJECTED') sFail++;
                    else sWait++;
                });
                return {
                    nik,
                    nama: t.nama_lengkap || t.username,
                    sto: t.sto || '',
                    total_bast: recs.length,
                    total_ont: totalOnt,
                    total_foto: totalFoto,
                    status_counts: { done: sDone, pending: sWait, rejected: sFail },
                    records: recs.map(r => {
                        let perangkat = [], eviden = [];
                        try { perangkat = JSON.parse(r.perangkat_json || '[]'); } catch(e) {}
                        try { eviden    = JSON.parse(r.eviden_json    || '[]'); } catch(e) {}
                        return {
                            kode_unik: r.kode_unik,
                            status: r.status,
                            tanggal: r.tanggal,
                            loksto: r.loksto,
                            wh_nama: r.wh_nama || '-',
                            alasan_tolak: r.alasan_tolak || '',
                            perangkat: perangkat,
                            eviden_count: eviden.length,
                            eviden: eviden
                        };
                    })
                };
            });

            res.json({ success: true, sa, teknisi: teknisiList, total_bast: rows.length });
        });
    });
});

// ================= ROUTE REPORT MIGRASI NTE =================
const multerReport = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(uploadBase, 'eviden/')),
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

// ===== LOG ERROR KE FILE =====
function logError(err) {
    try {
        const logDir = path.join(dbDir, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'error.log'),
            new Date().toISOString() + ' | ' + (err && err.stack ? err.stack : String(err)) + '\n');
    } catch (e) {}
}

// ===== HALAMAN 404 =====
app.use((req, res) => {
    res.status(404).render('error', {
        code    : 404,
        message : 'Halaman tidak ditemukan.',
        username: (req.session && req.session.username) || ''
    });
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
    logError(err);
    if (res.headersSent) return next(err);
    console.error('ERROR:', err);
    res.status(500).render('error', {
        code    : 500,
        message : 'Terjadi kesalahan server. Silakan coba lagi.',
        username: (req.session && req.session.username) || ''
    });
});

app.listen(process.env.PORT || 3000, () => console.log('Server berjalan di http://localhost:' + (process.env.PORT || 3000)));