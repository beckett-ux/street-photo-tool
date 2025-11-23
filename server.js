// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

const {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
} = require('./shopify');

const app = express();
const PORT = 3000;

// Folder where the camera drops files
const WATCH_DIR = path.join(__dirname, 'Watch');
// Folder where we archive uploaded photos
const UPLOADED_DIR = path.join(__dirname, 'Uploaded Photos');

let currentProduct = null;    // { id, title, created_at }
let queuedFiles = [];         // local file paths for current product

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

// Archive uploaded files into Uploaded Photos\<product title>\
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

// Middleware
app.use(express.json());

// Serve static files from project root
app.use(express.static(__dirname));

// Serve the Watch folder as /watch so the browser can render previews
app.use('/watch', express.static(WATCH_DIR));

// API route, last 100 recently created products with no photos
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

// Select current product to attach upcoming photos to
app.post('/api/select-product', (req, res) => {
  const { id, title, created_at } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'Missing product id' });
  }

  currentProduct = { id, title, created_at };
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

// Return queued photos with local URLs for preview
app.get('/api/queued-photos', (req, res) => {
  const photos = queuedFiles.map(filePath => {
    // Compute path relative to WATCH_DIR
    const relPath = path.relative(WATCH_DIR, filePath);
    // Normalize to URL style slashes
    const relWebPath = relPath.split(path.sep).join('/');
    const url = '/watch/' + relWebPath;

    return {
      url,
      name: path.basename(filePath),
      relPath: relWebPath
    };
  });

  res.json({ photos });
});

// Remove a single queued photo (and delete the file on disk)
app.post('/api/remove-photo', (req, res) => {
  const { relPath } = req.body || {};
  if (!relPath) {
    return res.status(400).json({ error: 'Missing relPath' });
  }

  const absPath = path.join(WATCH_DIR, relPath);
  const normalizedAbs = path.normalize(absPath);

  const index = queuedFiles.findIndex(p => path.normalize(p) === normalizedAbs);

  if (index === -1) {
    console.warn('Requested to remove photo not in queue:', relPath);
    // Optionally also delete file if it exists
    try {
      if (fs.existsSync(normalizedAbs)) {
        fs.unlinkSync(normalizedAbs);
        console.log('Deleted file on disk that was not in queue:', normalizedAbs);
      }
    } catch (e) {
      console.error('Error deleting file that was not in queue:', normalizedAbs, e);
    }
    return res.status(404).json({ error: 'Photo not found in queue' });
  }

  const [removedPath] = queuedFiles.splice(index, 1);

  try {
    if (fs.existsSync(removedPath)) {
      fs.unlinkSync(removedPath);
      console.log('Removed queued photo and deleted file:', removedPath);
    } else {
      console.log('Removed queued photo (file already gone):', removedPath);
    }
  } catch (e) {
    console.error('Error deleting queued photo file', removedPath, e);
    return res.status(500).json({ error: 'Failed to delete photo file' });
  }

  res.json({ ok: true });
});

// When user clicks Done, upload all queued images and publish
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
    console.log(`Uploading ${queuedFiles.length} images for product ${productId}`);
    await uploadImagesToProduct(productId, queuedFiles);

    // Move files into Uploaded Photos\<product title>\
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

// Start the server
app.listen(PORT, () => {
  console.log(`Street photo tool running at http://localhost:${PORT}`);
});
