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
app.use(express.static(__dirname));

// API route, last 30 recently created products with no photos
app.get('/api/products-without-photos', async (req, res) => {
  try {
    console.log('GET /api/products-without-photos');
    const products = await getRecentProductsWithoutImages(30);
    res.json(products);
  } catch (err) {
    console.error('products-without-photos error', err);
    res.status(500).json({ error: 'Failed to fetch products from Shopify' });
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
