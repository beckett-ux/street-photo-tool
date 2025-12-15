// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const sharp = require('sharp');

const {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
} = require('./shopify');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Folder where employees drop files
const WATCH_DIR = (process.env.WATCH_FOLDER || process.env.PHOTO_WATCH_DIR)
  ? path.resolve(process.env.WATCH_FOLDER || process.env.PHOTO_WATCH_DIR)
  : path.join(__dirname, 'Watch');

// Folder where we archive uploaded photos
const UPLOADED_DIR = (process.env.UPLOADED_PHOTOS_FOLDER)
  ? path.resolve(process.env.UPLOADED_PHOTOS_FOLDER)
  : path.join(__dirname, 'Uploaded Photos');

// Folder where we write normalized + square-cropped versions for upload
const CROPPED_DIR = path.join(__dirname, 'CroppedTemp');

const JPEG_QUALITY = 92;

let currentProduct = null;    // { id, title, sku, created_at }
let queuedFiles = [];         // absolute file paths for current product

function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return 'product';
  let cleaned = name.replace(/[<>:"/\\|?*]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) cleaned = 'product';
  if (cleaned.length > 60) cleaned = cleaned.slice(0, 60);
  return cleaned;
}

function archiveUploadedFiles(product, files) {
  if (!product || !files || files.length === 0) return;

  const folderName = sanitizeFolderName(product.title);
  const destDir = path.join(UPLOADED_DIR, folderName);

  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    console.error('Could not create archive folder', destDir, e);
    return;
  }

  files.forEach(filePath => {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn('File missing when archiving, skipping', filePath);
        return;
      }
      const fileName = path.basename(filePath);
      const destPath = path.join(destDir, fileName);
      fs.renameSync(filePath, destPath);
      console.log('Archived file to', destPath);
    } catch (e) {
      console.error('Error archiving file', filePath, e);
    }
  });
}

// Normalize EXIF orientation + crop to a centered square, then re-encode as JPEG.
// This removes EXIF orientation so Shopify displays correctly.
async function cropImageToSquare(filePath) {
  try {
    await fs.promises.mkdir(CROPPED_DIR, { recursive: true });

    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const outPath = path.join(CROPPED_DIR, `${baseName}-square.jpg`);

    const meta = await sharp(filePath).metadata();
    const width = meta.width;
    const height = meta.height;

    if (!width || !height) {
      console.warn('Cannot read image dimensions, normalizing without crop for', filePath);
      await sharp(filePath)
        .rotate()
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(outPath);
      return outPath;
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

    await pipeline
      .jpeg({ quality: JPEG_QUALITY })
      .toFile(outPath);

    console.log('Normalized + square image saved to', outPath);
    return outPath;
  } catch (err) {
    console.error('Error normalizing/cropping image for', filePath, err);
    // Fall back to original if processing fails
    return filePath;
  }
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/products-without-photos', async (req, res) => {
  console.log('GET /api/products-without-photos');
  try {
    const products = await getRecentProductsWithoutImages(100);
    res.json(products);
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
  const filesToArchive = [...queuedFiles];

  try {
    console.log(`Normalizing + cropping ${queuedFiles.length} images for product ${productId}`);
    const croppedPaths = await Promise.all(queuedFiles.map(cropImageToSquare));

    console.log(`Uploading ${croppedPaths.length} images for product ${productId}`);
    await uploadImagesToProduct(productId, croppedPaths);

    archiveUploadedFiles(currentProduct, filesToArchive);

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
