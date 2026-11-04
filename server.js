const express = require("express");
const path = require("path");
const fs = require("fs");
require("./src/services/loadEnv")();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters before starting the POS server.");
}

const appDataPath = process.env.POS_APP_DATA_DIR || __dirname;
const serverLockPath = path.join(appDataPath, ".pos-server.lock");
function acquireServerLock() {
    try {
        fs.writeFileSync(serverLockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
        return;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }

    let existingPid;
    try {
        existingPid = Number(JSON.parse(fs.readFileSync(serverLockPath, "utf8")).pid);
    } catch (error) {
        throw new Error(`Cannot read POS server lock file: ${error.message}`);
    }
    if (Number.isSafeInteger(existingPid) && existingPid > 0) {
        try {
            process.kill(existingPid, 0);
            throw new Error(`Another POS server process is already running (PID ${existingPid}).`);
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
    fs.unlinkSync(serverLockPath);
    fs.writeFileSync(serverLockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
}

acquireServerLock();
function releaseServerLock() {
    try {
        const lock = JSON.parse(fs.readFileSync(serverLockPath, "utf8"));
        if (lock.pid === process.pid) fs.unlinkSync(serverLockPath);
    } catch (error) {
        if (error.code !== "ENOENT") console.error("Unable to release POS server lock:", error);
    }
}
process.on("exit", releaseServerLock);

const app = express();
const PORT = Number(process.env.POS_PORT || 3000);
if (!Number.isSafeInteger(PORT) || PORT < 0 || PORT > 65535) {
    throw new Error("POS_PORT must be a valid port number.");
}

// ========================================
// DATABASE
// ========================================

const db = require("./src/database");

// ========================================
// MIDDLEWARE
// ========================================

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(async (req, res, next) => {
    try {
        await db.ready;
        return next();
    } catch (error) {
        console.error("Database initialization failed:", error);
        return res.status(503).json({
            success: false,
            message: "Database initialization failed; POS requests are temporarily unavailable."
        });
    }
});

// ========================================
// PUBLIC FOLDER
// ========================================

const publicPath = path.join(__dirname, "public");

app.use(express.static(publicPath));

// ========================================
// ROUTES
// ========================================

app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/products", require("./src/routes/product.routes"));
app.use("/api/audit", require("./src/routes/audit.routes"));
app.use("/api/settings", require("./src/routes/settings.routes"));
app.use("/api/transactions", require("./src/routes/transaction.routes"));
app.use("/api/readings", require("./src/routes/reading.routes"));
app.use("/api/updates", require("./src/routes/update.routes"));
app.use("/api/backups", require("./src/routes/backup.routes"));
app.use("/api/suppliers", require("./src/routes/supplier.routes"));
app.use("/api/customers", require("./src/routes/customer.routes"));

// ========================================
// LOGIN / HOME
// ========================================

app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        system: "General POS System",
        message: "Server is running successfully",
        timestamp: new Date().toISOString()
    });
});

// ========================================
// 404
// ========================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found",
        route: req.originalUrl
    });
});

// ========================================
// START SERVER
// ========================================

const bindHost = process.env.POS_BIND_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
const server = app.listen(PORT, bindHost, () => {

    console.log("");
    console.log("========================================");
    console.log("        GENERAL POS SYSTEM");
    console.log("========================================");
    const port = server.address().port;
    console.log(`Server : http://${bindHost}:${port}`);
    console.log(`Health : http://127.0.0.1:${port}/api/health`);
    console.log("========================================");
    console.log("SERVER STATUS: RUNNING");
    console.log("========================================");
    console.log("");

});

const { startBackupScheduler } = require("./src/services/backup");
db.ready
    .then(() => startBackupScheduler(db))
    .catch((error) => console.error("Unable to start database backup scheduler:", error));

// ========================================
// ERROR HANDLING
// ========================================

server.on("error", (error) => {

    console.error("");
    console.error("SERVER ERROR:");
    console.error(error);
    console.error("");

    releaseServerLock();
    db.close((closeError) => {
        if (closeError) console.error("Unable to close database after server error:", closeError);
        process.exit(1);
    });

});

let isShuttingDown = false;
function shutdown(callback = () => {}) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    server.close((serverError) => {
        releaseServerLock();
        db.close((databaseError) => {
            if (serverError) console.error("Unable to close POS server:", serverError);
            if (databaseError) console.error("Unable to close POS database:", databaseError);
            callback(serverError || databaseError || null);
        });
    });
}

process.on("SIGINT", () => {
    console.log("\nStopping General POS Server...");
    shutdown(() => {
        console.log("Server stopped.");
        process.exit(0);
    });
});

process.on("SIGTERM", () => shutdown(() => process.exit(0)));

module.exports = { app, server, db, shutdown };
