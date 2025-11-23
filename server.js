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
const PORT = 3000;

// Folder where the camera drops files
const WATCH_DIR = process.env.PHOTO_WATCH_DIR
  ? path.resolve(process.env.PHOTO_WATCH_DIR)
  : path.join(__dirname, 'Watch');

// Folder where we archive uploaded photos
const UPLOADED_DIR = path.join(__dirname, 'Uploaded Photos');

// Folder where we write cropped square versions for upload
const CROPPED_DIR = path.join(__dirname, 'CroppedTemp');

let currentProduct = null;    // { id, title, sku, created_at }
let queuedFiles = [];         // absolute file paths for current product

// Helper to sanitize product title for Windows folder name
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return 'product';

  // Remove invalid Windows chars: < > : " / \ | ? *
  let cleaned = name.replace(/[<>:"/\\|?*]/g, '');
  // Collapse whitespace, trim, limit length
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) cleaned = 'product';
  if (cleaned.length > 60) cleaned = cleaned.slice(0, 60);

  return cleaned;
}

// Archive uploaded files into "Uploaded Photos\<product title>\"
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

      // Move the file
      fs.renameSync(filePath, destPath);
      console.log('Archived file to', destPath);
    } catch (e) {
      console.error('Error archiving file', filePath, e);
    }
  });
}

// Crop an image to a centered square and write to CROPPED_DIR
// Returns the path of the cropped file, or the original path if cropping fails
async function cropImageToSquare(filePath) {
  try {
    await fs.promises.mkdir(CROPPED_DIR, { recursive: true });

    const image = sharp(filePath);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
      console.warn('Cannot read image dimensions, skipping crop for', filePath);
      return filePath;
    }

    if (width === height) {
      // Already square
      console.log('Already square, skipping crop for', filePath);
      // Still copy to CROPPED_DIR so upload uses files from one place
      const base = path.basename(filePath);
      const outPathSame = path.join(CROPPED_DIR, base);
      await sharp(filePath).toFile(outPathSame);
      return outPathSame;
    }

    const size = Math.min(width, height);
    const left = Math.floor((width - size) / 2);
    const top = Math.floor((height - size) / 2);

    const base = path.basename(filePath);
    const ext = path.extname(base);
    const nameWithout = path.basename(base, ext);
    const outPath = path.join(
      CROPPED_DIR,
      `${nameWithout}-square${ext || '.jpg'}`
    );

    await sharp(filePath)
      .extract({ left, top, width: size, height: size })
      .toFile(outPath);

    console.log('Cropped image saved to', outPath);
    return outPath;
  } catch (err) {
    console.error('Error cropping image to square for', filePath, err);
    // Fall back to original if cropping fails
    return filePath;
  }
}

// Express setup
app.use(express.json());
app.use(express.static(__dirname));

// API route, recent products with no photos (up to 100 per store)
app.get('/api/products-without-photos', async (req, res) => {
  const storeRaw = req.query.store || 'ALL';
  const store = String(storeRaw).toUpperCase(); // DMV, CLT, or ALL

  console.log('GET /api/products-without-photos store =', store);

  try {
    // Grab a larger batch so filtering by store still leaves up to 100
    const products = await getRecentProductsWithoutImages(300);

    let filtered = products || [];

    if (store === 'DMV' || store === 'CLT') {
      filtered = filtered.filter(p => {
        if (!p.tags) return false;

        let tagsList;
        if (Array.isArray(p.tags)) {
          tagsList = p.tags.map(t => String(t).trim().toUpperCase());
        } else {
          tagsList = String(p.tags)
            .split(',')
            .map(t => t.trim().toUpperCase())
            .filter(Boolean);
        }

        return tagsList.includes(store);
      });
    }

    // Keep only the most recent 100 entries for that store
    if (filtered.length > 100) {
      filtered = filtered.slice(0, 100);
    }

    res.json(filtered);
  } catch (err) {
    console.error('Error in /api/products-without-photos', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Select current product to attach upcoming photos to
app.post('/api/select-product', (req, res) => {
  const { id, title, sku, created_at } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'Missing product id' });
  }

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

// Get current product and queue length
app.get('/api/current-product', (req, res) => {
  res.json({
    product: currentProduct,
    queuedCount: queuedFiles.length
  });
});

// Serve preview of a queued image (by relative path under WATCH_DIR)
app.get('/photo-preview', (req, res) => {
  const rel = req.query.file;
  if (!rel) {
    return res.status(400).send('Missing file parameter');
  }

  const absPath = path.resolve(WATCH_DIR, rel);

  // Basic safety check, prevent path escape
  if (!absPath.startsWith(path.normalize(WATCH_DIR))) {
    return res.status(400).send('Invalid path');
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).send('File not found');
  }

  res.sendFile(absPath);
});

// Get queued photos for preview
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

// Remove a queued photo (and delete the file from disk)
app.post('/api/remove-photo', (req, res) => {
  const { relPath } = req.body || {};
  if (!relPath) {
    return res.status(400).json({ error: 'Missing relPath' });
  }

  const absPath = path.resolve(WATCH_DIR, relPath);

  // Filter out from queue
  const before = queuedFiles.length;
  queuedFiles = queuedFiles.filter(p => path.normalize(p) !== path.normalize(absPath));

  // Best effort delete from disk
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

// Reorder queued photos based on an array of relPath values
app.post('/api/reorder-photos', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'Missing order array' });
  }

  const normalize = p => path.normalize(p);
  const relToAbs = rel => path.resolve(WATCH_DIR, rel);

  const newQueued = [];
  order.forEach(rel => {
    const abs = relToAbs(rel);
    const found = queuedFiles.find(p => normalize(p) === normalize(abs));
    if (found) {
      newQueued.push(found);
    }
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

// When user clicks Done, crop all queued images to squares and upload
app.post('/api/done', async (req, res) => {
  if (!currentProduct) {
    return res.status(400).json({ error: 'No product selected' });
  }
  if (queuedFiles.length === 0) {
    return res.status(400).json({ error: 'No files queued' });
  }

  const productId = currentProduct.id;
  const filesToArchive = [...queuedFiles];

  try {
    console.log(`Cropping ${queuedFiles.length} images to square for product ${productId}`);
    const croppedPaths = await Promise.all(
      queuedFiles.map(filePath => cropImageToSquare(filePath))
    );

    console.log(`Uploading ${croppedPaths.length} cropped images for product ${productId}`);
    await uploadImagesToProduct(productId, croppedPaths);

    // Move original files into Uploaded Photos\<product title>\
    archiveUploadedFiles(currentProduct, filesToArchive);

    // Reset state for next product
    currentProduct = null;
    queuedFiles = [];

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/done:', err);
    res.status(500).json({ error: 'Upload or publish failed' });
  }
});

// Serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Watch the folder for new images
console.log('Watching folder:', WATCH_DIR);

const allowedExts = ['.jpg', '.jpeg', '.png', '.heic'];

chokidar
  .watch(WATCH_DIR, {
    ignored: /(^|[\/\\])\../,
    persistent: true
  })
  .on('add', filePath => {
    console.log('File added in Watch:', filePath);

    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExts.includes(ext)) {
      console.log('Ignoring non image file in Watch:', filePath);
      return;
    }

    if (currentProduct) {
      queuedFiles.push(filePath);
      console.log(
        'Queued for product',
        currentProduct.id,
        'total queued',
        queuedFiles.length
      );
    } else {
      console.log('No current product selected, ignoring new file for now');
    }
  });

// Shutdown route for Close button
app.post('/api/shutdown', (req, res) => {
  console.log('Shutdown requested from UI');
  res.json({ ok: true });

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Safety timer in case close hangs
  setTimeout(() => {
    console.log('Forcing shutdown');
    process.exit(0);
  }, 3000);
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Street photo tool running at http://localhost:${PORT}`);
});
