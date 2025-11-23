// shopify.js
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. yourstore.myshopify.com
const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';
const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;

// Sales channels we want every product published to
const REQUIRED_PUBLICATION_NAMES = [
  'Online Store',
  'Point of Sale',
  'Google & YouTube',
  'Facebook & Instagram'
];

let cachedPublicationIds = null;

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

// ---------- GraphQL helper ----------

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

// Fetch and cache publication ids for the required sales channels
async function getRequiredPublicationIds() {
  if (cachedPublicationIds && cachedPublicationIds.length) {
    return cachedPublicationIds;
  }

  const query = `
    query ListPublications {
      publications(first: 50) {
        edges {
          node {
            id
            name
            catalog {
              title
            }
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

  const edges = data &&
    data.publications &&
    Array.isArray(data.publications.edges)
    ? data.publications.edges
    : [];

  console.log(
    'All publications from GraphQL:',
    edges.map(e => ({
      id: e.node.id,
      name: e.node.name,
      catalogTitle: e.node.catalog && e.node.catalog.title
    }))
  );

  const publicationIds = [];
  const missing = [];

  REQUIRED_PUBLICATION_NAMES.forEach(required => {
    const requiredLower = required.toLowerCase();

    const match = edges.find(edge => {
      if (!edge || !edge.node) return false;
      const node = edge.node;
      const labelParts = [];

      if (node.name) {
        labelParts.push(String(node.name));
      }
      if (node.catalog && node.catalog.title) {
        labelParts.push(String(node.catalog.title));
      }

      const label = labelParts.join(' ').toLowerCase();
      return label.includes(requiredLower);
    });

    if (match) {
      publicationIds.push(match.node.id);
    } else {
      missing.push(required);
    }
  });

  if (missing.length) {
    console.warn(
      'Could not find publication ids for channels:',
      missing.join(', ')
    );
  }

  if (!publicationIds.length) {
    console.warn('No publication ids found. Products will not be published to channels.');
  }

  cachedPublicationIds = publicationIds;
  return publicationIds;
}

// Publish a product to the default sales channels using GraphQL
async function publishProductToDefaultSalesChannels(productId) {
  const publicationIds = await getRequiredPublicationIds();
  if (!publicationIds.length) {
    return;
  }

  const productGid = `gid://shopify/Product/${productId}`;

  const mutation = `
    mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          ... on Product {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = publicationIds.map(publicationId => ({ publicationId }));

  let data;
  try {
    data = await shopifyGraphql(mutation, { id: productGid, input });
  } catch (err) {
    console.error(
      'GraphQL error while publishing product to sales channels',
      err
    );
    return;
  }

  const payload = data && data.publishablePublish;
  const userErrors = payload && Array.isArray(payload.userErrors)
    ? payload.userErrors
    : [];

  if (userErrors.length) {
    console.error(
      'publishablePublish returned userErrors:',
      JSON.stringify(userErrors, null, 2)
    );
    return;
  }

  console.log(
    `Published product ${productId} to ${publicationIds.length} sales channels`
  );
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
    `?limit=250&fields=id,title,status,created_at,images,variants&order=created_at+desc`;

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

// ---------- main: recent products without images including SKU ----------

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

// Scan up to 1000 products, then take the N newest that have no images
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

// ---------- upload images + mark active + publish to sales channels ----------

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
    console.log(
      'Uploaded image for product',
      productId,
      'image id:',
      uploaded && uploaded.id
    );
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

  // After making sure the product is active, publish to the required sales channels.
  try {
    await publishProductToDefaultSalesChannels(productId);
  } catch (err) {
    console.error(
      'Failed to publish product to default sales channels',
      err
    );
  }
}

module.exports = {
  getRecentProductsWithoutImages,
  uploadImagesToProduct
};
