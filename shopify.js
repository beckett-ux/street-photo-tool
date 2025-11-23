// shopify.js
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. yourstore.myshopify.com
const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';
const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;

// ---------- REST helper for non paginated calls (images, updates) ----------
async function shopifyRest(pathPart, options = {}) {
  const url = `https://${shopDomain}/admin/api/${apiVersion}${pathPart}`;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'X-Shopify-Access-Token': adminToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    console.error('Shopify REST non JSON response:', text);
    throw new Error(`Shopify REST returned non JSON, status ${res.status}`);
  }

  if (!res.ok) {
    console.error('Shopify REST error', res.status, json);
    throw new Error(`Shopify REST error ${res.status}`);
  }

  return json;
}

// ---------- pagination helper for products ----------

// Parse Link header to get the "next" URL if it exists
function getNextLink(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const [urlPart, relPart] = part.split(';').map(s => s.trim());
    if (relPart && relPart.includes('rel="next"')) {
      const match = urlPart.match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
}

// Load up to 1000 products (any status) via cursor based pagination
async function fetchAllProducts() {
  let all = [];

  // No status filter here. Filter in code.
  let url =
    `https://${shopDomain}/admin/api/${apiVersion}/products.json` +
    `?limit=250&fields=id,title,status,created_at,images&order=created_at+desc`;

  while (url) {
    console.log('Fetching products page:', url);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Accept': 'application/json'
      }
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error('Shopify REST non JSON response:', text);
      throw new Error(`Shopify REST returned non JSON, status ${res.status}`);
    }

    if (!res.ok) {
      console.error('Shopify REST error page fetch', res.status, json);
      throw new Error(`Shopify REST error ${res.status}`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    console.log('Page products count:', products.length);
    all = all.concat(products);

    // Stop once we have 1000 or more
    if (all.length >= 1000) {
      all = all.slice(0, 1000);
      console.log('Reached 1000 product limit, stopping pagination');
      break;
    }

    const linkHeader = res.headers.get('link');
    const nextUrl = getNextLink(linkHeader);
    if (nextUrl) {
      url = nextUrl;
    } else {
      url = null;
    }
  }

  console.log('Total products fetched across pages (capped at 1000):', all.length);
  return all;
}

// ---------- main: 30 most recent products without images ----------

function toSimpleProduct(p) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    created_at: p.created_at
  };
}

// Scan up to 1000 products, then take the 30 newest that have no images
async function getRecentProductsWithoutImages(limit = 30) {
  console.log('getRecentProductsWithoutImages: scanning products (max 1000)');

  const all = await fetchAllProducts();

  // Drop archived, keep active and draft etc
  const nonArchived = all.filter(
    p => (p.status || '').toLowerCase() !== 'archived'
  );

  const withoutImages = nonArchived.filter(
    p => !p.images || p.images.length === 0
  );

  console.log('Products with no images (before sort):', withoutImages.length);

  // Newest first by created_at
  withoutImages.sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  const top = withoutImages.slice(0, limit).map(toSimpleProduct);

  console.log(
    `Returning ${top.length} most recent products with no images (limit ${limit})`
  );

  return top;
}

// ---------- upload images + mark active ----------

async function uploadImagesToProduct(productId, localFilePaths) {
  const allowedExts = ['.jpg', '.jpeg', '.png', '.heic'];

  for (const filePath of localFilePaths) {
    // Skip files that disappeared or are not images
    if (!fs.existsSync(filePath)) {
      console.warn('File missing, skipping', filePath);
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExts.includes(ext)) {
      console.log('Skipping non image file during upload', filePath);
      continue;
    }

    const base64 = fs.readFileSync(filePath, { encoding: 'base64' });

    const body = {
      image: {
        attachment: base64
      }
    };

    const json = await shopifyRest(
      `/products/${productId}/images.json`,
      { method: 'POST', body }
    );

    const uploaded = json.image;
    console.log('Uploaded image for product', productId, 'image id:', uploaded && uploaded.id);
  }

  // Try to set status to active, ignore if it fails
  try {
    await shopifyRest(`/products/${productId}.json`, {
      method: 'PUT',
      body: {
        product: {
          id: productId,
          status: 'active'
        }
      }
    });
    console.log('Updated product status to active for', productId);
  } catch (err) {
    console.warn('Could not update product status for', productId, err.message);
  }
}

module.exports = {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
};
