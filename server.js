const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();

// Initialize Stripe with error handling
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY is not set in environment variables');
  } else {
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized successfully');
  }
} catch (error) {
  console.error('❌ Failed to initialize Stripe:', error);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint with environment info
app.get('/', (req, res) => {
  const envInfo = {
    stripe: {
      configured: !!process.env.STRIPE_SECRET_KEY,
      keyLength: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.length : 0,
      keyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 8) + '...' : 'Not set'
    },
    airtable: {
      configured: !!(process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID),
      tokenLength: process.env.AIRTABLE_TOKEN ? process.env.AIRTABLE_TOKEN.length : 0,
      baseId: process.env.AIRTABLE_BASE_ID ? 'Set' : 'Not set'
    }
  };

  res.json({ 
    status: 'NepalGoods Backend is running!', 
    environment: envInfo,
    timestamp: new Date().toISOString()
  });
});

// ========== STRIPE CONFIG ENDPOINT ==========
app.get('/api/stripe-config', (req, res) => {
  try {
    console.log('Fetching Stripe configuration...');
    
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
      console.error('Stripe publishable key not configured');
      return res.status(500).json({
        success: false,
        error: 'Stripe publishable key not configured'
      });
    }

    res.json({
      success: true,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
    
  } catch (error) {
    console.error('Error fetching Stripe config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Stripe configuration'
    });
  }
});

// ========== PAYMENT ENDPOINTS ==========

// Create Stripe payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata } = req.body;
    
    console.log('Creating payment intent for amount:', amount, 'cents');
    
    // Validate Stripe initialization
    if (!stripe) {
      console.error('Stripe not initialized - check STRIPE_SECRET_KEY');
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured properly'
      });
    }

    // Validate amount
    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount: ' + amount
      });
    }

    console.log('Creating Stripe payment intent with:', {
      amount,
      currency,
      metadata
    });

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // Amount is already in cents from frontend
      currency: currency,
      metadata: metadata || {},
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('✅ Payment intent created successfully:', paymentIntent.id);
    
    res.json({ 
      success: true, 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
    
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    
    // More detailed error information
    let errorMessage = 'Failed to create payment intent';
    if (error.type === 'StripeInvalidRequestError') {
      errorMessage = 'Invalid Stripe request: ' + error.message;
    } else if (error.type === 'StripeAuthenticationError') {
      errorMessage = 'Stripe authentication failed - check your secret key';
    } else if (error.type === 'StripeConnectionError') {
      errorMessage = 'Failed to connect to Stripe';
    }
    
    res.status(500).json({ 
      success: false, 
      error: errorMessage,
      details: error.message
    });
  }
});

// ========== PRODUCTS ENDPOINTS ==========
app.get('/api/products', async (req, res) => {
  try {
    console.log('Fetching products from Airtable...');
    
    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: Missing Airtable credentials'
      });
    }

    // Use a simple fetch approach
    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Products`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`Found ${data.records ? data.records.length : 0} records from Airtable`);

    if (!data.records) {
      throw new Error('No records found in Airtable response');
    }

    const products = data.records.map(record => {
      const fields = record.fields;
      
      // Get image URL with fallbacks
      const imgUrl = (fields.Image && fields.Image[0] && fields.Image[0].thumbnails && fields.Image[0].thumbnails.large && fields.Image[0].thumbnails.large.url) ||
                     (fields.Image && fields.Image[0] && fields.Image[0].url) ||
                     'https://via.placeholder.com/300x200?text=No+Image';

      // Get multiple images if available
      const images = [];
      if (fields.Image && Array.isArray(fields.Image)) {
        fields.Image.forEach(img => {
          const url = (img.thumbnails && img.thumbnails.large && img.thumbnails.large.url) || img.url;
          if (url) images.push(url);
        });
      }
      
      // If no multiple images, use the single image
      if (images.length === 0 && imgUrl) {
        images.push(imgUrl);
      }

      return {
        id: record.id,
        name: fields.Name || 'Untitled',
        price: typeof fields.Price !== 'undefined' ? Number(fields.Price) : 0,
        subtitle: fields.Subtitle || 'Premium quality product',
        description: fields.Description || 'This premium product offers exceptional quality and value.',
        image: imgUrl,
        images: images,
        category: fields.Category || '',
        sizes: fields.Size || [],
        tags: fields.Tags || [],
        rating: typeof fields.Rating !== 'undefined' ? Number(fields.Rating) : null,
        reviewCount: typeof fields.ReviewCount !== 'undefined' ? Number(fields.ReviewCount) : 0
      };
    });

    console.log(`Successfully processed ${products.length} products`);
    res.json({ success: true, products });
    
  } catch (error) {
    console.error('Error fetching products from Airtable:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch products from Airtable: ' + error.message
    });
  }
});

// ========== ORDER MANAGEMENT ==========
app.post('/api/orders', async (req, res) => {
  try {
    const {
      customer,
      shipping,
      order,
      payment,
      notes
    } = req.body;

    console.log('Processing complete order for:', customer?.email);

    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Order system not configured'
      });
    }

    // Validate required fields
    if (!customer || !shipping || !order || !payment) {
      return res.status(400).json({
        success: false,
        error: 'Missing required order information'
      });
    }

    // Generate order ID
    const orderId = `NG${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();

    // Format shipping address
    const shippingAddress = `${shipping.address}, ${shipping.city}, ${shipping.state} ${shipping.zip}, ${shipping.country}`;

    console.log('Saving order to Airtable:', orderId);

    // Save to Airtable
    const airtableResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              'Order ID': orderId,
              'Customer Name': `${customer.firstName} ${customer.lastName}`,
              'Customer Email': customer.email,
              'Customer Phone': customer.phone || '',
              'Shipping Address': shippingAddress,
              'Order Items': JSON.stringify(order.items),
              'Subtotal': order.subtotal,
              'Shipping': order.shipping,
              'Tax': order.tax,
              'Service Fee': order.serviceFee,
              'Total': order.total,
              'Payment Method': payment.method,
              'Stripe Payment ID': payment.id || '',
              'Order Status': 'Paid',
              'Order Date': new Date().toISOString(),
              'Delivery Notes': shipping.notes || '',
              'Order Notes': notes || ''
            }
          }
        ]
      })
    });

    if (!airtableResponse.ok) {
      const errorText = await airtableResponse.text();
      console.error('Airtable API error:', errorText);
      throw new Error(`Airtable API error: ${airtableResponse.status}`);
    }

    const airtableResult = await airtableResponse.json();
    const recordId = airtableResult.records[0].id;

    console.log('Order saved successfully to Airtable. Record ID:', recordId);

    res.json({ 
      success: true, 
      orderId,
      recordId,
      message: 'Order processed successfully'
    });
    
  } catch (error) {
    console.error('Error processing order:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process order: ' + error.message
    });
  }
});

// ========== ERROR HANDLING ==========
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ========== SERVER STARTUP ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
🚀 NepalGoods Backend Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔐 Services: 
   - Stripe: ${stripe ? '✅ Initialized' : '❌ Failed - check STRIPE_SECRET_KEY'}
   - Airtable: ${process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID ? '✅ Configured' : '❌ Missing credentials'}
✅ Ready to accept requests...
  `);
});
