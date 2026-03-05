const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { loadModels, processPhoto, reclusterEvent, matchSelfie, findBestCluster } = require('./faceProcessor');

const app = express();
const PORT = 8080;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Directory setup ──────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(path.join(__dirname, 'uploads', 'selfies'));
ensureDir(path.join(__dirname, 'public', 'faces'));

// ─── Multer configs ───────────────────────────────────────────────────────────

const photoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, 'uploads', req.params.id);
    ensureDir(dir);
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const selfieStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, path.join(__dirname, 'uploads', 'selfies'));
  },
  filename(req, file, cb) {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const uploadPhotos = multer({
  storage: photoStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /\.(jpe?g|png|webp)$/i.test(file.originalname));
  },
});

const uploadSelfie = multer({
  storage: selfieStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /\.(jpe?g|png|webp)$/i.test(file.originalname));
  },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page — lists all events
app.get('/', (req, res) => {
  const events = db.prepare(`
    SELECT e.*, COUNT(DISTINCT p.id) AS photo_count
    FROM events e
    LEFT JOIN photos p ON p.event_id = e.id
    GROUP BY e.id
    ORDER BY e.created_at DESC
  `).all();
  res.render('index', { events });
});

// Create a new event
app.post('/events', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/');
  const result = db.prepare('INSERT INTO events (name) VALUES (?)').run(name);
  res.redirect(`/events/${result.lastInsertRowid}`);
});

// Event page — face grid + upload form
app.get('/events/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).render('404', { message: 'Event not found' });

  const clusters = db.prepare('SELECT * FROM face_clusters WHERE event_id = ?').all(event.id);
  const photoCount = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE event_id = ?').get(event.id).c;
  const processedCount = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS c
    FROM photos p
    WHERE p.event_id = ?
      AND EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id)
  `).get(event.id).c;

  const error = req.query.error || null;
  const processing = req.query.processing === '1';

  res.render('event', { event, clusters, photoCount, processedCount, error, processing });
});

// Upload photos to an event (batch)
app.post('/events/:id/upload', uploadPhotos.array('photos', 200), async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).send('Event not found');
  if (!req.files || req.files.length === 0) return res.redirect(`/events/${eventId}`);

  // Insert photo rows
  const photoInsert = db.prepare('INSERT INTO photos (event_id, filename) VALUES (?, ?)');
  const photoBatch = req.files.map(file => ({
    id: photoInsert.run(eventId, file.filename).lastInsertRowid,
    filePath: file.path,
  }));

  // Redirect immediately so the user isn't waiting — processing runs in background
  res.redirect(`/events/${eventId}?processing=1`);

  const facesDir = path.join(__dirname, 'public', 'faces', String(eventId));
  ensureDir(facesDir);

  (async () => {
    for (const photo of photoBatch) {
      try {
        const count = await processPhoto(photo.id, photo.filePath, facesDir);
        console.log(`[upload] Photo ${photo.id}: ${count} face(s) detected`);
      } catch (err) {
        console.error(`[upload] Error on photo ${photo.id}:`, err.message);
      }
    }
    reclusterEvent(eventId);
    console.log(`[upload] Done — event ${eventId}`);
  })();
});

// Polling endpoint — lets the frontend check processing progress
app.get('/events/:id/status', (req, res) => {
  const eventId = req.params.id;
  const photoCount = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE event_id = ?').get(eventId).c;
  const processedCount = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS c
    FROM photos p
    WHERE p.event_id = ?
      AND EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id)
  `).get(eventId).c;
  const clusterCount = db.prepare('SELECT COUNT(*) AS c FROM face_clusters WHERE event_id = ?').get(eventId).c;

  res.json({ photoCount, processedCount, clusterCount, done: photoCount > 0 && processedCount >= photoCount });
});

// Photos page — all photos containing a specific face cluster
app.get('/events/:id/cluster/:cid', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).render('404', { message: 'Event not found' });

  const cluster = db.prepare('SELECT * FROM face_clusters WHERE id = ? AND event_id = ?')
    .get(req.params.cid, req.params.id);
  if (!cluster) return res.status(404).render('404', { message: 'Face cluster not found' });

  const photos = db.prepare(`
    SELECT DISTINCT p.id, p.filename
    FROM faces f
    JOIN photos p ON f.photo_id = p.id
    WHERE f.cluster_id = ?
    ORDER BY p.created_at DESC
  `).all(req.params.cid);

  res.render('photos', { event, cluster, photos });
});

// Selfie upload — find the closest matching face cluster
app.post('/events/:id/match', uploadSelfie.single('selfie'), async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).send('Event not found');
  if (!req.file) return res.redirect(`/events/${eventId}?error=no_selfie`);

  try {
    const descriptor = await matchSelfie(req.file.path);
    fs.unlink(req.file.path, () => {}); // clean up selfie immediately

    if (!descriptor) {
      return res.redirect(`/events/${eventId}?error=no_face`);
    }

    const cluster = findBestCluster(descriptor, eventId);
    if (!cluster) {
      return res.redirect(`/events/${eventId}?error=no_match`);
    }

    res.redirect(`/events/${eventId}/cluster/${cluster.id}`);
  } catch (err) {
    console.error('[match] Selfie error:', err.message);
    fs.unlink(req.file.path, () => {});
    res.redirect(`/events/${eventId}?error=processing`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

loadModels()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`FaceGala running → http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to load face-api models:', err.message);
    console.error('Make sure the models/ directory exists. Run: node scripts/downloadModels.js');
    process.exit(1);
  });
