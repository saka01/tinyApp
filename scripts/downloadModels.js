/**
 * Copies the required face-api.js model files from the npm package into
 * the local models/ directory so server.js can load them from a stable path.
 * Run once: node scripts/downloadModels.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');
const DEST = path.join(__dirname, '..', 'models');

const FILES = [
  // Tiny face detector (replaces SSD MobileNet v1 — ~4× faster)
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  // Shared by all detection pipelines
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

for (const file of FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DEST, file);
  if (fs.existsSync(dest)) {
    console.log(`  skip  ${file} (already exists)`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`  copied ${file}`);
}

console.log('\nModels ready in models/');
