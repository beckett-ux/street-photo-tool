const { getDraftProductsWithoutImages } = require('./shopify');

async function main() {
  try {
    const products = await getDraftProductsWithoutImages();
    console.log('Draft products without images:');
    if (!products.length) {
      console.log('(none found)');
      return;
    }

    products.forEach(p => {
      console.log(`- ID: ${p.id} | Title: ${p.title}`);
    });
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
