const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
);
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0)
);
CREATE TABLE IF NOT EXISTS theatres (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  seat_rows INTEGER NOT NULL CHECK (seat_rows BETWEEN 1 AND 26),
  seat_cols INTEGER NOT NULL CHECK (seat_cols BETWEEN 1 AND 50)
);
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  theatre_id INTEGER NOT NULL REFERENCES theatres(id),
  starts_at TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  show_id INTEGER NOT NULL REFERENCES shows(id),
  seats TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one row per held seat; the UNIQUE constraint is what makes double-booking impossible
CREATE TABLE IF NOT EXISTS booked_seats (
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  show_id INTEGER NOT NULL REFERENCES shows(id),
  seat TEXT NOT NULL,
  UNIQUE (show_id, seat)
);
`;

function seed(db) {
  if (db.prepare('SELECT COUNT(*) n FROM movies').get().n > 0) return;
  const movie = db.prepare('INSERT INTO movies (title, genre, duration_min) VALUES (?, ?, ?)');
  const theatre = db.prepare('INSERT INTO theatres (name, city, seat_rows, seat_cols) VALUES (?, ?, ?, ?)');
  const show = db.prepare('INSERT INTO shows (movie_id, theatre_id, starts_at, price) VALUES (?, ?, ?, ?)');
  const m1 = movie.run('Neon Monsoon', 'Sci-Fi', 142).lastInsertRowid;
  const m2 = movie.run('The Last Chai Stall', 'Drama', 118).lastInsertRowid;
  const t1 = theatre.run('Galaxy Screens', 'Delhi', 8, 12).lastInsertRowid;
  const t2 = theatre.run('Riverside Cinema', 'Mumbai', 6, 10).lastInsertRowid;
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  show.run(m1, t1, `${tomorrow}T18:30:00Z`, 250);
  show.run(m1, t2, `${tomorrow}T21:00:00Z`, 300);
  show.run(m2, t1, `${tomorrow}T15:00:00Z`, 200);
}

function openDb(path = process.env.DB_PATH || 'cinema.db') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seed(db);
  return db;
}

module.exports = { openDb };
