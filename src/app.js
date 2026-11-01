const express = require('express');
const { hashPassword, checkPassword, issueToken, requireAuth, requireAdmin } = require('./auth');

const MAX_SEATS_PER_BOOKING = 10;
const isStr = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;

// "A1".."H12" for an 8x12 hall
function seatLabels(rows, cols) {
  const labels = [];
  for (let r = 0; r < rows; r++) for (let c = 1; c <= cols; c++) labels.push(String.fromCharCode(65 + r) + c);
  return labels;
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // ---------- auth ----------
  app.post('/auth/register', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!isStr(name, 100) || !isStr(email, 200) || !/^\S+@\S+\.\S+$/.test(email) || !isStr(password, 200) || password.length < 8)
      return res.status(400).json({ error: 'name, valid email and password (8+ chars) required' });
    const role = email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase() ? 'admin' : 'user';
    try {
      const { lastInsertRowid: id } = db
        .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(name.trim(), email.toLowerCase(), hashPassword(password), role);
      res.status(201).json({ token: issueToken({ id, role }), user: { id, name: name.trim(), email: email.toLowerCase(), role } });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'email already registered' });
      throw e;
    }
  });

  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = isStr(email) && db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user || !isStr(password) || !checkPassword(password, user.password_hash))
      return res.status(401).json({ error: 'wrong email or password' });
    res.json({ token: issueToken(user) });
  });

  // ---------- catalogue ----------
  app.get('/movies', (req, res) => res.json(db.prepare('SELECT * FROM movies ORDER BY title').all()));

  app.get('/movies/:id/shows', (req, res) => {
    res.json(db.prepare(`
      SELECT s.id, s.starts_at, s.price, t.name AS theatre, t.city
      FROM shows s JOIN theatres t ON t.id = s.theatre_id
      WHERE s.movie_id = ? AND s.starts_at > ? ORDER BY s.starts_at`).all(req.params.id, new Date().toISOString()));
  });

  app.get('/shows/:id/seats', (req, res) => {
    const show = db.prepare('SELECT s.*, t.seat_rows, t.seat_cols FROM shows s JOIN theatres t ON t.id = s.theatre_id WHERE s.id = ?').get(req.params.id);
    if (!show) return res.status(404).json({ error: 'show not found' });
    const taken = new Set(db.prepare('SELECT seat FROM booked_seats WHERE show_id = ?').all(show.id).map((r) => r.seat));
    const all = seatLabels(show.seat_rows, show.seat_cols);
    res.json({ showId: show.id, price: show.price, available: all.filter((s) => !taken.has(s)), taken: [...taken] });
  });

  // ---------- bookings ----------
  app.post('/bookings', requireAuth, (req, res) => {
    const { showId, seats } = req.body || {};
    if (!isInt(showId, 1) || !Array.isArray(seats) || seats.length === 0 || seats.length > MAX_SEATS_PER_BOOKING)
      return res.status(400).json({ error: `showId and 1-${MAX_SEATS_PER_BOOKING} seats required` });
    const show = db.prepare('SELECT s.*, t.seat_rows, t.seat_cols FROM shows s JOIN theatres t ON t.id = s.theatre_id WHERE s.id = ?').get(showId);
    if (!show) return res.status(404).json({ error: 'show not found' });
    if (show.starts_at <= new Date().toISOString()) return res.status(400).json({ error: 'show already started' });
    const valid = new Set(seatLabels(show.seat_rows, show.seat_cols));
    const wanted = [...new Set(seats.map((s) => String(s).toUpperCase()))];
    const bad = wanted.filter((s) => !valid.has(s));
    if (bad.length) return res.status(400).json({ error: `no such seats: ${bad.join(', ')}` });

    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = db
        .prepare('INSERT INTO bookings (user_id, show_id, seats, total) VALUES (?, ?, ?, ?)')
        .run(req.user.id, showId, JSON.stringify(wanted), wanted.length * show.price);
      const hold = db.prepare('INSERT INTO booked_seats (booking_id, show_id, seat) VALUES (?, ?, ?)');
      for (const seat of wanted) hold.run(id, showId, seat);
      db.exec('COMMIT');
      res.status(201).json({ id, showId, seats: wanted, total: wanted.length * show.price, status: 'confirmed' });
    } catch (e) {
      db.exec('ROLLBACK');
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'one or more seats already booked' });
      throw e;
    }
  });

  app.get('/bookings/me', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT b.id, b.seats, b.total, b.status, b.created_at, s.starts_at, m.title AS movie, t.name AS theatre
      FROM bookings b JOIN shows s ON s.id = b.show_id JOIN movies m ON m.id = s.movie_id JOIN theatres t ON t.id = s.theatre_id
      WHERE b.user_id = ? ORDER BY b.id DESC`).all(req.user.id);
    res.json(rows.map((r) => ({ ...r, seats: JSON.parse(r.seats) })));
  });

  app.post('/bookings/:id/cancel', requireAuth, (req, res) => {
    const b = db.prepare('SELECT b.*, s.starts_at FROM bookings b JOIN shows s ON s.id = b.show_id WHERE b.id = ? AND b.user_id = ?').get(req.params.id, req.user.id);
    if (!b) return res.status(404).json({ error: 'booking not found' });
    if (b.status === 'cancelled') return res.status(400).json({ error: 'already cancelled' });
    if (b.starts_at <= new Date().toISOString()) return res.status(400).json({ error: 'show already started' });
    db.exec('BEGIN');
    db.prepare('DELETE FROM booked_seats WHERE booking_id = ?').run(b.id);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    db.exec('COMMIT');
    res.json({ id: b.id, status: 'cancelled' });
  });

  // ---------- admin ----------
  app.post('/admin/movies', requireAdmin, (req, res) => {
    const { title, genre, durationMin } = req.body || {};
    if (!isStr(title) || !isStr(genre, 50) || !isInt(durationMin, 1)) return res.status(400).json({ error: 'title, genre, durationMin required' });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO movies (title, genre, duration_min) VALUES (?, ?, ?)').run(title, genre, durationMin);
    res.status(201).json({ id, title, genre, duration_min: durationMin });
  });

  app.post('/admin/theatres', requireAdmin, (req, res) => {
    const { name, city, rows, cols } = req.body || {};
    if (!isStr(name) || !isStr(city, 100) || !isInt(rows, 1) || rows > 26 || !isInt(cols, 1) || cols > 50)
      return res.status(400).json({ error: 'name, city, rows (1-26), cols (1-50) required' });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO theatres (name, city, seat_rows, seat_cols) VALUES (?, ?, ?, ?)').run(name, city, rows, cols);
    res.status(201).json({ id, name, city, rows, cols });
  });

  app.post('/admin/shows', requireAdmin, (req, res) => {
    const { movieId, theatreId, startsAt, price } = req.body || {};
    const when = new Date(startsAt);
    if (!isInt(movieId, 1) || !isInt(theatreId, 1) || isNaN(when) || !isInt(price))
      return res.status(400).json({ error: 'movieId, theatreId, startsAt (ISO date), price required' });
    try {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO shows (movie_id, theatre_id, starts_at, price) VALUES (?, ?, ?, ?)').run(movieId, theatreId, when.toISOString(), price);
      res.status(201).json({ id, movieId, theatreId, startsAt: when.toISOString(), price });
    } catch (e) {
      if (/FOREIGN KEY/.test(e.message)) return res.status(400).json({ error: 'unknown movie or theatre' });
      throw e;
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

module.exports = { createApp };
