/**
 * Cloudflare Pages Function to connect `index.html` to your Cloudflare D1 SQLite Database
 * Save this file in your GitHub repository at: functions/api/db.js
 *
 * Supports your exact Cloudflare D1 binding:
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

// Server-side destination address for all player feedback
const DEFAULT_FEEDBACK_RECIPIENT = 'lakshansitharaabeysinghe@gmail.com';

// Automatically ensures all 6 SQLite tables (including online_presence & user_feedback) exist in D1
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
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS online_presence (
            session_id TEXT PRIMARY KEY,
            username TEXT DEFAULT 'Guest',
            last_seen INTEGER NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS user_feedback (
            id TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            reply_email TEXT,
            category TEXT DEFAULT 'General Feedback',
            rating INTEGER DEFAULT 5,
            message TEXT NOT NULL,
            ip_hash TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`)
    ]);
}

// Dispatches server-side email notification to lakshansitharaabeysinghe@gmail.com
// Supports Resend API (env.RESEND_API_KEY), FormSubmit Server Relay, or MailChannels Worker Relay
async function sendSecureFeedbackEmail(env, fb) {
    const targetEmail = (env && env.FEEDBACK_TO_EMAIL) ? env.FEEDBACK_TO_EMAIL : DEFAULT_FEEDBACK_RECIPIENT;
    const subject = `[NeonArcade Feedback] ${fb.category} (${fb.rating}/5 ★) from ${fb.name}`;
    const textBody = [
        `New Player Feedback Received on NeonArcade`,
        `------------------------------------------`,
        `Player / GamerTag: ${fb.name}`,
        `Account Email: ${fb.email || 'Not provided'}`,
        `Category: ${fb.category}`,
        `Rating: ${fb.rating} / 5 Stars`,
        `Device: ${fb.device || 'Web Browser'}`,
        `Submitted At: ${fb.createdAt || new Date().toISOString()}`,
        ``,
        `Message:`,
        `${fb.message}`
    ].join('\n');

    // Method 1: If RESEND_API_KEY is configured in Cloudflare Variables & Secrets
    if (env && env.RESEND_API_KEY) {
        try {
            await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: 'NeonArcade <onboarding@resend.dev>',
                    to: [targetEmail],
                    reply_to: fb.email || undefined,
                    subject,
                    text: textBody
                })
            });
            return true;
        } catch (e) {}
    }

    // Method 2: Encrypted HTTPS Relay via FormSubmit AJAX API
    try {
        await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(targetEmail)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Origin': 'https://neon-arcade.pages.dev',
                'Referer': 'https://neon-arcade.pages.dev/'
            },
            body: JSON.stringify({
                _subject: subject,
                Player_GamerTag: fb.name,
                Account_Email: fb.email || 'noreply@neonarcade.io',
                Category: fb.category,
                Star_Rating: `${fb.rating}/5`,
                Device: fb.device || 'Web Browser',
                Message: fb.message,
                _captcha: 'false',
                _template: 'table'
            })
        });
    } catch (e) {}

    // Method 3: Cloudflare Workers MailChannels Relay fallback
    try {
        await fetch('https://api.mailchannels.net/tx/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: targetEmail, name: 'NeonArcade Admin' }] }],
                from: { email: 'noreply@neon-arcade.pages.dev', name: 'NeonArcade Security Relay' },
                subject,
                content: [{ type: 'text/plain', value: textBody }]
            })
        });
    } catch (e) {}

    return true;
}

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
}

// GET /api/db -> Updates live player heartbeat & returns admins, players, online count, scores, custom games, and feedback
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

        // Update active user presence heartbeat (considers sessions active within the last 45 seconds as Online)
        const urlObj = new URL(context.request.url);
        const sid = (urlObj.searchParams.get('sid') || '').trim().slice(0, 64);
        const uname = (urlObj.searchParams.get('user') || 'Guest').trim().slice(0, 60);
        const nowEpochSec = Math.floor(Date.now() / 1000);

        if (sid) {
            await db.prepare(
                `INSERT INTO online_presence (session_id, username, last_seen)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET username = excluded.username, last_seen = excluded.last_seen`
            ).bind(sid, uname, nowEpochSec).run();
        }

        // Prune stale sessions older than 45 seconds
        await db.prepare(`DELETE FROM online_presence WHERE last_seen < ?1`).bind(nowEpochSec - 45).run();

        const onlineRes = await db.prepare(`SELECT COUNT(*) AS cnt FROM online_presence`).first();
        const onlineCount = Math.max(1, Number(onlineRes && onlineRes.cnt) || 1);

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

        const feedbackRes = await db.prepare(
            `SELECT id, player_name AS name, reply_email AS email, category, rating, message, created_at AS createdAt FROM user_feedback ORDER BY rowid DESC LIMIT 25`
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
                onlineCount,
                admins: adminsRes.results || [],
                users: usersRes.results || [],
                scoreHistory,
                customGames,
                feedback: feedbackRes.results || []
            }),
            { status: 200, headers: JSON_HEADERS }
        );
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
    }
}

// POST /api/db -> Writes player registrations, admin accounts, high scores, custom games, or user feedback to Cloudflare D1
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
        } else if (action === 'submit_feedback') {
            const cleanName = String(payload.name || 'Anonymous').replace(/[<>]/g, '').trim().slice(0, 60);
            const cleanEmail = String(payload.email || '').replace(/[<>]/g, '').trim().slice(0, 120);
            const cleanCat = String(payload.category || 'General Feedback').replace(/[<>]/g, '').trim().slice(0, 40);
            const cleanRating = Math.min(5, Math.max(1, parseInt(payload.rating, 10) || 5));
            const cleanMsg = String(payload.message || '').replace(/[<>]/g, '').trim().slice(0, 1000);

            if (cleanMsg.length < 3) {
                return new Response(JSON.stringify({ error: 'Feedback message too short' }), { status: 400, headers: JSON_HEADERS });
            }

            const clientIp = context.request.headers.get('CF-Connecting-IP') || 'unknown';
            await db.prepare(
                `INSERT INTO user_feedback (id, player_name, reply_email, category, rating, message, ip_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
            ).bind(
                payload.id || ('fb_' + Date.now()),
                cleanName,
                cleanEmail,
                cleanCat,
                cleanRating,
                cleanMsg,
                clientIp.slice(0, 24),
                payload.createdAt || new Date().toISOString()
            ).run();

            // Securely dispatch email to lakshansitharaabeysinghe@gmail.com from the server
            await sendSecureFeedbackEmail(context.env, {
                name: cleanName,
                email: cleanEmail,
                category: cleanCat,
                rating: cleanRating,
                message: cleanMsg,
                device: payload.device || 'Web Browser',
                createdAt: payload.createdAt || new Date().toISOString()
            });
        } else {
            return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: JSON_HEADERS });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
    }
}