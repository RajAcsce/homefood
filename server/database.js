const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'home_food.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Admins Table
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT
        )`);

        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            mobile_number TEXT PRIMARY KEY,
            name TEXT,
            alt_mobile_number TEXT,
            address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Products Table
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            image_url TEXT,
            unit TEXT,
            quantity TEXT, -- e.g. "1kg" or "500g" - can be descriptive
            description TEXT,
            price REAL,
            status TEXT DEFAULT 'Available' -- Available, Not Available
        )`);

        // Orders Table
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_mobile TEXT,
            total_amount REAL,
            status TEXT DEFAULT 'Pending', -- Pending, Accepted, Preparing, Delivered, Cancelled
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_mobile) REFERENCES users(mobile_number)
        )`);

        // Order Items Table
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER,
            unit_price REAL,
            total_price REAL,
            FOREIGN KEY(order_id) REFERENCES orders(id)
        )`);

        // Payments Table
        db.run(`CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            amount REAL,
            status TEXT DEFAULT 'Pending', -- Pending, Paid, Failed
            method TEXT, -- UPI, Cash
            transaction_id TEXT,
            payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id)
        )`);

        // Business Info Table
        db.run(`CREATE TABLE IF NOT EXISTS business_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            address TEXT,
            contact_number TEXT,
            delivery_charge REAL DEFAULT 0,
            handling_charge REAL DEFAULT 0,
            shop_image_url TEXT,
            licence_doc_url TEXT
        )`);

        // Seed Admin (password: admin123 - hash it later or use plain for "dummy" if requested? Start with plain for simplicity or bcrypt?)
        // User requested "Admin credentials stored securely", so I will use bcrypt in the seeding if possible, or just insert raw and hash in app.
        // For self-containment in this file, I'll rely on the app to seed if empty, or seed here. 
        // Let's seed a default admin if not exists.
        // For now, I won't introduce bcrypt dependency *inside* this file to keep it simple, 
        // but I will add code to seed it from server.js or a seed script.

        // Actually, let's insert a default admin 'admin' with password 'admin123' hashed.
        // $2a$10$wI./G.U0/W.U0/W.U0/W.U0/W.U0/W.U0/W.U0/W.U0/W.U0/W. -> this is not a real hash.
        // I will let the server.js handle seeding or do it here if I import bcrypt.
    });
}

module.exports = db;
