// shopify.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Use global fetch if available (Node 18+), otherwise try node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // node-fetch v2
    // eslint-disable-next-line global-require
    fetchFn = require('node-fetch');
    if (fetchFn.default) {
      fetchFn = fetchFn.default;
    }
  } catch (err) {
    throw new Error(
      'Fetch API not available. Run on Node 18+ or install node-fetch as a dependency.'
    );
  }
}

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.warn(
    'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN environment variables for Shopify.'
  );
}

const BASE_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`;

/**
 * Internal helper for GET calls to Shopify
 * @param {string} resourcePath like "/products.json"
 * @param {object} params query params
 */
async function shopifyGet(resourcePath, params = {}) {
  const url = new URL(BASE_URL + resourcePath);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.append(key, String(value));
    }
  });

  // Log for debugging
  console.log('Fetching products page:', url.toString());

  const res = await fetchFn(url.toString(), {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Shopify GET error', res.status, text);
    throw new Error(`Shopify GET ${resourcePath} failed with status ${res.status}`);
  }

  const json = await res.json();
  return { json, headers: res.headers };
}

/**
 * Internal helper for POST calls to Shopify
 */
async function shopifyPost(resourcePath, body) {
  const url = BASE_URL + resourcePath;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Shopify POST error', res.status, text);
    throw new Error(`Shopify POST ${resourcePath} failed with status ${res.status}`);
  }

  return res.json();
}

/**
 * Internal helper for PUT calls to Shopify
 */
async function shopifyPut(resourcePath, body) {
  const url = BASE_URL + resourcePath;

  const res = await fetchFn(url, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Shopify PUT error', res.status, text);
    throw new Error(`Shopify PUT ${resourcePath} failed with status ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch recent products that have no images.
 * Returns an array of objects:
 * {
 *   id,
 *   title,
 *   status,
 *   created_at,
 *   sku   // first variant SKU
 * }
 */
async function getRecentProductsWithoutImages(limit = 100) {
  const perPage = 250;
  const collected = [];
  let pageInfo = null;
  let firstLoop = true;

  while (collected.length < limit && (firstLoop || pageInfo)) {
    firstLoop = false;

    const params = {
      limit: perPage,
      status: 'any',
      order: 'created_at desc',
      // include variants so we can read SKU
      fields: 'id,title,status,created_at,images,variants'
    };

    if (pageInfo) {
      params.page_info = pageInfo;
    }

    const { json, headers } = await shopifyGet('/products.json', params);
    const products = json.products || [];
    console.log('Page products count:', products.length);

    if (!products.length) {
      break;
    }

    const withoutImages = products.filter(p => !p.images || p.images.length === 0);

    withoutImages.forEach(p => {
      const firstVariant =
        Array.isArray(p.variants) && p.variants.length > 0 ? p.variants[0] : null;
      collected.push({
        id: p.id,
        title: p.title,
        status: p.status,
        created_at: p.created_at,
        sku: firstVariant && firstVariant.sku ? firstVariant.sku : ''
      });
    });

    const linkHeader = headers.get('link') || headers.get('Link');
    if (!linkHeader) {
      break;
    }

    const nextPart = linkHeader
      .split(',')
      .map(s => s.trim())
      .find(part => part.includes('rel="next"'));

    if (!nextPart) {
      break;
    }

    const match = nextPart.match(/<([^>]+)>/);
    if (!match) {
      break;
    }

    const nextUrl = new URL(match[1]);
    pageInfo = nextUrl.searchParams.get('page_info');
    if (!pageInfo) {
      break;
    }
  }

  collected.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  console.log('Total products with no images collected:', collected.length);

  return collected.slice(0, limit);
}

/**
 * Upload an array of local image files to a Shopify product,
 * then set the product status to active.
 *
 * @param {number|string} productId
 * @param {string[]} filePaths absolute or relative file paths
 */
async function uploadImagesToProduct(productId, filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    console.log('No files to upload for product', productId);
    return;
  }

  for (const filePath of filePaths) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      console.warn('File not found when uploading to Shopify, skipping:', fullPath);
      continue;
    }

    const fileBuffer = fs.readFileSync(fullPath);
    const attachment = fileBuffer.toString('base64');

    const payload = {
      image: {
        attachment,
        filename: path.basename(fullPath)
      }
    };

    console.log(`Uploading image ${fullPath} to product ${productId}`);
    await shopifyPost(`/products/${productId}/images.json`, payload);
  }

  // Publish product by setting status to active
  try {
    console.log('Publishing product', productId);
    await shopifyPut(`/products/${productId}.json`, {
      product: {
        id: productId,
        status: 'active'
      }
    });
  } catch (err) {
    console.error('Failed to publish product', productId, err);
  }
}

module.exports = {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
};
