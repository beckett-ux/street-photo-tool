// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const sharp = require('sharp');
const localPaths = require('./paths');

const {
  getActiveLocations,
  getRecentProductsWithoutImages,
  uploadImagesToProduct
} = require('./shopify');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Folder where employees drop files
const watchDirOverride = localPaths.PHOTO_WATCH_DIR;

if (!watchDirOverride) {
  throw new Error('PHOTO_WATCH_DIR is required in paths.txt');
}

const WATCH_DIR = path.resolve(watchDirOverride);

const JPEG_QUALITY = 92;

let currentProduct = null;    // { id, title, sku, created_at }
let queuedFiles = [];         // absolute file paths for current product

function deleteUploadedFiles(files) {
  if (!files || files.length === 0) return;

  files.forEach(filePath => {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn('File missing when deleting, skipping', filePath);
        return;
      }
      fs.unlinkSync(filePath);
      console.log('Deleted uploaded file', filePath);
    } catch (e) {
      console.error('Error deleting file', filePath, e);
    }
  });
}

// Normalize EXIF orientation + crop to a centered square, then re-encode as JPEG.
// This removes EXIF orientation so Shopify displays correctly.
async function cropImageToSquare(filePath) {
  try {
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const filename = `${baseName}-square.jpg`;

    const meta = await sharp(filePath).metadata();
    const width = meta.width;
    const height = meta.height;

    if (!width || !height) {
      console.warn('Cannot read image dimensions, normalizing without crop for', filePath);
      const buffer = await sharp(filePath)
        .rotate()
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      return { filename, buffer };
    }

    // metadata.width/height are from the file as-stored. If EXIF orientation rotates 90/270,
    // swap to compute post-rotate crop coordinates.
    const orientation = meta.orientation || 1;
    let rotatedW = width;
    let rotatedH = height;
    if ([5, 6, 7, 8].includes(orientation)) {
      rotatedW = height;
      rotatedH = width;
    }

    const size = Math.min(rotatedW, rotatedH);
    const left = Math.floor((rotatedW - size) / 2);
    const top = Math.floor((rotatedH - size) / 2);

    let pipeline = sharp(filePath).rotate();

    // Only crop if needed (still re-encode either way)
    if (rotatedW !== rotatedH) {
      pipeline = pipeline.extract({ left, top, width: size, height: size });
    }

    const buffer = await pipeline
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    console.log('Normalized + square image prepared for upload:', filename);
    return { filename, buffer };
  } catch (err) {
    console.error('Error normalizing/cropping image for', filePath, err);
    // Fall back to original if processing fails
    try {
      const buffer = await fs.promises.readFile(filePath);
      return { filename: path.basename(filePath), buffer };
    } catch (readErr) {
      console.error('Error reading original image after crop failure', filePath, readErr);
      throw readErr;
    }
  }
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/stores', async (req, res) => {
  const allowedStores = Array.isArray(localPaths.STORES_LIST) ? localPaths.STORES_LIST : [];
  if (allowedStores.length) {
    return res.json({ stores: allowedStores.map(name => ({ name })), source: 'paths' });
  }

  try {
    const locations = await getActiveLocations();
    if (locations.length) {
      const stores = locations.map(location => ({
        id: location.id,
        name: location.name,
        city: location.city || null,
        province: location.province || null,
        country: location.country || null
      }));
      return res.json({ stores, source: 'shopify' });
    }
  } catch (err) {
    console.warn('Failed to load Shopify locations, falling back to paths.txt', err.message);
  }

  const stores = Array.isArray(localPaths.STORES_LIST) ? localPaths.STORES_LIST : [];
  res.json({ stores: stores.map(name => ({ name })), source: 'paths' });
});

app.get('/api/products-without-photos', async (req, res) => {
  console.log('GET /api/products-without-photos');
  try {
    const storeName = typeof req.query.store === 'string' ? req.query.store.trim() : '';
    const storeLocationId =
      storeName && localPaths.STORES_MAP ? localPaths.STORES_MAP[storeName] : null;
    const result = await getRecentProductsWithoutImages(100, {
      storeName: storeName || null,
      storeLocationId: storeLocationId || null
    });
    res.json(result);
  } catch (err) {
    console.error('Error in /api/products-without-photos', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

app.post('/api/select-product', (req, res) => {
  const { id, title, sku, created_at } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing product id' });

  currentProduct = {
    id,
    title: title || '',
    sku: sku || null,
    created_at: created_at || null
  };
  queuedFiles = [];
  console.log('Selected product:', currentProduct);
  res.json({ ok: true });
});

app.get('/api/current-product', (req, res) => {
  res.json({ product: currentProduct, queuedCount: queuedFiles.length });
});

app.get('/photo-preview', (req, res) => {
  const rel = req.query.file;
  if (!rel) return res.status(400).send('Missing file parameter');

  const absPath = path.resolve(WATCH_DIR, rel);

  if (!absPath.startsWith(path.normalize(WATCH_DIR))) {
    return res.status(400).send('Invalid path');
  }
  if (!fs.existsSync(absPath)) return res.status(404).send('File not found');

  res.sendFile(absPath);
});

app.get('/api/queued-photos', (req, res) => {
  try {
    const photos = queuedFiles.map(filePath => {
      const relPath = path.relative(WATCH_DIR, filePath).replace(/\\/g, '/');
      return {
        name: path.basename(filePath),
        relPath,
        url: `/photo-preview?file=${encodeURIComponent(relPath)}`
      };
    });

    res.json({ photos });
  } catch (err) {
    console.error('Error in /api/queued-photos', err);
    res.status(500).json({ error: 'Failed to read queued photos' });
  }
});

app.post('/api/remove-photo', (req, res) => {
  const { relPath } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'Missing relPath' });

  const absPath = path.resolve(WATCH_DIR, relPath);

  const before = queuedFiles.length;
  queuedFiles = queuedFiles.filter(p => path.normalize(p) !== path.normalize(absPath));

  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      console.log('Removed queued photo file', absPath);
    }
  } catch (err) {
    console.error('Error deleting file', absPath, err);
  }

  console.log('Removed photo from queue, count before/after:', before, queuedFiles.length);
  res.json({ ok: true, queuedCount: queuedFiles.length });
});

app.post('/api/reorder-photos', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Missing order array' });

  const normalize = p => path.normalize(p);
  const relToAbs = rel => path.resolve(WATCH_DIR, rel);

  const newQueued = [];
  order.forEach(rel => {
    const abs = relToAbs(rel);
    const found = queuedFiles.find(p => normalize(p) === normalize(abs));
    if (found) newQueued.push(found);
  });

  if (!newQueued.length) {
    console.warn('Reorder request did not match any queued files');
    return res.status(400).json({ error: 'Reorder did not match current queue' });
  }

  if (newQueued.length !== queuedFiles.length) {
    console.warn('Reorder did not include all queued files, appending leftovers at end');
    const leftovers = queuedFiles.filter(p => !newQueued.includes(p));
    queuedFiles = newQueued.concat(leftovers);
  } else {
    queuedFiles = newQueued;
  }

  console.log('Reordered queued files, new order length:', queuedFiles.length);
  res.json({ ok: true });
});

app.post('/api/done', async (req, res) => {
  if (!currentProduct) return res.status(400).json({ error: 'No product selected' });
  if (queuedFiles.length === 0) return res.status(400).json({ error: 'No files queued' });

  const productId = currentProduct.id;
  const filesToDelete = [...queuedFiles];

  try {
    console.log(`Normalizing + cropping ${queuedFiles.length} images for product ${productId}`);
    const croppedImages = await Promise.all(queuedFiles.map(cropImageToSquare));

    console.log(`Uploading ${croppedImages.length} images for product ${productId}`);
    await uploadImagesToProduct(productId, croppedImages);

    deleteUploadedFiles(filesToDelete);

    currentProduct = null;
    queuedFiles = [];

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/done:', err);
    res.status(500).json({ error: 'Upload or publish failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

console.log('Watching folder:', WATCH_DIR);

const allowedExts = ['.jpg', '.jpeg', '.png', '.heic'];

chokidar
  .watch(WATCH_DIR, { ignored: /(^|[\/\\])\../, persistent: true })
  .on('add', filePath => {
    console.log('File added in Watch:', filePath);

    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExts.includes(ext)) {
      console.log('Ignoring non image file in Watch:', filePath);
      return;
    }

    if (currentProduct) {
      queuedFiles.push(filePath);
      console.log('Queued for product', currentProduct.id, 'total queued', queuedFiles.length);
    } else {
      console.log('No current product selected, ignoring new file for now');
    }
  });

app.post('/api/shutdown', (req, res) => {
  console.log('Shutdown requested from UI');
  res.json({ ok: true });

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('Forcing shutdown');
    process.exit(0);
  }, 3000);
});

const server = app.listen(PORT, () => {
  console.log(`Street photo tool running at http://localhost:${PORT}`);
});
