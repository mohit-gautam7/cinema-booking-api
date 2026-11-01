process.env.ADMIN_EMAIL = 'admin@test.dev';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server, base;
before(() => new Promise((ok) => {
  server = createApp(openDb(':memory:')).listen(0, () => {
    base = `http://localhost:${server.address().port}`;
    ok();
  });
}));
after(() => server.close());

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const register = async (email) => (await call('POST', '/auth/register', { name: 'T', email, password: 'longpassword' })).body.token;

test('register, login, reject bad password and duplicate email', async () => {
  assert.equal((await call('POST', '/auth/register', { name: 'A', email: 'a@test.dev', password: 'longpassword' })).status, 201);
  assert.equal((await call('POST', '/auth/register', { name: 'A', email: 'a@test.dev', password: 'longpassword' })).status, 409);
  assert.equal((await call('POST', '/auth/register', { name: 'A', email: 'b@test.dev', password: 'short' })).status, 400);
  assert.ok((await call('POST', '/auth/login', { email: 'a@test.dev', password: 'longpassword' })).body.token);
  assert.equal((await call('POST', '/auth/login', { email: 'a@test.dev', password: 'wrongpassword' })).status, 401);
});

test('book seats, block double booking, cancel frees seats', async () => {
  const alice = await register('alice@test.dev');
  const bob = await register('bob@test.dev');
  const [movie] = (await call('GET', '/movies')).body;
  const [show] = (await call('GET', `/movies/${movie.id}/shows`)).body;

  assert.equal((await call('POST', '/bookings', { showId: show.id, seats: ['A1'] })).status, 401);
  assert.equal((await call('POST', '/bookings', { showId: show.id, seats: ['Z99'] }, alice)).status, 400);

  const booked = await call('POST', '/bookings', { showId: show.id, seats: ['a1', 'A2'] }, alice);
  assert.equal(booked.status, 201);
  assert.equal(booked.body.total, 2 * show.price);

  // Bob races for an overlapping seat: whole booking is rejected, his free seat A3 stays free
  assert.equal((await call('POST', '/bookings', { showId: show.id, seats: ['A2', 'A3'] }, bob)).status, 409);
  const seats = (await call('GET', `/shows/${show.id}/seats`)).body;
  assert.deepEqual(seats.taken.sort(), ['A1', 'A2']);
  assert.ok(seats.available.includes('A3'));

  assert.equal((await call('POST', `/bookings/${booked.body.id}/cancel`, null, bob)).status, 404); // not Bob's
  assert.equal((await call('POST', `/bookings/${booked.body.id}/cancel`, null, alice)).status, 200);
  assert.equal((await call('POST', '/bookings', { showId: show.id, seats: ['A2', 'A3'] }, bob)).status, 201);
  assert.equal((await call('GET', '/bookings/me', null, alice)).body[0].status, 'cancelled');
});

test('admin routes are admin-only', async () => {
  const user = await register('user@test.dev');
  const admin = await register('admin@test.dev');
  const movie = { title: 'Test Film', genre: 'Comedy', durationMin: 90 };
  assert.equal((await call('POST', '/admin/movies', movie, user)).status, 403);
  const created = await call('POST', '/admin/movies', movie, admin);
  assert.equal(created.status, 201);
  const theatre = (await call('POST', '/admin/theatres', { name: 'Hall', city: 'Pune', rows: 2, cols: 3 }, admin)).body;
  const startsAt = new Date(Date.now() + 3600e3).toISOString();
  const show = await call('POST', '/admin/shows', { movieId: created.body.id, theatreId: theatre.id, startsAt, price: 150 }, admin);
  assert.equal(show.status, 201);
  assert.equal((await call('GET', `/shows/${show.body.id}/seats`)).body.available.length, 6);
  assert.equal((await call('POST', '/admin/shows', { movieId: 999, theatreId: theatre.id, startsAt, price: 1 }, admin)).status, 400);
});

test('forged token is rejected', async () => {
  const token = await register('forge@test.dev');
  const [h, , s] = token.split('.');
  const fake = Buffer.from(JSON.stringify({ sub: 1, role: 'admin', exp: 9e9 })).toString('base64url');
  assert.equal((await call('POST', '/admin/movies', { title: 'x', genre: 'x', durationMin: 1 }, `${h}.${fake}.${s}`)).status, 401);
});
