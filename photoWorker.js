/**
 * Worker thread: loads face-api models once, then processes photos on demand.
 *
 * Image loading uses sharp → raw pixel buffer → tf.Tensor3D, which avoids the
 * `canvas` native addon entirely. (canvas uses NODE_MODULE registration and
 * cannot be loaded inside worker threads on Node.js 22.)
 *
 * Receives messages: { type: 'processPhoto', photoId, imagePath, facesDir }
 *                    { type: 'matchSelfie',  imagePath }
 * Sends back:        { ready: true }  (after init)
 *                    { type: 'processPhoto', success, photoId, faces | error }
 *                    { type: 'matchSelfie',  success, descriptor | error }
 */

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const tf = require('@tensorflow/tfjs-node');
const faceapi = require('@vladmandic/face-api');
const { v4: uuidv4 } = require('uuid');

const MODELS_PATH = path.join(__dirname, 'models');
// Longest edge to resize to before running inference.
// 640px gives a good accuracy/speed tradeoff with the tiny face detector.
const DETECT_SIZE = 640;

// ─── Image loading (no canvas) ────────────────────────────────────────────────

/**
 * Decodes an image file (or buffer) into a tf.Tensor3D [H, W, 3] using sharp.
 * Returns { tensor, width, height } — caller must tensor.dispose() when done.
 */
async function imageToTensor(source) {
  const pipeline = typeof source === 'string' ? sharp(source) : sharp(source);
  const { data, info } = await pipeline
    .removeAlpha()                     // force 3-channel RGB
    .resize(DETECT_SIZE, DETECT_SIZE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  return { tensor, width: info.width, height: info.height };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);

  parentPort.on('message', async (msg) => {
    try {
      if (msg.type === 'processPhoto') {
        const faces = await processPhoto(msg.imagePath, msg.facesDir);
        parentPort.postMessage({ type: 'processPhoto', success: true, photoId: msg.photoId, faces });
      } else if (msg.type === 'matchSelfie') {
        const descriptor = await detectSelfie(msg.imagePath);
        parentPort.postMessage({ type: 'matchSelfie', success: true, descriptor });
      }
    } catch (err) {
      parentPort.postMessage({ type: msg.type, success: false, photoId: msg.photoId, error: err.message });
    }
  });

  parentPort.postMessage({ ready: true });
}

// ─── Photo processing ─────────────────────────────────────────────────────────

async function processPhoto(imagePath, facesDir) {
  const { width: origW, height: origH } = await sharp(imagePath).metadata();

  const { tensor, width: detW, height: detH } = await imageToTensor(imagePath);

  let detections;
  try {
    detections = await faceapi
      .detectAllFaces(tensor, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  } finally {
    tensor.dispose();
  }

  if (detections.length === 0) return [];

  // Scale bboxes from detection-resolution back to original image coordinates
  const scaleX = origW / detW;
  const scaleY = origH / detH;

  const origBuf = fs.readFileSync(imagePath);
  const results = [];

  for (const det of detections) {
    const b = det.detection.box;
    const ox = b.x * scaleX;
    const oy = b.y * scaleY;
    const ow = b.width * scaleX;
    const oh = b.height * scaleY;

    // 20% padding for a natural-looking face crop
    const pad = Math.floor(Math.min(ow, oh) * 0.2);
    const x = Math.max(0, Math.floor(ox - pad));
    const y = Math.max(0, Math.floor(oy - pad));
    const w = Math.min(origW - x, Math.floor(ow + pad * 2));
    const h = Math.min(origH - y, Math.floor(oh + pad * 2));

    const thumbFilename = `${uuidv4()}.jpg`;
    await sharp(origBuf)
      .extract({ left: x, top: y, width: w, height: h })
      .resize(150, 150, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(path.join(facesDir, thumbFilename));

    results.push({
      thumbFile: thumbFilename,
      descriptor: Array.from(det.descriptor),
      bbox: { x: ox, y: oy, w: ow, h: oh },
    });
  }

  return results;
}

// ─── Selfie matching ──────────────────────────────────────────────────────────

async function detectSelfie(imagePath) {
  const { tensor } = await imageToTensor(imagePath);

  let det;
  try {
    det = await faceapi
      .detectSingleFace(tensor, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
  } finally {
    tensor.dispose();
  }

  return det ? Array.from(det.descriptor) : null;
}

// ─── Start ────────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error('[worker] init failed:', err.message);
  process.exit(1);
});
