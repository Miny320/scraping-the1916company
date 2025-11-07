const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config.json');

const CONFIG = {
	PARENT_URL: config.PARENT_URL,
	CHECK_INTERVAL: config.CHECK_INTERVAL
};

// Helper function to normalize URLs
const absoluteUrl = (url) => {
	if (!url) return '';
	if (url.startsWith('http')) return url;
	return `https://www.the1916company.com${url}`;
};

// Request headers for HTML requests
const getRequestHeaders = () => ({
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
	'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
	'Accept-Language': 'en-US,en;q=0.9',
	'Accept-Encoding': 'gzip, deflate, br, zstd',
	'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
	'Sec-Ch-Ua-Mobile': '?0',
	'Sec-Ch-Ua-Platform': '"Windows"',
	'Sec-Fetch-Dest': 'document',
	'Sec-Fetch-Mode': 'navigate',
	'Sec-Fetch-Site': 'none',
	'Sec-Fetch-User': '?1',
	'Upgrade-Insecure-Requests': '1',
	'Cache-Control': 'max-age=0'
});

// Request headers for API requests
const getAPIHeaders = (referer) => ({
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
	'Accept': '*/*',
	'Accept-Language': 'en-US,en;q=0.9',
	'Accept-Encoding': 'gzip, deflate, br, zstd',
	'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
	'Sec-Ch-Ua-Mobile': '?0',
	'Sec-Ch-Ua-Platform': '"Windows"',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin',
	'Referer': referer || 'https://www.the1916company.com/pre-owned/',
	'Priority': 'u=1, i'
});

// Fetch HTML with retry logic
const fetchHTML = async (url, retries = 2) => {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await axios.get(url, {
				headers: getRequestHeaders(),
				timeout: 30000,
				validateStatus: (status) => status >= 200 && status < 400
			});
			return cheerio.load(response.data);
		} catch (error) {
			if (attempt === retries) {
				// Only throw on final attempt - error will be logged by caller
				throw error;
			}
			// Small delay before retry
			await new Promise(r => setTimeout(r, 1000 * attempt));
		}
	}
};

// Step 1: Get all brands from /pre-owned/all-brands/ within AllBrands_columns
const getAllBrands = async () => {
	console.log('Step 1: Fetching all brands from /pre-owned/all-brands/...');
	const brandsUrl = 'https://www.the1916company.com/pre-owned/all-brands/';
	
	try {
		const $ = await fetchHTML(brandsUrl);
		const brands = [];
		const seenUrls = new Set();

		// Find brands within the AllBrands_columns element
		const $columnsContainer = $('.AllBrands_columns');
		
		if ($columnsContainer.length === 0) {
			console.warn('⚠️  AllBrands_columns element not found, trying fallback selectors...');
			// Fallback to searching all links
			$('a[href*="/pre-owned/"]').each((index, element) => {
				const $link = $(element);
				let href = $link.attr('href');
				if (!href) return;
				href = absoluteUrl(href);
				const brandMatch = href.match(/\/pre-owned\/([^\/]+)\/?$/);
				if (!brandMatch) return;
				const brandSlug = brandMatch[1];
				if (brandSlug === 'all-brands' || brandSlug === 'watches' || brandSlug.includes('?') || seenUrls.has(href)) {
					return;
				}
				seenUrls.add(href);
				let brandName = $link.text().trim();
				if (!brandName) brandName = brandSlug;
				brandName = brandName.replace(/\s+/g, ' ').trim() || brandSlug;
				brands.push({ name: brandName, slug: brandSlug, url: href });
			});
		} else {
			console.log('✅ Found AllBrands_columns container');
			
			// Find all links within AllBrands_columns
			$columnsContainer.find('a').each((index, element) => {
				const $link = $(element);
				let href = $link.attr('href');
				if (!href) return;

				// Normalize URL
				href = absoluteUrl(href);
				
				// Check if it's a brand page (usually /pre-owned/brand-name/)
				const brandMatch = href.match(/\/pre-owned\/([^\/]+)\/?$/);
				if (!brandMatch) return;

				const brandSlug = brandMatch[1];
				
				// Skip if it's "all-brands" or other non-brand pages
				if (brandSlug === 'all-brands' || brandSlug === 'watches' || brandSlug.includes('?') || seenUrls.has(href)) {
					return;
				}

				seenUrls.add(href);
				
				// Extract brand name from link text
				let brandName = $link.text().trim();
				if (!brandName) {
					const $img = $link.find('img').first();
					brandName = $img.attr('alt') || $img.attr('title') || brandSlug;
				}
				
				// Clean up brand name
				brandName = brandName.replace(/\s+/g, ' ').trim();
				if (!brandName) brandName = brandSlug;

				brands.push({
					name: brandName,
					slug: brandSlug,
					url: href
				});
			});
		}

		// Remove duplicates based on URL
		const uniqueBrands = [];
		const seen = new Set();
		for (const brand of brands) {
			if (!seen.has(brand.url)) {
				seen.add(brand.url);
				uniqueBrands.push(brand);
			}
		}

		console.log(`✅ Found ${uniqueBrands.length} unique brands`);
		return uniqueBrands;
	} catch (error) {
		console.error('❌ Error fetching brands:', error.message);
		return [];
	}
};

// Step 2: Get all products from brand API (with pagination)
const getProductsFromBrandAPI = async (brandSlug, brandUrl) => {
	console.log(`  Fetching products from API for: ${brandSlug}`);
	
	const apiUrl = `https://www.the1916company.com/api/products/pre-owned-${brandSlug}/`;
	const headers = getAPIHeaders(brandUrl);
	
	const makeRequest = async (page) => {
		const params = {
			layout: 'pre-owned',
			page: page,
			currency: 'USD',
			country: 'JP'
		};

		const response = await axios.get(apiUrl, {
			params: params,
			headers: headers,
			timeout: 30000
		});

		return response.data;
	};

	try {
		// Fetch page 1 to get total products
		const firstPageData = await makeRequest(1);
		
		const totalProducts = firstPageData.total || 0;
		const productsOnPage1 = Object.keys(firstPageData.hits || {}).length;
		
		if (totalProducts === 0 || productsOnPage1 === 0) {
			console.log(`    No products found for ${brandSlug}`);
			return [];
		}

		// Calculate total pages needed
		const productsPerPage = productsOnPage1;
		const totalPages = Math.ceil(totalProducts / productsPerPage);
		
		console.log(`    Total: ${totalProducts} products, ${totalPages} pages`);

		// Collect all products from all pages
		const allProducts = {};
		
		// Add products from page 1
		if (firstPageData.hits) {
			Object.assign(allProducts, firstPageData.hits);
		}

		// Fetch remaining pages
		for (let page = 2; page <= totalPages; page++) {
			const pageData = await makeRequest(page);
			
			if (pageData.hits) {
				Object.assign(allProducts, pageData.hits);
			}

			// Small delay between requests
			if (page < totalPages) {
				await new Promise(r => setTimeout(r, 1000));
			}
		}

		// Convert to array
		return Object.values(allProducts);
	} catch (error) {
		console.error(`    ❌ Error fetching products for ${brandSlug}:`, error.message);
		return [];
	}
};

const detectAccessoryStatus = (description, keywords) => {
	if (!description) return null;
	const combinedNegativePhrases = [
		'does not come with box or papers',
		"doesn't come with box or papers",
		'without box or papers',
		'no box or papers'
	];
	for (const phrase of combinedNegativePhrases) {
		if (description.includes(phrase)) {
			return false;
		}
	}
	const negativesTemplate = [
		'no {keyword}',
		'without {keyword}',
		'does not come with {keyword}',
		'doesn\'t come with {keyword}',
		'missing {keyword}',
		'not include {keyword}',
		'not included {keyword}',
		'not included'
	];
	for (const keyword of keywords) {
		for (const phrase of negativesTemplate) {
			const text = phrase.replace('{keyword}', keyword);
			if (description.includes(text)) {
				return false;
			}
		}
	}

	const positivesTemplate = [
		'with {keyword}',
		'includes {keyword}',
		'comes with {keyword}',
		'complete with {keyword}',
		'original {keyword}'
	];
	for (const keyword of keywords) {
		for (const phrase of positivesTemplate) {
			const text = phrase.replace('{keyword}', keyword);
			if (description.includes(text)) {
				return true;
			}
		}
	}

	return null;
};

const detectCondition = (description) => {
	if (!description) return null;
	const conditionKeywords = [
		{ key: 'unworn', value: 'unworn' },
		{ key: 'like new', value: 'like new' },
		{ key: 'mint condition', value: 'excellent' },
		{ key: 'excellent condition', value: 'excellent' },
		{ key: 'very good condition', value: 'very good' },
		{ key: 'good condition', value: 'good' },
		{ key: 'fair condition', value: 'fair' }
	];

	for (const { key, value } of conditionKeywords) {
		if (description.includes(key)) {
			return value;
		}
	}

	return null;
};

// Extract Box, Papers, and Location from HTML details section
const extractDetailsFromHTML = async (watchUrl) => {
	try {
		const $ = await fetchHTML(watchUrl, 2);
		
		let originalBox = null;
		let originalPaper = null;
		let location = null;
		
		// Find the PDPSpecs detail list - try multiple selectors
		$('.PDPSpecs__detail-list--4bdf5, .PDPSpecs__detail-list, dl.PDPSpecs__detail-list--4bdf5').each((index, list) => {
			$(list).find('.PDPSpecs__detail-list__item--86dc2, .PDPSpecs__detail-list__item, dl > div').each((itemIndex, item) => {
				// Try to get key and value from different possible structures
				let key = $(item).find('.PDPSpecs__detail-list__key--1a22a, dt, [class*="key"]').first().text().trim().toLowerCase();
				let value = $(item).find('.PDPSpecs__detail-list__value--4d9b0, dd, [class*="value"]').first().text().trim();
				
				// If not found with class selectors, try direct dt/dd
				if (!key || !value) {
					const dt = $(item).find('dt').first();
					const dd = $(item).find('dd').first();
					if (dt.length && dd.length) {
						key = dt.text().trim().toLowerCase();
						value = dd.text().trim();
					}
				}
				
				if (!key || !value) return;
				
				const valueLower = value.toLowerCase();
				
				// Check for Box
				if (key.includes('box') && !key.includes('case')) {
					if (valueLower === 'yes' || valueLower === 'y' || valueLower === 'true' || valueLower === 'included') {
						originalBox = true;
					} else if (valueLower === 'no' || valueLower === 'n' || valueLower === 'false' || valueLower.includes('not included')) {
						originalBox = false;
					}
				}
				
				// Check for Papers
				if (key.includes('paper') || key.includes('document')) {
					if (valueLower === 'yes' || valueLower === 'y' || valueLower === 'true' || valueLower === 'included') {
						originalPaper = true;
					} else if (valueLower === 'no' || valueLower === 'n' || valueLower === 'false' || valueLower.includes('not included')) {
						originalPaper = false;
					}
				}
				
				// Check for Location (be more specific to avoid false matches)
				if ((key.includes('location') || key === 'location') && !key.includes('preference') && !key.includes('country')) {
					// Only accept if value looks like a location (city, state, country format)
					const locationPattern = /^[A-Z][A-Za-z\s,]+(?:,\s*[A-Z][A-Za-z\s]+)?$/;
					if (locationPattern.test(value.trim()) && value.trim().length > 2 && value.trim().length < 100) {
						location = value.trim();
					}
				}
			});
		});
		
		// Don't extract location from body text - only from structured details section
		// Location should remain null if not found in details section
		
		return { originalBox, originalPaper, location };
	} catch (error) {
		console.error(`  ⚠️  Error fetching HTML for ${watchUrl}:`, error.message);
		return { originalBox: null, originalPaper: null, location: null };
	}
};

// Extract watch data from API product object (without HTML fetching)
const extractWatchDataFromProductAPI = (product, index, brandSlug) => {
	const description = (product.c_shortDescription || '').toLowerCase();
	const originalBox = detectAccessoryStatus(description, ['box', 'boxes']);
	const originalPaper = detectAccessoryStatus(description, ['papers', 'paper', 'documents', 'documentation']);
	const condition = detectCondition(description);

	// Extract year
	let year = null;
	if (product.c_WatchYear) {
		const yearMatch = product.c_WatchYear.match(/\d{4}/);
		if (yearMatch) {
			year = parseInt(yearMatch[0]);
		}
	}

	// Extract ALL images from images array (this is where all product images are stored)
	let images = [];
	
	// Get images from images array - this is the main source of images
	if (product.images && Array.isArray(product.images)) {
		product.images.forEach(img => {
			if (typeof img === 'string') {
				if (img.trim() && !images.includes(img.trim())) {
					images.push(img.trim());
				}
			} else if (img && img.link) {
				const imgLink = img.link.trim();
				if (imgLink && !images.includes(imgLink)) {
					images.push(imgLink);
				}
			}
		});
	}
	
	// Also check for imageGroups if it exists
	if (product.imageGroups && Array.isArray(product.imageGroups)) {
		product.imageGroups.forEach(group => {
			if (group.images && Array.isArray(group.images)) {
				group.images.forEach(img => {
					if (typeof img === 'string') {
						const imgLink = img.trim();
						if (imgLink && !images.includes(imgLink)) {
							images.push(imgLink);
						}
					} else if (img && img.link) {
						const imgLink = img.link.trim();
						if (imgLink && !images.includes(imgLink)) {
							images.push(imgLink);
						}
					}
				});
			}
		});
	}
	
	// Check for single image object (usually a placeholder) - only add if no other images found
	if (images.length === 0 && product.image && product.image.link) {
		const imgLink = product.image.link.trim();
		if (imgLink) {
			images.push(imgLink);
		}
	}

	// Construct watch URL from c_primaryCategory and c_variantSku
	let watchUrl = '';
	if (product.c_primaryCategory && product.c_variantSku) {
		// Use brandSlug if provided, otherwise extract from category
		if (brandSlug) {
			const categoryPrefix = `pre-owned-${brandSlug}-`;
			if (product.c_primaryCategory.startsWith(categoryPrefix)) {
				const category = product.c_primaryCategory.substring(categoryPrefix.length);
				watchUrl = `https://www.the1916company.com/pre-owned/${brandSlug}/${category}/${product.c_variantSku}`;
			}
		}
		
		// Fallback to parsing category
		if (!watchUrl) {
			const categoryParts = product.c_primaryCategory.split('-');
			let brandIndex = -1;
			for (let i = 0; i < categoryParts.length; i++) {
				if (categoryParts[i] === 'owned' && i > 0 && categoryParts[i - 1] === 'pre') {
					brandIndex = i + 1;
					break;
				}
			}
			
			if (brandIndex > 0 && brandIndex < categoryParts.length) {
				const extractedBrandSlug = categoryParts[brandIndex];
				const category = categoryParts.slice(brandIndex + 1).join('-');
				watchUrl = `https://www.the1916company.com/pre-owned/${extractedBrandSlug}/${category}/${product.c_variantSku}`;
			}
		}
	}
	
	// Fallback if URL construction failed
	if (!watchUrl) {
		watchUrl = `https://www.the1916company.com/pre-owned/watches/${product.productId}`;
	}

	// Parse model from productName (remove brand name if present)
	let model = product.productName || '';
	const brand = product.c_brand || '';
	if (model && brand && model.toLowerCase().startsWith(brand.toLowerCase())) {
		model = model.substring(brand.length).trim();
	}

	return {
		index: index,
		brand: brand,
		model: model,
		referenceNumber: product.c_baseRefNum || '',
		year: year,
		price: product.price || 0,
		currency: product.currency || 'USD',
		originalBox: originalBox,
		originalPaper: originalPaper,
		condition: condition,
		location: null,
		images: images,
		watchUrl: watchUrl
	};
};

// Main function to get all brands and extract watch data via API
const scrapeBrandsAndProducts = async () => {
	console.log('Starting The1916Company Scraper (API-based)...\n');

	// Step 1: Get all brands
	const brands = await getAllBrands();
	
	if (brands.length === 0) {
		console.error('No brands found!');
		return { brands: [], watchData: [] };
	}

	console.log(`\n✅ Found ${brands.length} brands\n`);

	// Step 2: Process each product individually (API + HTML) and save immediately
	const watchDataPath = path.join(__dirname, '..', 'watchData.json');
	let allWatchData = [];
	let globalIndex = 0;
	
	// Initialize watchData.json as empty array
	fs.writeFileSync(watchDataPath, JSON.stringify([], null, 2));
	
	// Process brands sequentially to maintain order
	for (let brandIndex = 0; brandIndex < brands.length; brandIndex++) {
		const brand = brands[brandIndex];
		console.log(`\n[${brandIndex + 1}/${brands.length}] Processing brand: ${brand.name}`);
		
		try {
			// Get all products for this brand from API
			const products = await getProductsFromBrandAPI(brand.slug, brand.url);
			console.log(`  ✅ Found ${products.length} products for ${brand.name}`);
			
			// Step 1: Extract data from API for all products (without HTML fetching)
			const brandWatchData = [];
			for (let i = 0; i < products.length; i++) {
				const product = products[i];
				const currentIndex = globalIndex++;
				const watch = extractWatchDataFromProductAPI(product, currentIndex, brand.slug);
				brandWatchData.push(watch);
			}
			
			// Step 2: Process HTML requests in batches of 50
			const HTML_BATCH_SIZE = 50;
			const totalHtmlBatches = Math.ceil(brandWatchData.length / HTML_BATCH_SIZE);
			
			for (let htmlBatchIndex = 0; htmlBatchIndex < totalHtmlBatches; htmlBatchIndex++) {
				const htmlBatchStart = htmlBatchIndex * HTML_BATCH_SIZE;
				const htmlBatchEnd = Math.min(htmlBatchStart + HTML_BATCH_SIZE, brandWatchData.length);
				const htmlBatch = brandWatchData.slice(htmlBatchStart, htmlBatchEnd);
				
				console.log(`    Processing HTML batch ${htmlBatchIndex + 1}/${totalHtmlBatches} (products ${htmlBatchStart + 1}-${htmlBatchEnd} of ${brandWatchData.length})`);
				
				// Process HTML fetches in parallel within batch
				const htmlPromises = htmlBatch.map(async (watch) => {
					let success = false;
					try {
						const htmlData = await extractDetailsFromHTML(watch.watchUrl);
						success = true;
						
						// Update with HTML data (prioritize HTML over description)
						if (htmlData.originalBox !== null) {
							watch.originalBox = htmlData.originalBox;
						}
						if (htmlData.originalPaper !== null) {
							watch.originalPaper = htmlData.originalPaper;
						}
						// Location: only set if valid, otherwise keep as null
						if (htmlData.location !== null && htmlData.location.trim() && htmlData.location.trim().length > 2) {
							const loc = htmlData.location.trim();
							if (!loc.toLowerCase().includes('contact') && 
								!loc.toLowerCase().includes('sell') &&
								loc.match(/^[A-Z]/)) {
								watch.location = loc;
							} else {
								watch.location = null;
							}
						} else {
							watch.location = null;
						}
						
						return { watch, success };
					} catch (error) {
						// Only log error details if it's not a common timeout/network error
						const errorMsg = error.message || 'Unknown error';
						if (!errorMsg.includes('timeout') && !errorMsg.includes('ECONNRESET') && !errorMsg.includes('ENOTFOUND')) {
							console.error(`      ⚠️  Error fetching HTML for ${watch.watchUrl}: ${errorMsg}`);
						}
						return { watch, success: false }; // Return watch data even if HTML fetch failed
					}
				});
				
				// Wait for all HTML fetches in batch to complete
				const results = await Promise.all(htmlPromises);
				
				// Calculate success/error counts
				let successCount = 0;
				let errorCount = 0;
				results.forEach(({ success }) => {
					if (success) successCount++;
					else errorCount++;
				});
				
				// Update watches in batch with results
				results.forEach(({ watch }, index) => {
					htmlBatch[index] = watch;
				});
				
				// Add processed batch to allWatchData
				allWatchData.push(...htmlBatch);
				
				// Save to file after each batch
				fs.writeFileSync(watchDataPath, JSON.stringify(allWatchData, null, 2));
				console.log(`    ✅ Batch complete: ${successCount} succeeded, ${errorCount} failed | 💾 Saved ${allWatchData.length} products`);
				
				// Delay between HTML batches to avoid rate limiting
				if (htmlBatchIndex < totalHtmlBatches - 1) {
					await new Promise(r => setTimeout(r, 2000));
				}
			}
		} catch (error) {
			console.error(`  ❌ Error processing ${brand.name}:`, error.message);
			// Continue with next brand
		}
		
		// Small delay between brands
		if (brandIndex < brands.length - 1) {
			console.log(`  ⏳ Waiting 2 seconds before next brand...`);
			await new Promise(r => setTimeout(r, 2000));
		}
	}

	console.log(`\n📊 Summary:`);
	console.log(`   - Total brands: ${brands.length}`);
	console.log(`   - Total watches extracted: ${allWatchData.length}`);
	console.log(`   - Data saved to watchData.json`);

	return {
		brands,
		watchData: allWatchData
	};
};


// Scrape watch data (get all brands and extract watch data via API)
const scrapeWatchData = async () => {
	try {
		// Get all brands and extract watch data via API (already saves to watchData.json)
		const { watchData } = await scrapeBrandsAndProducts();
		
		if (!watchData || watchData.length === 0) {
			console.log('No watch data found');
			return [];
		}

		// Post to backend
		if (config.BACK_END_URL) {
			try {
				const resp = await axios.post(config.BACK_END_URL, { 
					parentUrl: CONFIG.PARENT_URL, 
					watchData: watchData 
				});
				console.log(`✅ Posted to backend: ${resp.status}`);
			} catch (e) {
				console.warn(`⚠️  Post to backend failed: ${e.message}`);
			}
		}

		return watchData;
	} catch (error) {
		console.error('❌ Scrape failed:', error.message);
		return [];
	}
};

// Start scheduler with interval checking
const startScheduler = async () => {
	const SCRAPE_INTERVAL = CONFIG.CHECK_INTERVAL || (10 * 60 * 60 * 1000); // Default 10 hours
	console.log('Starting scheduler...');
	console.log(`Check interval: ${SCRAPE_INTERVAL / 1000 / 60} minutes`);
	console.log('Running initial scrape...\n');
	
	// Run initial scrape
	try {
		await scrapeWatchData();
	} catch (e) {
		console.error('Initial scrape error:', e.message);
	}
	
	// Set up interval
	setInterval(async () => {
		try {
			console.log('\n' + '='.repeat(50));
			console.log(`Scheduled scrape at ${new Date().toISOString()}`);
			console.log('='.repeat(50) + '\n');
			await scrapeWatchData();
		} catch (e) {
			console.error('Scheduled scrape error:', e.message);
		}
	}, SCRAPE_INTERVAL);
};

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\n\nShutting down...');
	process.exit(0);
});

// Export functions
module.exports = {
	scrapeWatchData,
	scrapeBrandsAndProducts
};

// Start the scheduler only if running directly (not when required as module)
if (require.main === module) {
	startScheduler();
}
