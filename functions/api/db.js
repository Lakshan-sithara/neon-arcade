/**
 * Cloudflare Pages Function to connect `index.html` to your Cloudflare D1 SQLite Database
 * Save this file in your GitHub repository at: functions/api/db.js
 *
 * Supports your exact Cloudflare D1 binding from your screenshot:
 * Binding Name: `neon-arcade-db` (also checks `DB` or `neon_arcade_db` automatically)
 */

function getD1Database(env) {
    return env['neon-arcade-db'] || env.neon_arcade_db || env.DB || null;
}

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

// Automatically ensures all 4 SQLite tables and default admin exist in D1
async function ensureSchema(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS admin_accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'SuperAdmin',
            created_at TEXT DEFAULT CURRENT_DATE
        )`),
        db.prepare(`INSERT OR IGNORE INTO admin_accounts (id, username, email, password_hash, role, created_at)
            VALUES ('admin_root_1', 'admin', 'admin@neonarcade.io', 'admin1234', 'SuperAdmin', '2026-11-15')`),
        db.prepare(`CREATE TABLE IF NOT EXISTS player_accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            joined_date TEXT NOT NULL DEFAULT CURRENT_DATE,
            is_active INTEGER DEFAULT 1
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS score_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL,
            player_username TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 0,
            achieved_date TEXT NOT NULL DEFAULT CURRENT_DATE,
            UNIQUE(game_id, player_username)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS custom_games (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'Arcade',
            icon TEXT DEFAULT '🎮',
            source_type TEXT NOT NULL DEFAULT 'iframe',
            embed_url TEXT,
            html_code TEXT,
            description TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`)
    ]);
}

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
}

// GET /api/db -> Returns all admins, registered players, all-time scores, and custom games
export async function onRequestGet(context) {
    const db = getD1Database(context.env);
    if (!db) {
        return new Response(
            JSON.stringify({ error: "D1 Binding 'neon-arcade-db' not found in environment." }),
            { status: 500, headers: JSON_HEADERS }
        );
    }

    try {
        await ensureSchema(db);

        const adminsRes = await db.prepare(
            `SELECT id, username, email, password_hash AS pass, role FROM admin_accounts`
        ).all();

        const usersRes = await db.prepare(
            `SELECT id, username AS name, email, password_hash AS pass, joined_date AS joined FROM player_accounts ORDER BY rowid DESC`
        ).all();

        const scoresRes = await db.prepare(
            `SELECT game_id, player_username AS user, score, achieved_date AS date FROM score_records ORDER BY score DESC`
        ).all();

        const gamesRes = await db.prepare(
            `SELECT id, title, category, icon, source_type AS type, embed_url AS url, html_code AS htmlCode, description AS desc FROM custom_games ORDER BY rowid DESC`
        ).all();

        // Group scores by game_id for the frontend
        const scoreHistory = {};
        for (const row of (scoresRes.results || [])) {
            if (!scoreHistory[row.game_id]) scoreHistory[row.game_id] = [];
            scoreHistory[row.game_id].push({
                user: row.user,
                score: Number(row.score) || 0,
                date: row.date
            });
        }

        const customGames = (gamesRes.results || []).map(g => ({
            ...g,
            controls: g.desc,
            gradient: 'from-pink-500/20 to-cyan-500/20',
            badgeColor: 'text-neonCyan border-cyan-500/40'
        }));

        return new Response(
            JSON.stringify({
                ok: true,
                admins: adminsRes.results || [],
                users: usersRes.results || [],
                scoreHistory,
                customGames
            }),
            { status: 200, headers: JSON_HEADERS }
        );
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
    }
}

// POST /api/db -> Writes player registrations, admin accounts, high scores, or custom games to Cloudflare D1
export async function onRequestPost(context) {
    const db = getD1Database(context.env);
    if (!db) {
        return new Response(
            JSON.stringify({ error: "D1 Binding 'neon-arcade-db' not found in environment." }),
            { status: 500, headers: JSON_HEADERS }
        );
    }

    try {
        await ensureSchema(db);
        const body = await context.request.json();
        const { action, payload } = body || {};

        if (action === 'register_player') {
            await db.prepare(
                `INSERT INTO player_accounts (id, username, email, password_hash, joined_date)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
            ).bind(
                payload.id,
                payload.name,
                payload.email,
                payload.pass,
                payload.joined || new Date().toISOString().slice(0, 10)
            ).run();
        } else if (action === 'add_admin') {
            await db.prepare(
                `INSERT INTO admin_accounts (id, username, email, password_hash, role)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
            ).bind(
                payload.id,
                payload.username,
                payload.email,
                payload.pass,
                payload.role || 'Admin'
            ).run();
        } else if (action === 'delete_admin') {
            await db.prepare(`DELETE FROM admin_accounts WHERE id = ?1`).bind(payload.id).run();
        } else if (action === 'save_score') {
            await db.prepare(
                `INSERT INTO score_records (game_id, player_username, score, achieved_date)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(game_id, player_username) DO UPDATE SET
                    score = CASE WHEN excluded.score > score_records.score THEN excluded.score ELSE score_records.score END,
                    achieved_date = CASE WHEN excluded.score > score_records.score THEN excluded.achieved_date ELSE score_records.achieved_date END`
            ).bind(
                payload.gameId,
                payload.user,
                Number(payload.score) || 0,
                payload.date || new Date().toISOString().slice(0, 10)
            ).run();
        } else if (action === 'add_game') {
            await db.prepare(
                `INSERT OR REPLACE INTO custom_games (id, title, category, icon, source_type, embed_url, html_code, description)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
            ).bind(
                payload.id,
                payload.title,
                payload.category || 'Arcade',
                payload.icon || '🎮',
                payload.type || 'iframe',
                payload.url || '',
                payload.htmlCode || '',
                payload.desc || ''
            ).run();
        } else if (action === 'delete_game') {
            await db.prepare(`DELETE FROM custom_games WHERE id = ?1`).bind(payload.id).run();
        } else {
            return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: JSON_HEADERS });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
    }
}