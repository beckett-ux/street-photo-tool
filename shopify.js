// shopify.js
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || '')
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');

const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';
const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;

if (!shopDomain) throw new Error('Missing SHOPIFY_SHOP_DOMAIN in .env');
if (!adminToken) throw new Error('Missing SHOPIFY_ADMIN_TOKEN in .env');

const REQUIRED_PUBLICATION_NAMES = [
  'Online Store',
  'Point of Sale',
  'Google & YouTube',
  'Facebook & Instagram'
];

let cachedPublicationIds = null;

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

async function shopifyGraphql(query, variables = {}) {
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': adminToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    console.error('Shopify GraphQL non JSON response:', text);
    throw new Error(`Shopify GraphQL returned non JSON, status ${res.status}`);
  }

  if (!res.ok) {
    console.error('Shopify GraphQL HTTP error', res.status, json);
    throw new Error(`Shopify GraphQL HTTP error ${res.status}`);
  }

  if (json.errors && json.errors.length) {
    console.error('Shopify GraphQL errors', JSON.stringify(json.errors, null, 2));
    throw new Error('Shopify GraphQL returned errors');
  }

  return json.data;
}

async function getRequiredPublicationIds() {
  if (cachedPublicationIds && cachedPublicationIds.length) return cachedPublicationIds;

  const query = `
    query ListPublications {
      publications(first: 50) {
        edges {
          node {
            id
            name
            catalog { title }
          }
        }
      }
    }
  `;

  let data;
  try {
    data = await shopifyGraphql(query);
  } catch (err) {
    console.error('Failed to load publications via GraphQL', err);
    return [];
  }

  const edges = data?.publications?.edges || [];
  const publicationIds = [];
  const missing = [];

  REQUIRED_PUBLICATION_NAMES.forEach(required => {
    const requiredLower = required.toLowerCase();

    const match = edges.find(edge => {
      const node = edge?.node;
      if (!node) return false;

      const labelParts = [];
      if (node.name) labelParts.push(String(node.name));
      if (node.catalog?.title) labelParts.push(String(node.catalog.title));

      const label = labelParts.join(' ').toLowerCase();
      return label.includes(requiredLower);
    });

    if (match) publicationIds.push(match.node.id);
    else missing.push(required);
  });

  if (missing.length) console.warn('Could not find publication ids for channels:', missing.join(', '));
  if (!publicationIds.length) console.warn('No publication ids found. Products will not be published.');

  cachedPublicationIds = publicationIds;
  return publicationIds;
}

async function publishProductToDefaultSalesChannels(productId) {
  const publicationIds = await getRequiredPublicationIds();
  if (!publicationIds.length) return;

  const productGid = `gid://shopify/Product/${productId}`;

  const mutation = `
    mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }
  `;

  const input = publicationIds.map(publicationId => ({ publicationId }));

  let data;
  try {
    data = await shopifyGraphql(mutation, { id: productGid, input });
  } catch (err) {
    console.error('GraphQL error while publishing product', err);
    return;
  }

  const userErrors = data?.publishablePublish?.userErrors || [];
  if (userErrors.length) {
    console.error('publishablePublish userErrors:', JSON.stringify(userErrors, null, 2));
    return;
  }

  console.log(`Published product ${productId} to ${publicationIds.length} sales channels`);
}

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

async function fetchAllProductsFromUrl(startUrl) {
  let all = [];
  let url = startUrl;

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

    if (json && (json.errors || json.error)) {
      console.error('Shopify REST returned error payload:', json);
      throw new Error('Shopify REST returned an error payload');
    }

    const products = Array.isArray(json.products) ? json.products : [];
    console.log('Page products count:', products.length);

    all = all.concat(products);

    if (all.length >= 1000) {
      all = all.slice(0, 1000);
      console.log('Reached 1000 product limit, stopping pagination');
      break;
    }

    const linkHeader = res.headers.get('link');
    const nextUrl = getNextLink(linkHeader);
    url = nextUrl || null;
  }

  console.log('Total products fetched across pages (capped at 1000):', all.length);
  return all;
}

async function fetchAllProducts() {
  const baseUrl = `https://${shopDomain}/admin/api/${apiVersion}/products.json`;
  const fields = 'id,title,status,created_at,images,variants';

  // IMPORTANT: no status=any
  const paramsPrimary = new URLSearchParams({
    limit: '250',
    fields,
    order: 'created_at desc'
  });

  let all = await fetchAllProductsFromUrl(`${baseUrl}?${paramsPrimary.toString()}`);

  if (all.length === 0) {
    console.warn('Primary fetch returned 0. Retrying without order param...');
    const paramsNoOrder = new URLSearchParams({ limit: '250', fields });
    all = await fetchAllProductsFromUrl(`${baseUrl}?${paramsNoOrder.toString()}`);
  }

  if (all.length === 0) {
    console.warn('Retry still returned 0. Retrying with only limit=250...');
    const paramsMin = new URLSearchParams({ limit: '250' });
    all = await fetchAllProductsFromUrl(`${baseUrl}?${paramsMin.toString()}`);
  }

  return all;
}

function toSimpleProduct(p) {
  let sku = null;
  if (Array.isArray(p.variants) && p.variants.length > 0) {
    sku = p.variants[0].sku || null;
  }

  return {
    id: p.id,
    title: p.title,
    status: p.status,
    created_at: p.created_at,
    sku
  };
}

async function getRecentProductsWithoutImages(limit = 30) {
  console.log('getRecentProductsWithoutImages: scanning products (max 1000)');

  const all = await fetchAllProducts();

  const nonArchived = all.filter(p => (p.status || '').toLowerCase() !== 'archived');

  const inStock = nonArchived.filter(p => {
    if (!Array.isArray(p.variants) || p.variants.length === 0) return false;
    return p.variants.some(variant => Number(variant.inventory_quantity) >= 1);
  });

  const withoutImages = inStock.filter(p => !p.images || p.images.length === 0);

  console.log('Products with no images (before sort):', withoutImages.length);

  withoutImages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const top = withoutImages.slice(0, limit).map(toSimpleProduct);

  console.log(`Returning ${top.length} most recent products with no images (limit ${limit})`);
  return top;
}

async function uploadImagesToProduct(productId, images) {
  const allowedExts = ['.jpg', '.jpeg', '.png', '.heic'];

  for (const image of images) {
    const filePath = typeof image === 'string' ? image : image && image.filePath;
    const filename = typeof image === 'string'
      ? path.basename(image)
      : image && image.filename;
    const buffer = image && image.buffer;

    const ext = filename ? path.extname(filename).toLowerCase() : null;
    if (!ext || !allowedExts.includes(ext)) {
      console.log('Skipping non image file during upload', filename || filePath);
      continue;
    }

    let base64 = null;
    if (buffer) {
      base64 = buffer.toString('base64');
    } else if (filePath) {
      if (!fs.existsSync(filePath)) {
        console.warn('File missing, skipping', filePath);
        continue;
      }
      base64 = fs.readFileSync(filePath, { encoding: 'base64' });
    } else {
      console.warn('No image data provided, skipping');
      continue;
    }

    const body = {
      image: {
        attachment: base64,
        filename
      }
    };

    const json = await shopifyRest(`/products/${productId}/images.json`, { method: 'POST', body });

    const uploaded = json.image;
    console.log('Uploaded image for product', productId, 'image id:', uploaded && uploaded.id);
  }

  try {
    await shopifyRest(`/products/${productId}.json`, {
      method: 'PUT',
      body: { product: { id: productId, status: 'active' } }
    });
    console.log('Updated product status to active for', productId);
  } catch (err) {
    console.warn('Could not update product status for', productId, err.message);
  }

  try {
    await publishProductToDefaultSalesChannels(productId);
  } catch (err) {
    console.error('Failed to publish product to default sales channels', err);
  }
}

module.exports = {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
};
