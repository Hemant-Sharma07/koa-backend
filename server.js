const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = require('etc/secrets/firebase-service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // Optional: Add your Firebase project config
});

const db = admin.firestore();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Create Order API
app.post('/api/create-order', async (req, res) => {
  try {
    const {
      userId,
      userEmail,
      items,
      totalAmount,
      userDetails,
      amount // Amount in paise
    } = req.body;

    // console.log(req.body)

    // Validate required fields
    if (!userId || !userEmail || !items || !totalAmount || !userDetails || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // 1. Create Razorpay order
    const razorpayOrderOptions = {
      amount: amount, // Amount in paise
      currency: 'INR',
      receipt: `${userId}`,
      notes: {
        userId: userId,
        userEmail: userEmail
      }
    };

    // console.log(razorpayOrderOptions)

    const razorpayOrder = await razorpay.orders.create(razorpayOrderOptions);

    // console.log(razorpayOrder)

    // 2. Create Firebase order document
    const firebaseOrderData = {
      userId,
      userEmail,
      items,
      totalAmount,
      userDetails,
      paymentMethod: 'razorpay',
      razorpayOrderId: razorpayOrder.id,
      razorpayPaymentId: null,
      razorpaySignature: null,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };


    const firebaseOrderRef = await db.collection('orders').add(firebaseOrderData);

    // console.log(firebaseOrderRef)


    // 3. Return both IDs to client
    res.json({
      success: true,
      razorpayOrderId: razorpayOrder.id,
      firebaseOrderId: firebaseOrderRef.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Verify Payment API
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      firebaseOrderId
    } = req.body;

    // Create signature for verification
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'your_razorpay_secret_here')
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      // Update Firebase order with payment details
      await db.collection('orders').doc(firebaseOrderId).update({
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message: 'Payment verified successfully'
      });
    } else {
      // Update order status to failed
      await db.collection('orders').doc(firebaseOrderId).update({
        status: 'failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.status(400).json({
        success: false,
        message: 'Payment verification failed'
      });
    }

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update Order Status API
app.post('/api/update-order-status', async (req, res) => {
  try {
    const { firebaseOrderId, status, paymentDetails } = req.body;

    const updateData = {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Add payment details if provided
    if (paymentDetails) {
      Object.assign(updateData, paymentDetails);
    }

    await db.collection('orders').doc(firebaseOrderId).update(updateData);

    res.json({
      success: true,
      message: 'Order status updated successfully'
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get Order Details API
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const orderDoc = await db.collection('orders').doc(orderId).get();

    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    res.json({
      success: true,
      order: {
        id: orderDoc.id,
        ...orderDoc.data()
      }
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get User Orders API
app.get('/api/orders/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const ordersSnapshot = await db
      .collection('orders')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    const orders = [];
    ordersSnapshot.forEach(doc => {
      orders.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;