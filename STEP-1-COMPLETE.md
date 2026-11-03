# Step 1: User Authentication Setup

> This file described the original demo setup and is superseded by the security notes below. Do not use the former `admin / admin123` credentials.

## Required Configuration

Set `JWT_SECRET` to a unique secret of at least 32 characters before starting the server. On a new database, set `POS_ADMIN_USERNAME` and `POS_ADMIN_PASSWORD` (minimum 8 characters) to create the first admin. Optional bootstrap values are `POS_ADMIN_NAME` and `POS_ADMIN_BRANCH`.

The application does not load `.env` files; provide these values through the process environment or the deployment service. If a database contains the known legacy `admin / admin123` account, startup replaces its password from `POS_ADMIN_PASSWORD`; without a secure replacement it disables that account. Existing users and sales data are otherwise retained.

After login, change the password/PIN with `POST /api/auth/change-password` using `{ "currentPin": "...", "newPin": "..." }`. Admins can create cashier/admin accounts with `POST /api/auth/users`.

PowerShell example (replace the placeholders with unique values before starting; keep the same JWT secret across restarts):

```powershell
$env:JWT_SECRET = "<persisted-random-secret-at-least-32-characters>"
$env:POS_ADMIN_USERNAME = "admin"
$env:POS_ADMIN_PASSWORD = "<your-unique-admin-password>"
npm start
```

## What Was Implemented

### Files Created:
1. **src/database.js** - SQLite database with Users table
2. **src/models/User.js** - User model with password hashing & queries
3. **src/middleware/auth.js** - JWT token verification middleware
4. **src/routes/auth.routes.js** - Authentication API endpoints

### Files Modified:
1. **package.json** - Added dependencies (bcryptjs, jsonwebtoken, sqlite3)
2. **server.js** - Connected database and authentication routes
3. **public/index.html** - Login form now calls `/api/auth/login` API
4. **public/pos.html** - Added auth check & logout functionality

---

## Security Features Implemented ✓

- ✅ **Password Hashing** - Passwords hashed with bcryptjs
- ✅ **JWT Tokens** - Stateless authentication with 24-hour expiry
- ✅ **Input Validation** - Username & PIN validated before processing
- ✅ **Error Handling** - No sensitive info leaked in error messages
- ✅ **Token Storage** - Stored in localStorage (accessible to front-end)
- ✅ **Auth Check** - POS page redirects to login if not authenticated
- ✅ **Logout** - Clears token and user data from storage

---

## Initial Admin

There is no built-in/default login. Configure the bootstrap environment values above; a first admin is created only when the users table is empty.

---

## API Endpoints Created

### 1. Login
**POST** `/api/auth/login`

Request:
```json
{
  "username": "your-configured-admin",
  "pin": "your-secure-password"
}
```

Response (Success):
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "username": "admin",
    "name": "Administrator",
    "role": "admin",
    "branch": "01"
  }
}
```

### 2. Verify Token
**POST** `/api/auth/verify`

Headers:
```
Authorization: Bearer <token>
```

### 3. Refresh Token
**POST** `/api/auth/refresh`

Headers:
```
Authorization: Bearer <token>
```

---

## Database Schema

### Users Table
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,           -- Hashed with bcryptjs
    name TEXT NOT NULL,
    role TEXT DEFAULT 'cashier',       -- 'admin' or 'cashier'
    branch TEXT DEFAULT '01',
    isActive BOOLEAN DEFAULT 1,
    tokenVersion INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## How It Works

1. **User enters username & PIN** on login page
2. **Frontend sends** POST to `/api/auth/login`
3. **Backend verifies** credentials against database
4. **Backend returns** JWT token if valid
5. **Frontend stores** token in localStorage
6. **Frontend redirects** to POS dashboard (pos.html)
7. **POS checks** for authToken in localStorage
8. If no token → redirect back to login
9. User can logout anytime (clears token)

---

## Testing

To test the authentication:

1. Configure the required environment variables.
2. Start the server with `npm start`.
3. Navigate to `http://localhost:3000`.
4. Sign in with the configured initial admin username and password.
5. Confirm the POS dashboard loads and logout clears the local session.

---

## ⚠️ Safety Checklist

- ✅ No built-in/default admin password
- ✅ JWT signing secret required from the environment
- ✅ No sensitive data in error messages
- ✅ Passwords never sent in plain text (bcryptjs)
- ✅ Tokens expire after 24 hours
- ✅ Input sanitized (trim, validate)
- ✅ Database uses parameterized queries (SQL injection safe)
- ✅ Role checks and active-user verification on protected routes
- ✅ Password change invalidates existing tokens

---

**Status:** Authentication hardening implemented. Configure secrets securely before startup; this note is not a production-readiness certification.
