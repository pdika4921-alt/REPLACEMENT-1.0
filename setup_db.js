const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // 1. Buat Tabel Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password TEXT, 
        role TEXT
    )`);

    // 2. Insert Akun Default (Password: 123)
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('teknisi', '123', 'teknisi')`);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('warehouse', '123', 'wh')`);

    // 3. Buat Tabel BAST (Mendukung Multi-Input)
    db.run(`CREATE TABLE IF NOT EXISTS bast_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        kode_unik TEXT UNIQUE, 
        status TEXT,
        tanggal TEXT, 
        loksto TEXT,
        teknisi_nama TEXT, 
        teknisi_nik TEXT, 
        wh_nama TEXT,
        perangkat_json TEXT, -- Menyimpan data up to 10 SN & Kondisi
        eviden_json TEXT,    -- Menyimpan up to 10 foto
        ttd_teknisi TEXT,
        ttd_wh TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log("Database baru dengan dukungan Multi-Input berhasil dibuat!");
    console.log("Akun Login: \n1. Teknisi (User: teknisi, Pass: 123)\n2. WH (User: warehouse, Pass: 123)");
});

db.close();