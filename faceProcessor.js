/**
 * faceProcessor.js — main-thread coordinator.
 *
 * All CPU-heavy work (TensorFlow inference, image decoding) runs inside
 * worker threads managed by workerPool. This file handles:
 *   - dispatching photo/selfie jobs to the pool
 *   - writing face rows to the DB (single-threaded, avoids SQLite contention)
 *   - clustering faces per event (pure JS, fast)
 */

const db = require('./db');
const pool = require('./workerPool');

const CLUSTER_THRESHOLD = 0.5; // Euclidean distance — lower = stricter

// ─── Photo processing ─────────────────────────────────────────────────────────

/**
 * Dispatches a single photo to the worker pool for face detection.
 * Writes detected face rows to the DB from the main thread.
 * Returns the number of faces detected.
 */
async function processPhoto(photoId, imagePath, facesDir) {
  const result = await pool.run({ type: 'processPhoto', photoId, imagePath, facesDir });

  if (!result.faces || result.faces.length === 0) return 0;

  const insert = db.prepare(
    `INSERT INTO faces (photo_id, descriptor, thumb_file, bbox_x, bbox_y, bbox_w, bbox_h)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const face of result.faces) {
    insert.run(
      photoId,
      JSON.stringify(face.descriptor),
      face.thumbFile,
      face.bbox.x, face.bbox.y, face.bbox.w, face.bbox.h
    );
  }

  return result.faces.length;
}

// ─── Clustering ───────────────────────────────────────────────────────────────

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function meanDescriptor(descriptors) {
  const len = descriptors[0].length;
  const mean = new Array(len).fill(0);
  for (const d of descriptors) for (let i = 0; i < len; i++) mean[i] += d[i];
  return mean.map(v => v / descriptors.length);
}

/**
 * Re-clusters all faces for an event from scratch using greedy
 * nearest-centroid assignment. Fast: pure JS, no ML inference.
 */
function reclusterEvent(eventId) {
  // Wipe existing clusters for this event
  const old = db.prepare('SELECT id FROM face_clusters WHERE event_id = ?').all(eventId);
  for (const c of old) db.prepare('UPDATE faces SET cluster_id = NULL WHERE cluster_id = ?').run(c.id);
  db.prepare('DELETE FROM face_clusters WHERE event_id = ?').run(eventId);

  const faces = db.prepare(`
    SELECT f.id, f.descriptor, f.thumb_file
    FROM faces f JOIN photos p ON f.photo_id = p.id
    WHERE p.event_id = ? ORDER BY f.id
  `).all(eventId);

  if (faces.length === 0) return;

  const clusters = []; // { centroid, faceIds, descriptors, coverThumb }

  for (const face of faces) {
    const desc = JSON.parse(face.descriptor);
    let bestIdx = -1, bestDist = Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const d = euclidean(desc, clusters[i].centroid);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    if (bestIdx >= 0 && bestDist < CLUSTER_THRESHOLD) {
      clusters[bestIdx].faceIds.push(face.id);
      clusters[bestIdx].descriptors.push(desc);
      clusters[bestIdx].centroid = meanDescriptor(clusters[bestIdx].descriptors);
    } else {
      clusters.push({ centroid: desc, faceIds: [face.id], descriptors: [desc], coverThumb: face.thumb_file });
    }
  }

  const insertCluster = db.prepare(
    `INSERT INTO face_clusters (event_id, centroid, cover_thumb) VALUES (?, ?, ?)`
  );
  const assignFace = db.prepare('UPDATE faces SET cluster_id = ? WHERE id = ?');

  for (const cluster of clusters) {
    const { lastInsertRowid: cid } = insertCluster.run(eventId, JSON.stringify(cluster.centroid), cluster.coverThumb);
    for (const fid of cluster.faceIds) assignFace.run(cid, fid);
  }

  console.log(`[cluster] event ${eventId}: ${clusters.length} unique faces from ${faces.length} detections`);
}

// ─── Selfie matching ──────────────────────────────────────────────────────────

/** Detects a single face in the selfie and returns its 128-d descriptor. */
async function matchSelfie(imagePath) {
  const result = await pool.run({ type: 'matchSelfie', imagePath });
  return result.descriptor ?? null;
}

/** Returns the closest cluster in an event within CLUSTER_THRESHOLD, or null. */
function findBestCluster(descriptor, eventId) {
  const clusters = db.prepare('SELECT * FROM face_clusters WHERE event_id = ?').all(eventId);
  let best = null, bestDist = Infinity;

  for (const c of clusters) {
    const d = euclidean(descriptor, JSON.parse(c.centroid));
    if (d < bestDist) { bestDist = d; best = c; }
  }

  return bestDist < CLUSTER_THRESHOLD ? best : null;
}

/** Resolves once all workers have loaded their models. */
async function loadModels() {
  await pool._readyPromise;
}

module.exports = { loadModels, processPhoto, reclusterEvent, matchSelfie, findBestCluster };
