# Cinema Booking API

A REST API for browsing movies and booking cinema seats, built with Node.js, Express 5 and Node's built-in SQLite.

- **No double booking:** each held seat is a row under a `UNIQUE(show_id, seat)` constraint. If two people try to book the same seat, one of them gets `409`. A booking is all-or-nothing, so a partial clash never leaves stray seats held.
- **JWT auth:** HS256 tokens and scrypt password hashing, built on `node:crypto` with no auth libraries.
- **Roles:** regular users book seats, and admins add movies, theatres and shows.
- **Cancellation:** releases the seats straight away and keeps the booking in your history.
- **Validation** at every endpoint, and JSON errors throughout.

The only dependency is Express.

## Run

Requires Node 22.5 or newer.

```bash
npm install
npm start          # http://localhost:3000, creates cinema.db with sample movies and shows
npm test
```

| Env var | Purpose |
|---|---|
| `PORT` | default `3000` |
| `DB_PATH` | SQLite file, default `cinema.db` |
| `JWT_SECRET` | signing key (if unset, a random one is used and tokens reset on restart) |
| `ADMIN_EMAIL` | the user who registers with this email becomes admin |

## Endpoints

| Method | Path | Auth | Body |
|---|---|---|---|
| POST | `/auth/register` | none | `{ name, email, password }` |
| POST | `/auth/login` | none | `{ email, password }` |
| GET | `/movies` | none | |
| GET | `/movies/:id/shows` | none | upcoming shows |
| GET | `/shows/:id/seats` | none | available and taken seats |
| POST | `/bookings` | user | `{ showId, seats: ["A1", "A2"] }` |
| GET | `/bookings/me` | user | |
| POST | `/bookings/:id/cancel` | user | |
| POST | `/admin/movies` | admin | `{ title, genre, durationMin }` |
| POST | `/admin/theatres` | admin | `{ name, city, rows, cols }` |
| POST | `/admin/shows` | admin | `{ movieId, theatreId, startsAt, price }` |

Send the token as `Authorization: Bearer <token>`. Seats are labelled by row letter and column number (`A1` … `H12`).

## Example

```bash
TOKEN=$(curl -s localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"name":"Mohit","email":"mohit@example.com","password":"supersecret"}' | jq -r .token)

curl -s localhost:3000/movies/1/shows
curl -s localhost:3000/shows/1/seats
curl -s localhost:3000/bookings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"showId":1,"seats":["C5","C6"]}'
```

## Structure

```
server.js        starts the HTTP server
src/db.js        schema and sample data
src/auth.js      password hashing, JWT, auth middleware
src/app.js       routes
test/            end-to-end tests (node:test against a real server on an in-memory DB)
```
