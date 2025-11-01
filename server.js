const express = require('express');
const Stripe = require('stripe');
const Airtable = require('airtable');
const cors = require('cors');

const app = express();

// Initialize services with environment variables
// Use the exact variable names from your Heroku config
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN });
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
      createOrder: '/api/orders'
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
        error: 'Server configuration error'
      });
    }

    const records = await base('Products').select({
      maxRecords: 100,
      view: 'Grid view'
    }).firstPage();

    const products = records.map(record => {
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

    console.log(`Successfully fetched ${products.length} products`);
    res.json({ success: true, products });
    
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch products'
    });
  }
});

// ========== PAYMENT ENDPOINTS ==========

// Create Stripe payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata } = req.body;
    
    console.log('Creating payment intent for amount:', amount);
    
    // Validate environment variables
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('Stripe secret key not configured');
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured'
      });
    }

    // Validate amount
    if (!amount || amount < 50) { // Minimum 50 cents
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // Already in cents from frontend
      currency: currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: metadata || {}
    });

    console.log('Payment intent created:', paymentIntent.id);
    
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

// Save order to Airtable (legacy endpoint)
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

    // Save to Airtable Sales table
    const records = await base('Sales').create([
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
    ]);

    const recordId = records[0].getId();
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

// ========== NEW ORDER CREATION ENDPOINT ==========
app.post('/api/orders', async (req, res) => {
  try {
    const {
      customer,
      shipping,
      order,
      payment,
      notes
    } = req.body;

    console.log('Creating new order for:', customer.email);

    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Generate order ID
    const orderId = `NG${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();

    // Format shipping address
    const shippingAddress = `${shipping.address}, ${shipping.city}, ${shipping.state} ${shipping.zip}, ${shipping.country}`;

    // Save to Airtable Sales table
    const records = await base('Sales').create([
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
    ]);

    const recordId = records[0].getId();
    console.log('Order saved successfully to Airtable. Record ID:', recordId);

    res.json({ 
      success: true, 
      recordId,
      orderId,
      message: 'Order created successfully'
    });
    
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create order: ' + error.message
    });
  }
});

// ========== STRIPE WEBHOOK ENDPOINT ==========
app.post('/api/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // You'll need to set STRIPE_WEBHOOK_SECRET in your environment variables
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_default_secret');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('PaymentIntent was successful:', paymentIntent.id);
      break;
    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      console.log('Payment failed:', failedPayment.id);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({received: true});
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
✅ Environment Variables: 
   ${process.env.AIRTABLE_TOKEN ? '✓ Airtable Token' : '✗ Airtable Token'} 
   ${process.env.AIRTABLE_BASE_ID ? '✓ Airtable Base ID' : '✗ Airtable Base ID'}
   ${process.env.STRIPE_SECRET_KEY ? '✓ Stripe Secret Key' : '✗ Stripe Secret Key'}
   ${process.env.STRIPE_PUBLISHABLE_KEY ? '✓ Stripe Publishable Key' : '✗ Stripe Publishable Key'}
✅ Ready to accept requests...
  `);
});
