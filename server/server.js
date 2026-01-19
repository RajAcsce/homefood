const express = require('express');
const bodyParser = require('body-parser');
const session = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
    name: 'session',
    keys: ['secret-key'], // Change in production
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// Admin Seeding & Server Start
const ADMIN_USERNAME = 'ADMIN';
const ADMIN_PASSWORD = 'Admin143'; // Default password

function seedAdmin() {
    return new Promise((resolve, reject) => {
        // First, update or create the admin with the specified credentials
        const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

        // Delete any existing admins and create fresh with new credentials
        db.run("DELETE FROM admins", [], (err) => {
            if (err) return reject(err);

            db.run("INSERT INTO admins (username, password_hash) VALUES (?, ?)", [ADMIN_USERNAME, hash], (err) => {
                if (err) return reject(err);
                console.log(`Admin credentials updated. Username: ${ADMIN_USERNAME}, Password: ${ADMIN_PASSWORD}`);
                resolve();
            });
        });
    });
}

// Authentication Middleware
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.adminId) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized: Admin access required' });
};

const requireUser = (req, res, next) => {
    if (req.session && req.session.userMobile) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized: User login required' });
};

// --- API ROUTES ---

// --- ADMIN API ROUTES ---
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// Logger for all admin requests
adminRouter.use((req, res, next) => {
    console.log(`[DEBUG] Admin Request: ${req.method} ${req.url}`);
    next();
});

// Admin: Revenue Breakdown
adminRouter.get('/revenue/breakdown', (req, res) => {
    console.log('[DEBUG] Hit /api/admin/revenue/breakdown');
    const queries = [
        new Promise(resolve => db.get(`
            SELECT COALESCE(SUM(p.amount_paid), 0) as total 
            FROM payments p
            JOIN orders o ON p.order_id = o.id
            WHERE p.method = 'Cash' AND o.status != 'Cancelled'`,
            (err, row) => resolve(row ? row.total : 0))),
        new Promise(resolve => db.get(`
            SELECT COALESCE(SUM(p.amount_paid), 0) as total 
            FROM payments p 
            JOIN orders o ON p.order_id = o.id
            WHERE p.method = 'UPI' AND o.status != 'Cancelled'`,
            (err, row) => resolve(row ? row.total : 0))),
        new Promise(resolve => db.all(`SELECT o.total_amount, p.amount_paid FROM orders o LEFT JOIN payments p ON o.id = p.order_id WHERE o.status != 'Cancelled'`, (err, rows) => {
            if (err) return resolve(0);
            let pending = 0;
            rows.forEach(r => {
                const total = r.total_amount || 0;
                const paid = r.amount_paid || 0;
                if (total > paid) pending += (total - paid);
            });
            resolve(pending);
        }))
    ];

    Promise.all(queries).then(([cash, upi, pending]) => {
        res.json({ cash, upi, pending });
    });
});

// Admin: Daily Revenue
adminRouter.get('/revenue/daily', (req, res) => {
    console.log('[DEBUG] Hit /api/admin/revenue/daily');
    const { startDate, endDate } = req.query;
    let start, end;
    if (startDate && endDate) {
        start = startDate;
        end = endDate;
    } else {
        const d = new Date();
        d.setDate(d.getDate() - 6);
        start = d.toISOString().split('T')[0];
        end = new Date().toISOString().split('T')[0];
    }

    db.all(`SELECT date(p.payment_date) as date, SUM(p.amount_paid) as total 
            FROM payments p
            JOIN orders o ON p.order_id = o.id
            WHERE date(p.payment_date) BETWEEN ? AND ? AND o.status != 'Cancelled'
            GROUP BY date(p.payment_date) 
            ORDER BY date(p.payment_date) ASC`,
        [start, end], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const result = [];
            const dataMap = new Map(rows.map(r => [r.date, r.total]));
            let current = new Date(start);
            const endDt = new Date(end);
            while (current <= endDt) {
                const dateStr = current.toISOString().split('T')[0];
                result.push({ date: dateStr, total: dataMap.get(dateStr) || 0 });
                current.setDate(current.getDate() + 1);
            }
            res.json(result);
        });
});

// Admin: User Orders
adminRouter.get('/users/:mobile/orders', (req, res) => {
    const { mobile } = req.params;
    console.log('[DEBUG] Hit /api/admin/users/:mobile/orders', mobile);
    db.all(`SELECT o.*, p.status as payment_status, p.amount_paid 
            FROM orders o 
            LEFT JOIN payments p ON o.id = p.order_id 
            WHERE o.user_mobile = ? 
            ORDER BY o.created_at DESC`, [mobile], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const promises = rows.map(order => new Promise(resolve => {
            db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id], (err, items) => {
                order.items = items || [];
                resolve(order);
            });
        }));
        Promise.all(promises).then(orders => res.json(orders));
    });
});

// User: Update Order
app.put('/api/orders/:id', requireUser, (req, res) => {
    const { id } = req.params;
    const { items, total_amount, delivery_slot, delivery_date } = req.body;
    const mobile = req.session.userMobile;

    // Verify ownership and status
    db.get("SELECT * FROM orders WHERE id = ? AND user_mobile = ?", [id, mobile], (err, order) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const allowedStatuses = ['Pending', 'Accepted', 'Preparing'];
        if (!allowedStatuses.includes(order.status)) {
            return res.status(400).json({ error: `Cannot update order with status: ${order.status}` });
        }

        // Start Update
        // 1. Update Order Details
        db.run("UPDATE orders SET total_amount = ?, delivery_slot = ?, delivery_date = ? WHERE id = ?",
            [total_amount, delivery_slot, delivery_date, id], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                // 2. Update Payment Amount (expecting payment to be updated later if needed, but keeping Amount in sync with Order Total)
                db.run("UPDATE payments SET amount = ? WHERE order_id = ?", [total_amount, id]);

                // 3. Replace Order Items
                db.run("DELETE FROM order_items WHERE order_id = ?", [id], (err) => {
                    if (err) return res.status(500).json({ error: err.message });

                    const stmt = db.prepare("INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)");
                    items.forEach(item => {
                        stmt.run(id, item.id, item.name, item.quantity, item.price, item.quantity * item.price);
                    });
                    stmt.finalize();

                    res.json({ message: 'Order updated successfully', orderId: id });
                });
            });
    });
});

// Admin: Update User
adminRouter.put('/users/:mobile', (req, res) => {
    const { mobile } = req.params;
    console.log('[DEBUG] PUT /api/admin/users/', mobile);
    const { name, alt_mobile, address } = req.body;
    db.run("UPDATE users SET name = ?, alt_mobile_number = ?, address = ? WHERE mobile_number = ?",
        [name, alt_mobile, address, mobile],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'User updated' });
        });
});

// Admin: Delete User (Hard Delete with Cascade)
adminRouter.delete('/users/:mobile', (req, res) => {
    const { mobile } = req.params;
    console.log('[DEBUG] Hard DELETE /api/admin/users/', mobile);

    db.get("SELECT id FROM orders WHERE user_mobile = ?", [mobile], (err, order) => {
        if (err) return res.status(500).json({ error: err.message });

        // Start a manual "transaction-like" sequence
        // 1. Delete Order Items
        db.run("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_mobile = ?)", [mobile], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // 2. Delete Payments
            db.run("DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_mobile = ?)", [mobile], (err) => {
                if (err) return res.status(500).json({ error: err.message });

                // 3. Delete Orders
                db.run("DELETE FROM orders WHERE user_mobile = ?", [mobile], (err) => {
                    if (err) return res.status(500).json({ error: err.message });

                    // 4. Delete User
                    db.run("DELETE FROM users WHERE mobile_number = ?", [mobile], function (err) {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ message: 'User and all related data deleted permanentely' });
                    });
                });
            });
        });
    });
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Invalid credentials' });

        if (bcrypt.compareSync(password, row.password_hash)) {
            req.session.adminId = row.id;
            res.json({ message: 'Login successful' });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
    req.session = null;
    res.json({ message: 'Logged out' });
});

// Mount admin router AFTER all routes are defined
app.use('/api/admin', adminRouter);
app.use('/api/dashboard', adminRouter);

// User Login (Mobile Number)
app.post('/api/user/login', (req, res) => {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ error: 'Mobile number required' });

    db.get("SELECT * FROM users WHERE mobile_number = ?", [mobile], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row) {
            // Existing user
            req.session.userMobile = row.mobile_number;
            res.json({ message: 'Login successful', user: row, isNew: false });
        } else {
            // New user - auto create
            db.run("INSERT INTO users (mobile_number) VALUES (?)", [mobile], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                req.session.userMobile = mobile;
                res.json({ message: 'Account created and logged in', user: { mobile_number: mobile }, isNew: true });
            });
        }
    });
});

// User Logout
app.post('/api/user/logout', (req, res) => {
    req.session = null;
    res.json({ message: 'Logged out' });
});

// Update User Profile
app.put('/api/user/profile', requireUser, (req, res) => {
    const { name, alt_mobile, address } = req.body;
    const mobile = req.session.userMobile;

    db.run("UPDATE users SET name = ?, alt_mobile_number = ?, address = ? WHERE mobile_number = ?",
        [name, alt_mobile, address, mobile],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Profile updated' });
        });
});

// Get User Profile
app.get('/api/user/profile', requireUser, (req, res) => {
    const mobile = req.session.userMobile;
    db.get("SELECT * FROM users WHERE mobile_number = ?", [mobile], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// --- PRODUCTS API ---

// Public: Get All Products
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products WHERE status != 'Deleted'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin: Add Product
app.post('/api/products', requireAdmin, (req, res) => {
    const { name, image_url, unit, quantity, description, price, status, food_type } = req.body;
    const defaultImageUrl = 'https://www.shutterstock.com/shutterstock/photos/2616578275/display_1500/stock-vector-knife-fork-and-plate-silhouette-icon-vector-illustration-2616578275.jpg';
    const finalImageUrl = image_url && image_url.trim() !== '' ? image_url : defaultImageUrl;

    db.run(`INSERT INTO products (name, image_url, unit, quantity, description, price, status, food_type) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, finalImageUrl, unit, quantity, description, price, status || 'Available', food_type || null],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, message: 'Product added' });
        });
});

// Admin: Update Product
app.put('/api/products/:id', requireAdmin, (req, res) => {
    const { name, image_url, unit, quantity, description, price, status, food_type } = req.body;
    const { id } = req.params;
    const defaultImageUrl = 'https://www.shutterstock.com/shutterstock/photos/2616578275/display_1500/stock-vector-knife-fork-and-plate-silhouette-icon-vector-illustration-2616578275.jpg';
    const finalImageUrl = image_url && image_url.trim() !== '' ? image_url : defaultImageUrl;

    db.run(`UPDATE products SET name = ?, image_url = ?, unit = ?, quantity = ?, description = ?, price = ?, status = ?, food_type = ?
            WHERE id = ?`,
        [name, finalImageUrl, unit, quantity, description, price, status, food_type || null, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Product updated' });
        });
});

// Admin: Delete Product (Soft Delete)
app.delete('/api/products/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    // Soft delete by updating status to 'Deleted'
    db.run("UPDATE products SET status = 'Deleted' WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Product deleted' });
    });
});

// --- ORDERS API ---

app.post('/api/orders', requireUser, (req, res) => {
    const { items, total_amount, delivery_slot, delivery_date } = req.body;
    const mobile = req.session.userMobile;

    if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    db.run("INSERT INTO orders (user_mobile, total_amount, delivery_slot, delivery_date) VALUES (?, ?, ?, ?)",
        [mobile, total_amount, delivery_slot, delivery_date || null], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            const orderId = this.lastID;

            // Insert items
            const placeholders = items.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
            const stmt = db.prepare("INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)");

            items.forEach(item => {
                stmt.run(orderId, item.id, item.name, item.quantity, item.price, item.quantity * item.price);
            });
            stmt.finalize();

            // Initial Payment Record (Pending)
            db.run("INSERT INTO payments (order_id, amount, status, method) VALUES (?, ?, 'Pending', 'Cash/UPI')",
                [orderId, total_amount]);

            res.json({ message: 'Order placed', orderId: orderId });
        });
});

// User: My Orders
app.get('/api/my-orders', requireUser, (req, res) => {
    const mobile = req.session.userMobile;
    db.all(`SELECT orders.*, payments.status as payment_status, payments.amount_paid
            FROM orders 
            LEFT JOIN payments ON orders.id = payments.order_id 
            WHERE user_mobile = ? 
            ORDER BY created_at DESC`, [mobile], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // Fetch items for each order
        const promises = rows.map(order => new Promise(resolve => {
            db.all(`SELECT oi.*, p.unit FROM order_items oi 
                    LEFT JOIN products p ON oi.product_id = p.id 
                    WHERE order_id = ?`, [order.id], (err, items) => {
                order.items = items || [];
                resolve(order);
            });
        }));

        Promise.all(promises).then(ordersWithItems => res.json(ordersWithItems));
    });
});

// Admin: All Orders
adminRouter.get('/orders', (req, res) => {
    db.all(`SELECT orders.*, users.name as user_name, users.address as user_address, 
            payments.status as payment_status, payments.amount_paid
            FROM orders 
            LEFT JOIN users ON orders.user_mobile = users.mobile_number
            LEFT JOIN payments ON orders.id = payments.order_id
            ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Get Single Order Details (Admin/User)
app.get('/api/orders/:id', (req, res) => {
    const { id } = req.params;
    // Security check: if user, must be own order; if admin, any.
    // Simplifying for now: Auth check inline or assume UI handles context, 
    // but safer to check session.

    db.get("SELECT * FROM orders WHERE id = ?", [id], (err, order) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Authorization logic
        if (req.session.adminId || (req.session.userMobile && req.session.userMobile === order.user_mobile)) {
            db.all(`SELECT oi.*, p.unit FROM order_items oi 
                    LEFT JOIN products p ON oi.product_id = p.id 
                    WHERE order_id = ?`, [id], (err, items) => {
                if (err) return res.status(500).json({ error: err.message });

                db.get("SELECT * FROM payments WHERE order_id = ?", [id], (err, payment) => {
                    if (err) return res.status(500).json({ error: err.message });

                    db.get("SELECT * FROM users WHERE mobile_number = ?", [order.user_mobile], (err, user) => {
                        res.json({ order, items, payment, user });
                    });
                });
            });
        } else {
            res.status(403).json({ error: 'Forbidden' });
        }
    });
});

// Admin: Update Order Status
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    db.run("UPDATE orders SET status = ? WHERE id = ?", [status, id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Status updated' });
    });
});

// Admin: Update Payment Status
app.post('/api/orders/:id/payment', requireAdmin, (req, res) => {
    const { status, amount, amount_paid, method, transaction_id, app_name } = req.body;
    const { id } = req.params;

    // Update payment table
    db.run(`UPDATE payments SET status = ?, amount = ?, amount_paid = ?, method = ?, transaction_id = ?, app_name = ? 
            WHERE order_id = ?`,
        [status, amount, amount_paid || 0, method, transaction_id, app_name, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Payment updated' });
        });
});


// Admin: Dashboard Stats
adminRouter.get('/stats', (req, res) => {
    const stats = {};
    const queries = [
        new Promise(resolve => db.get("SELECT COUNT(*) as count FROM users", (err, row) => resolve({ type: 'users', val: row ? row.count : 0 }))),
        new Promise(resolve => db.get("SELECT COUNT(*) as count FROM orders", (err, row) => resolve({ type: 'orders', val: row ? row.count : 0 }))),
        new Promise(resolve => db.get(`
            SELECT SUM(p.amount_paid) as total 
            FROM payments p
            JOIN orders o ON p.order_id = o.id
            WHERE p.status = 'Paid' AND o.status != 'Cancelled'`,
            (err, row) => resolve({ type: 'revenue', val: row ? (row.total || 0) : 0 }))),
        new Promise(resolve => db.get("SELECT COUNT(*) as count FROM products WHERE status != 'Deleted'", (err, row) => resolve({ type: 'products', val: row ? row.count : 0 }))),

        // Today's Orders
        new Promise(resolve => db.get("SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now')",
            (err, row) => resolve({ type: 'today_orders_count', val: row ? row.count : 0 }))),

        new Promise(resolve => db.get("SELECT SUM(amount_paid) as total FROM payments WHERE order_id IN (SELECT id FROM orders WHERE date(created_at) = date('now'))",
            (err, row) => resolve({ type: 'today_revenue', val: row ? (row.total || 0) : 0 }))),

        new Promise(resolve => db.all(`SELECT orders.*, users.name as user_name FROM orders 
            LEFT JOIN users ON orders.user_mobile = users.mobile_number 
            WHERE date(orders.created_at) = date('now') ORDER BY created_at DESC LIMIT 10`,
            (err, rows) => {
                if (err || !rows) return resolve({ type: 'today_orders', val: [] });
                const promises = rows.map(order => new Promise(res => {
                    db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id], (err, items) => {
                        order.items = items || [];
                        res(order);
                    });
                }));
                Promise.all(promises).then(ordersWithItems => resolve({ type: 'today_orders', val: ordersWithItems }));
            })),

        // Revenue Chart (Last 7 days) - Fill missing dates
        new Promise(resolve => {
            db.all(`SELECT date(p.payment_date) as date, SUM(p.amount_paid) as total 
                    FROM payments p
                    JOIN orders o ON p.order_id = o.id
                    WHERE p.status = 'Paid' AND p.payment_date >= date('now', '-6 days') AND o.status != 'Cancelled'
                    GROUP BY date(p.payment_date) 
                    ORDER BY date(p.payment_date) ASC`,
                (err, rows) => {
                    if (err) return resolve({ type: 'revenue_chart', val: [] });
                    const result = [];
                    const dataMap = new Map(rows.map(r => [r.date, r.total]));
                    for (let i = 6; i >= 0; i--) {
                        const d = new Date();
                        d.setDate(d.getDate() - i);
                        const dateStr = d.toISOString().split('T')[0];
                        result.push({ date: dateStr, total: dataMap.get(dateStr) || 0 });
                    }
                    resolve({ type: 'revenue_chart', val: result });
                });
        }),

        // Order Status Chart
        new Promise(resolve => db.all("SELECT status, COUNT(*) as count FROM orders GROUP BY status",
            (err, rows) => resolve({ type: 'status_chart', val: rows || [] })))
    ];

    Promise.all(queries).then(results => {
        results.forEach(r => stats[r.type] = r.val);
        res.json(stats);
    });
});

// Admin: Get All Users Stats
adminRouter.get('/users', (req, res) => {
    const query = `
        SELECT 
            u.mobile_number, 
            u.name, 
            u.alt_mobile_number, 
            u.address,
            COUNT(o.id) as total_orders,
            COALESCE(SUM(o.total_amount), 0) as total_bill_amount,
            COALESCE(SUM(p.amount_paid), 0) as total_paid_amount,
            (COALESCE(SUM(o.total_amount), 0) - COALESCE(SUM(p.amount_paid), 0)) as total_remaining
        FROM users u
        LEFT JOIN orders o ON u.mobile_number = o.user_mobile
        LEFT JOIN payments p ON o.id = p.order_id
        WHERE u.status IS NULL OR u.status != 'Deleted'
        GROUP BY u.mobile_number
        ORDER BY total_orders DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});



// Admin: Get Business Info
adminRouter.get('/business-profile', (req, res) => {
    db.get("SELECT * FROM business_info ORDER BY id DESC LIMIT 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

const multer = require('multer');

// Configure Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

function checkMigrations() {
    return new Promise((resolve) => {
        const businessInfoColumns = [
            { name: 'delivery_charge', type: 'REAL DEFAULT 0' },
            { name: 'handling_charge', type: 'REAL DEFAULT 0' },
            { name: 'shop_image_url', type: 'TEXT' },
            { name: 'licence_doc_url', type: 'TEXT' },
            { name: 'open_time', type: 'TEXT' },
            { name: 'close_time', type: 'TEXT' },
            { name: 'break_start', type: 'TEXT' },
            { name: 'break_end', type: 'TEXT' },
            { name: 'weekly_holiday', type: 'TEXT' },
            { name: 'cart_value', type: 'REAL DEFAULT 1000' }
        ];

        const orderColumns = [
            { name: 'delivery_slot', type: 'TEXT' },
            { name: 'delivery_date', type: 'TEXT' }
        ];

        const paymentColumns = [
            { name: 'amount_paid', type: 'REAL DEFAULT 0' },
            { name: 'app_name', type: 'TEXT' },
            { name: 'transaction_id', type: 'TEXT' }
        ];

        const productColumns = [
            { name: 'food_type', type: 'TEXT' }
        ];

        const userColumns = [
            { name: 'status', type: 'TEXT' }
        ];
        // SQLite doesn't support IF NOT EXISTS for ADD COLUMN properly in all versions, 
        // so we check pragmas or just try/catch add column.
        // Simple approach: Try adding, ignore error if duplicate column.
        let chain = Promise.resolve();

        // Add business_info columns
        businessInfoColumns.forEach(col => {
            chain = chain.then(() => new Promise(res => {
                db.run(`ALTER TABLE business_info ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    res(); // Ignore error (likely "duplicate column name")
                });
            }));
        });

        // Add orders columns
        orderColumns.forEach(col => {
            chain = chain.then(() => new Promise(res => {
                db.run(`ALTER TABLE orders ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    res(); // Ignore error (likely "duplicate column name")
                });
            }));
        });

        // Add payments columns
        paymentColumns.forEach(col => {
            chain = chain.then(() => new Promise(res => {
                db.run(`ALTER TABLE payments ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    res(); // Ignore error (likely "duplicate column name")
                });
            }));
        });

        // Add products columns
        productColumns.forEach(col => {
            chain = chain.then(() => new Promise(res => {
                db.run(`ALTER TABLE products ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    res(); // Ignore error (likely "duplicate column name")
                });
            }));
        });

        // Add users columns
        userColumns.forEach(col => {
            chain = chain.then(() => new Promise(res => {
                db.run(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    res(); // Ignore error (likely "duplicate column name")
                });
            }));
        });

        chain.then(resolve);
    });
}

// Public: Get Business Info
app.get('/api/business-profile', (req, res) => {
    db.get("SELECT * FROM business_info ORDER BY id DESC LIMIT 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// Admin: Save Business Info
adminRouter.post('/business-profile', upload.fields([{ name: 'shop_image', maxCount: 1 }, { name: 'licence_doc', maxCount: 1 }]), (req, res) => {
    const { name, address, contact_number, delivery_charge, handling_charge, open_time, close_time, break_start, break_end, weekly_holiday, cart_value } = req.body;

    db.get("SELECT * FROM business_info ORDER BY id DESC LIMIT 1", (err, existing) => {
        const shop_image_url = req.files['shop_image'] ? '/uploads/' + req.files['shop_image'][0].filename : (existing ? existing.shop_image_url : null);
        const licence_doc_url = req.files['licence_doc'] ? '/uploads/' + req.files['licence_doc'][0].filename : (existing ? existing.licence_doc_url : null);

        db.run(`INSERT INTO business_info (name, address, contact_number, delivery_charge, handling_charge, shop_image_url, licence_doc_url, open_time, close_time, break_start, break_end, weekly_holiday, cart_value) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, address, contact_number, delivery_charge || 0, handling_charge || 0, shop_image_url, licence_doc_url, open_time, close_time, break_start, break_end, weekly_holiday, cart_value || 1000],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'Profile saved' });
            });
    });
});

// 404 Handler
app.use((req, res, next) => {
    console.log(`[404] Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Endpoint not found' });
});

seedAdmin().then(() => checkMigrations()).then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to seed, migrate or start server:', err);
});

