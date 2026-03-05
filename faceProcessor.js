const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// face-api.js requires canvas for Node.js image loading
const canvas = require('canvas');
const { Canvas, Image, ImageData } = canvas;

const faceapi = require('@vladmandic/face-api');
// Patch faceapi to use the Node.js canvas implementation
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODELS_PATH = path.join(__dirname, 'models');
const CLUSTER_THRESHOLD = 0.5; // Euclidean distance — lower = stricter matching

let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
  modelsLoaded = true;
  console.log('[face-api] Models loaded from', MODELS_PATH);
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Detects all faces in an image, saves cropped thumbnails, and inserts face
 * rows into the DB. Returns the number of faces found.
 */
async function processPhoto(photoId, imagePath, facesDir) {
  await loadModels();

  const img = await canvas.loadImage(imagePath);
  const detections = await faceapi
    .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (detections.length === 0) return 0;

  const imageBuffer = fs.readFileSync(imagePath);
  const meta = await sharp(imageBuffer).metadata();

  const insertFace = db.prepare(
    `INSERT INTO faces (photo_id, descriptor, thumb_file, bbox_x, bbox_y, bbox_w, bbox_h)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const det of detections) {
    const box = det.detection.box;

    // Add 20% padding around the face crop
    const pad = Math.floor(Math.min(box.width, box.height) * 0.2);
    const x = Math.max(0, Math.floor(box.x - pad));
    const y = Math.max(0, Math.floor(box.y - pad));
    const w = Math.min(meta.width - x, Math.floor(box.width + pad * 2));
    const h = Math.min(meta.height - y, Math.floor(box.height + pad * 2));

    const thumbFilename = `${uuidv4()}.jpg`;
    const thumbPath = path.join(facesDir, thumbFilename);

    await sharp(imageBuffer)
      .extract({ left: x, top: y, width: w, height: h })
      .resize(150, 150, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    insertFace.run(
      photoId,
      JSON.stringify(Array.from(det.descriptor)),
      thumbFilename,
      box.x, box.y, box.width, box.height
    );
  }

  return detections.length;
}

// ─── Clustering ───────────────────────────────────────────────────────────────

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function meanDescriptor(descriptors) {
  const len = descriptors[0].length;
  const mean = new Array(len).fill(0);
  for (const d of descriptors) {
    for (let i = 0; i < len; i++) mean[i] += d[i];
  }
  return mean.map(v => v / descriptors.length);
}

/**
 * Re-clusters all faces for an event using greedy nearest-centroid assignment.
 * Clears old clusters first and rebuilds from scratch.
 */
function reclusterEvent(eventId) {
  // Clear existing cluster assignments and cluster rows
  const oldClusters = db.prepare('SELECT id FROM face_clusters WHERE event_id = ?').all(eventId);
  for (const c of oldClusters) {
    db.prepare('UPDATE faces SET cluster_id = NULL WHERE cluster_id = ?').run(c.id);
  }
  db.prepare('DELETE FROM face_clusters WHERE event_id = ?').run(eventId);

  // Load all faces for this event
  const faces = db.prepare(`
    SELECT f.id, f.descriptor, f.thumb_file
    FROM faces f
    JOIN photos p ON f.photo_id = p.id
    WHERE p.event_id = ?
    ORDER BY f.id
  `).all(eventId);

  if (faces.length === 0) return;

  // Greedy clustering: assign each face to the nearest existing cluster or start new one
  const clusters = []; // { centroid, faceIds, descriptors, coverThumb }

  for (const face of faces) {
    const desc = JSON.parse(face.descriptor);
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const dist = euclidean(desc, clusters[i].centroid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestDist < CLUSTER_THRESHOLD) {
      clusters[bestIdx].faceIds.push(face.id);
      clusters[bestIdx].descriptors.push(desc);
      clusters[bestIdx].centroid = meanDescriptor(clusters[bestIdx].descriptors);
    } else {
      clusters.push({
        centroid: desc,
        faceIds: [face.id],
        descriptors: [desc],
        coverThumb: face.thumb_file,
      });
    }
  }

  // Persist clusters
  const insertCluster = db.prepare(
    `INSERT INTO face_clusters (event_id, centroid, cover_thumb) VALUES (?, ?, ?)`
  );
  const assignFace = db.prepare('UPDATE faces SET cluster_id = ? WHERE id = ?');

  for (const cluster of clusters) {
    const result = insertCluster.run(
      eventId,
      JSON.stringify(cluster.centroid),
      cluster.coverThumb
    );
    for (const faceId of cluster.faceIds) {
      assignFace.run(result.lastInsertRowid, faceId);
    }
  }

  console.log(`[cluster] Event ${eventId}: ${clusters.length} unique faces from ${faces.length} detections`);
}

// ─── Selfie matching ──────────────────────────────────────────────────────────

/**
 * Detects a single face in a selfie image and returns its 128-d descriptor.
 * Returns null if no face is detected.
 */
async function matchSelfie(imagePath) {
  await loadModels();

  const img = await canvas.loadImage(imagePath);
  const detection = await faceapi
    .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return null;
  return Array.from(detection.descriptor);
}

/**
 * Finds the cluster in an event whose centroid is closest to the given descriptor.
 * Returns the cluster row or null if no match is within CLUSTER_THRESHOLD.
 */
function findBestCluster(descriptor, eventId) {
  const clusters = db.prepare('SELECT * FROM face_clusters WHERE event_id = ?').all(eventId);
  let bestCluster = null;
  let bestDist = Infinity;

  for (const cluster of clusters) {
    const dist = euclidean(descriptor, JSON.parse(cluster.centroid));
    if (dist < bestDist) {
      bestDist = dist;
      bestCluster = cluster;
    }
  }

  return bestDist < CLUSTER_THRESHOLD ? bestCluster : null;
}

module.exports = { loadModels, processPhoto, reclusterEvent, matchSelfie, findBestCluster };
