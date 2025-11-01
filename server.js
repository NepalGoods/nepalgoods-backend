const express = require('express');
const Stripe = require('stripe');
const Airtable = require('airtable');
const cors = require('cors');

const app = express();

// Initialize services with environment variables
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// FIXED: Initialize Airtable with proper configuration for newer versions
const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN,
  endpointUrl: 'https://api.airtable.com'
});
const base = airtable.base(process.env.AIRTABLE_BASE_ID);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'NepalGoods Backend is running!', 
    service: 'API Server',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      products: '/api/products',
      stripeConfig: '/api/stripe-config',
      createPayment: '/api/create-payment-intent',
      saveOrder: '/api/save-order',
      orders: '/api/orders'
    }
  });
});

// ========== STRIPE CONFIG ENDPOINT ==========
app.get('/api/stripe-config', (req, res) => {
  try {
    console.log('Fetching Stripe configuration...');
    
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
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

// ========== PRODUCTS ENDPOINTS ==========

// Get all products from Airtable
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

    console.log('Airtable Base ID:', process.env.AIRTABLE_BASE_ID ? '✓ Set' : '✗ Missing');
    console.log('Airtable Token length:', process.env.AIRTABLE_TOKEN ? process.env.AIRTABLE_TOKEN.length : '✗ Missing');

    // Use a simple fetch approach to avoid Airtable library issues
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

// ========== PAYMENT ENDPOINTS ==========

// Create Stripe payment intent - FIXED: Removed *100 multiplication
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata } = req.body;
    
    console.log('Creating payment intent for amount:', amount, 'Type:', typeof amount);
    
    // Validate environment variables
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('Stripe secret key not configured');
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured'
      });
    }

    // Validate amount
    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    // FIXED: Use amount as-is (frontend should send amount in cents)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // REMOVED: * 100 - frontend should send amount in cents
      currency: currency,
      metadata: metadata || {},
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('Payment intent created:', paymentIntent.id);
    console.log('Final amount charged:', paymentIntent.amount);
    
    res.json({ 
      success: true, 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
    
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create payment intent: ' + error.message
    });
  }
});

// ========== ORDER MANAGEMENT ==========

// Save order to Airtable
app.post('/api/save-order', async (req, res) => {
  try {
    const {
      orderId,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      orderItems,
      subtotal,
      shipping,
      tax,
      serviceFee,
      total,
      paymentMethod,
      stripePaymentId,
      deliveryNotes,
      orderNotes
    } = req.body;

    console.log('Saving order to Airtable:', orderId);

    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Validate required fields
    if (!orderId || !customerName || !customerEmail || !orderItems) {
      return res.status(400).json({
        success: false,
        error: 'Missing required order fields'
      });
    }

    // Save to Airtable Sales table using direct API call
    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales`, {
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
              'Customer Name': customerName,
              'Customer Email': customerEmail,
              'Customer Phone': customerPhone || '',
              'Shipping Address': shippingAddress,
              'Order Items': JSON.stringify(orderItems),
              'Subtotal': subtotal,
              'Shipping': shipping,
              'Tax': tax,
              'Service Fee': serviceFee,
              'Total': total,
              'Payment Method': paymentMethod,
              'Stripe Payment ID': stripePaymentId || '',
              'Order Status': 'Paid',
              'Order Date': new Date().toISOString(),
              'Delivery Notes': deliveryNotes || '',
              'Order Notes': orderNotes || ''
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    const recordId = result.records[0].id;
    
    console.log('Order saved successfully to Airtable. Record ID:', recordId);

    res.json({ 
      success: true, 
      recordId,
      orderId,
      message: 'Order saved successfully'
    });
    
  } catch (error) {
    console.error('Error saving order to Airtable:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to save order: ' + error.message
    });
  }
});

// ========== COMPLETE ORDER PROCESSING ==========
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
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('Stripe secret key not configured');
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured'
      });
    }

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

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Global error handler
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
🔐 Services: Stripe & Airtable Integrated
✅ Environment Variables: ${process.env.AIRTABLE_TOKEN ? '✓ Airtable' : '✗ Airtable'} ${process.env.STRIPE_SECRET_KEY ? '✓ Stripe' : '✗ Stripe'}
✅ Ready to accept requests...
  `);
});
