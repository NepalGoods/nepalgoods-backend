const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();

// Initialize services with environment variables
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Debug middleware - log all requests
app.use((req, res, next) => {
  console.log('📍 Incoming Request:', {
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString()
  });
  next();
});

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
      orders: '/api/orders',
      orderStatus: '/api/orders/:recordId/status',
      testAirtable: '/api/test-airtable',
      workstation: '/api/orders/workstation'
    }
  });
});

// ========== STRIPE CONFIG ENDPOINT ==========
app.get('/api/stripe-config', (req, res) => {
  try {
    console.log('🔑 Fetching Stripe configuration...');
    
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
    console.error('❌ Error fetching Stripe config:', error);
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
    console.log('🛍️ Fetching products from Airtable...');
    
    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('❌ Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: Missing Airtable credentials'
      });
    }

    console.log('✅ Airtable Base ID:', process.env.AIRTABLE_BASE_ID ? 'Set' : 'Missing');
    console.log('✅ Airtable Token:', process.env.AIRTABLE_TOKEN ? 'Set' : 'Missing');

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
    console.log(`📊 Found ${data.records ? data.records.length : 0} records from Airtable`);

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

    console.log(`✅ Successfully processed ${products.length} products`);
    res.json({ success: true, products });
    
  } catch (error) {
    console.error('❌ Error fetching products from Airtable:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch products from Airtable: ' + error.message
    });
  }
});

// ========== PAYMENT ENDPOINTS ==========

// Create Stripe payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata } = req.body;
    
    console.log('💳 Creating payment intent for amount:', amount);
    
    // Validate environment variables
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ Stripe secret key not configured');
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

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // Convert to cents
      currency: currency,
      metadata: metadata || {},
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('✅ Payment intent created:', paymentIntent.id);
    
    res.json({ 
      success: true, 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
    
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create payment intent: ' + error.message
    });
  }
});

// ========== ORDER MANAGEMENT ==========

// Complete order processing
app.post('/api/orders', async (req, res) => {
  try {
    const {
      customer,
      shipping,
      order,
      payment,
      notes
    } = req.body;

    console.log('🛒 Processing complete order request');
    console.log('👤 Customer:', customer?.email);
    console.log('📦 Order items count:', order?.items?.length);
    console.log('💳 Payment ID:', payment?.id);

    // Validate environment variables
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      console.error('❌ Airtable configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Order system not configured - Airtable credentials missing'
      });
    }

    // Validate required fields
    if (!customer || !shipping || !order || !payment) {
      console.error('❌ Missing required order information');
      return res.status(400).json({
        success: false,
        error: 'Missing required order information'
      });
    }

    if (!customer.firstName || !customer.lastName || !customer.email) {
      console.error('❌ Missing customer information');
      return res.status(400).json({
        success: false,
        error: 'Missing customer information'
      });
    }

    // Generate order ID
    const orderId = `NG${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
    console.log('📝 Generated Order ID:', orderId);

    // Format shipping address
    const shippingAddress = `${shipping.address}, ${shipping.city}, ${shipping.state} ${shipping.zip}, ${shipping.country}`;
    
    // Format order items for Airtable
    const orderItemsText = order.items.map(item => 
      `${item.quantity}x ${item.name}${item.size ? ` (Size: ${item.size})` : ''} - $${item.price}`
    ).join('\n');

    console.log('💾 Preparing to save to Airtable...');

    // Order Status Definitions
    const orderStatus = 'Paid'; // Initial status when payment is successful

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
              'Customer Phone': customer.phone || 'Not provided',
              'Shipping Address': shippingAddress,
              'Order Items': orderItemsText,
              'Subtotal': order.subtotal,
              'Shipping': order.shipping,
              'Tax': order.tax,
              'Service Fee': order.serviceFee || 0,
              'Total': order.total,
              'Payment Method': payment.method || 'card',
              'Stripe Payment ID': payment.id || 'Unknown',
              'Order Status': orderStatus,
              'Order Date': new Date().toISOString(),
              'Delivery Notes': shipping.notes || '',
              'Order Notes': notes || '',
              'Status Updated': new Date().toISOString(),
              'Assigned To': '', // Initialize empty staff assignment
              'Tracking Number': '' // Initialize empty tracking number
            }
          }
        ]
      })
    });

    console.log('📤 Airtable response status:', airtableResponse.status);

    if (!airtableResponse.ok) {
      const errorText = await airtableResponse.text();
      console.error('❌ Airtable API error:', errorText);
      
      // Try to parse error for better messaging
      let errorMessage = `Airtable API error: ${airtableResponse.status}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error?.message || errorText;
      } catch (e) {
        errorMessage = errorText;
      }
      
      throw new Error(errorMessage);
    }

    const airtableResult = await airtableResponse.json();
    const recordId = airtableResult.records[0].id;

    console.log('✅ Order saved successfully to Airtable');
    console.log('📋 Record ID:', recordId);
    console.log('🆔 Order ID:', orderId);
    console.log('💰 Total Amount: $', order.total);
    console.log('📊 Order Status:', orderStatus);

    res.json({ 
      success: true, 
      orderId,
      recordId,
      status: orderStatus,
      message: 'Order processed successfully'
    });
    
  } catch (error) {
    console.error('❌ Error processing order:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process order: ' + error.message
    });
  }
});

// ========== ORDER STATUS MANAGEMENT ==========

// Update order status with staff assignment and tracking
app.patch('/api/orders/:recordId/status', async (req, res) => {
  try {
    const { recordId } = req.params;
    const { status, trackingNumber, notes, assignedTo } = req.body;

    console.log('🔄 Updating order status for record:', recordId);
    console.log('📊 New status:', status);
    console.log('👤 Assigned to:', assignedTo);
    console.log('📦 Tracking:', trackingNumber);
    console.log('📝 Notes:', notes);

    // Valid statuses
    const validStatuses = [
      'Paid', 
      'Processing', 
      'Shipped', 
      'Delivered', 
      'Cancelled', 
      'Refunded', 
      'On Hold', 
      'Awaiting Information'
    ];
    
    if (!validStatuses.includes(status)) {
      console.error('❌ Invalid status provided:', status);
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Update in Airtable
    const updateFields = {
      'Order Status': status,
      'Status Updated': new Date().toISOString()
    };

    // Add tracking number if provided
    if (trackingNumber) {
      updateFields['Tracking Number'] = trackingNumber;
    }

    // Add staff assignment if provided
    if (assignedTo) {
      updateFields['Assigned To'] = assignedTo;
    }

    // Add status notes if provided
    if (notes) {
      updateFields['Status Notes'] = notes;
    }

    console.log('📋 Update fields:', updateFields);

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [
          {
            id: recordId,
            fields: updateFields
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Airtable API error:', errorText);
      
      // Try to parse error for better messaging
      let errorMessage = `Airtable API error: ${response.status}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error?.message || errorText;
      } catch (e) {
        errorMessage = errorText;
      }
      
      throw new Error(errorMessage);
    }

    const result = await response.json();
    console.log('✅ Order status updated successfully');

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      recordId: recordId,
      status: status,
      assignedTo: assignedTo,
      trackingNumber: trackingNumber,
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error updating order status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update order status: ' + error.message
    });
  }
});

// Get order status
app.get('/api/orders/:recordId/status', async (req, res) => {
  try {
    const { recordId } = req.params;

    console.log('📋 Fetching order status for record:', recordId);

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales/${recordId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const record = await response.json();
    
    res.json({
      success: true,
      orderId: record.fields['Order ID'],
      status: record.fields['Order Status'],
      customerName: record.fields['Customer Name'],
      total: record.fields['Total'],
      orderDate: record.fields['Order Date'],
      statusUpdated: record.fields['Status Updated'],
      trackingNumber: record.fields['Tracking Number'] || null,
      assignedTo: record.fields['Assigned To'] || null
    });

  } catch (error) {
    console.error('❌ Error fetching order status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch order status: ' + error.message
    });
  }
});

// ========== ORDER WORKSTATION ENDPOINT ==========
app.get('/api/orders/workstation', async (req, res) => {
  try {
    console.log('🏪 Fetching orders for workstation...');

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales?sort[0][field]=Order Date&sort[0][direction]=desc`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();
    
    const orders = data.records.map(record => ({
      recordId: record.id,
      orderId: record.fields['Order ID'],
      customerName: record.fields['Customer Name'],
      customerEmail: record.fields['Customer Email'],
      customerPhone: record.fields['Customer Phone'],
      shippingAddress: record.fields['Shipping Address'],
      orderItems: record.fields['Order Items'],
      status: record.fields['Order Status'],
      total: record.fields['Total'],
      orderDate: record.fields['Order Date'],
      statusUpdated: record.fields['Status Updated'],
      trackingNumber: record.fields['Tracking Number'] || '',
      assignedTo: record.fields['Assigned To'] || '', // This field must exist in Airtable
      statusNotes: record.fields['Status Notes'] || '',
      deliveryNotes: record.fields['Delivery Notes'] || '',
      orderNotes: record.fields['Order Notes'] || ''
    }));

    console.log(`✅ Found ${orders.length} orders for workstation`);
    
    res.json({ success: true, orders });
    
  } catch (error) {
    console.error('❌ Error fetching workstation orders:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch orders: ' + error.message
    });
  }
});

// ========== AIRTABLE CONNECTION TEST ==========

// Test Airtable connection
app.get('/api/test-airtable', async (req, res) => {
  try {
    console.log('🧪 Testing Airtable connection...');
    
    if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      return res.status(500).json({
        success: false,
        error: 'Airtable credentials not configured'
      });
    }

    // Test connection to Products table
    const productsResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Products?maxRecords=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    // Test connection to Sales table
    const salesResponse = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales?maxRecords=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const productsData = productsResponse.ok ? await productsResponse.json() : null;
    const salesData = salesResponse.ok ? await salesResponse.json() : null;

    res.json({
      success: true,
      message: 'Airtable connection test completed',
      connections: {
        products: {
          connected: productsResponse.ok,
          recordCount: productsData ? productsData.records.length : 0,
          error: productsResponse.ok ? null : `HTTP ${productsResponse.status}`
        },
        sales: {
          connected: salesResponse.ok,
          recordCount: salesData ? salesData.records.length : 0,
          error: salesResponse.ok ? null : `HTTP ${salesResponse.status}`
        }
      },
      tables: {
        products: 'Products table for product catalog',
        sales: 'Sales table for order management'
      }
    });
    
  } catch (error) {
    console.error('❌ Airtable test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Airtable test failed: ' + error.message
    });
  }
});

// ========== BULK ORDER STATUS UPDATE ==========

// Update multiple orders status (admin function)
app.post('/api/orders/bulk-status-update', async (req, res) => {
  try {
    const { recordIds, status, notes } = req.body;

    console.log('🔄 Bulk updating order status for', recordIds.length, 'orders');
    console.log('📊 New status:', status);

    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No record IDs provided'
      });
    }

    const validStatuses = ['Processing', 'Shipped', 'Delivered', 'Cancelled', 'Refunded', 'On Hold'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const records = recordIds.map(recordId => ({
      id: recordId,
      fields: {
        'Order Status': status,
        'Status Updated': new Date().toISOString(),
        ...(notes && { 'Status Notes': notes })
      }
    }));

    const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Sales`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Airtable API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    res.json({
      success: true,
      message: `Updated ${result.records.length} orders to ${status}`,
      updatedCount: result.records.length
    });

  } catch (error) {
    console.error('❌ Bulk status update error:', error);
    res.status(500).json({
      success: false,
      error: 'Bulk status update failed: ' + error.message
    });
  }
});

// ========== ORDER STATUS WEBHOOK (for automation) ==========

// Webhook for automated status updates (optional)
app.post('/api/webhooks/order-status', async (req, res) => {
  try {
    const { recordId, event, data } = req.body;
    
    console.log('🤖 Order status webhook triggered:', { recordId, event });

    // You can implement automated status updates here
    // For example:
    // - Auto-update to "Processing" after 1 hour
    // - Integration with shipping carriers
    // - Inventory management updates

    res.json({
      success: true,
      message: 'Webhook processed successfully'
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({
      success: false,
      error: 'Webhook processing failed'
    });
  }
});

// ========== STAFF MANAGEMENT ENDPOINTS ==========

// Get available staff members
app.get('/api/staff', (req, res) => {
  try {
    console.log('👥 Fetching staff members...');
    
    // In a real application, this would come from your database
    // For now, we'll return a static list
    const staffMembers = [
      { id: 'john', name: 'John Doe', email: 'john@nepalgoods.com', role: 'Manager' },
      { id: 'jane', name: 'Jane Smith', email: 'jane@nepalgoods.com', role: 'Processor' },
      { id: 'mike', name: 'Mike Johnson', email: 'mike@nepalgoods.com', role: 'Shipper' },
      { id: 'sarah', name: 'Sarah Wilson', email: 'sarah@nepalgoods.com', role: 'Processor' },
      { id: 'david', name: 'David Brown', email: 'david@nepalgoods.com', role: 'Shipper' }
    ];

    res.json({
      success: true,
      staff: staffMembers
    });
    
  } catch (error) {
    console.error('❌ Error fetching staff:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch staff members'
    });
  }
});

// ========== ERROR HANDLING ==========

// 404 handler - MUST BE AFTER ALL ROUTES
app.use('*', (req, res) => {
  console.log('❌ 404 - Endpoint not found:', req.originalUrl);
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    availableEndpoints: {
      products: 'GET /api/products',
      createPayment: 'POST /api/create-payment-intent',
      createOrder: 'POST /api/orders',
      updateStatus: 'PATCH /api/orders/:recordId/status',
      workstation: 'GET /api/orders/workstation',
      testAirtable: 'GET /api/test-airtable',
      staff: 'GET /api/staff'
    }
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('💥 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// ========== SERVER STARTUP ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
🚀 NepalGoods Backend Server Started!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔐 Services: ${process.env.STRIPE_SECRET_KEY ? '✓ Stripe' : '✗ Stripe'} ${process.env.AIRTABLE_TOKEN ? '✓ Airtable' : '✗ Airtable'}
📊 Order Status System: Active
👤 Staff Assignment: Enabled
📦 Tracking Numbers: Supported
✅ Available Statuses: Paid, Processing, Shipped, Delivered, Cancelled, Refunded, On Hold, Awaiting Information
✅ Ready to accept requests...
  `);
  
  // Log environment status
  console.log(`
📋 Environment Check:
  - Airtable Base: ${process.env.AIRTABLE_BASE_ID ? '✓ Configured' : '✗ Missing'}
  - Airtable Token: ${process.env.AIRTABLE_TOKEN ? '✓ Configured' : '✗ Missing'}
  - Stripe Secret: ${process.env.STRIPE_SECRET_KEY ? '✓ Configured' : '✗ Missing'}
  `);
});
